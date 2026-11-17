import type { Database } from 'bun:sqlite'
import type { ScanOutcome } from '../../shared/types'
import { isDirection, isDocType, type DocType } from '../../shared/doctypes'
import { nowLocal } from '../db'
import { aliasResolver, knownMerchants } from './aliases'
import { maybeEnqueue, secondOpts } from './second'
import { hybridMerge, hybridOpts } from './hybrid'
import { applyClassification, classifyDocument, type ClassifyResult } from './classify'
import { HttpError } from './errors'
import { extractFromText } from './extract'
import { ingest } from './importer'
import { ourCompanyOpts } from './ourCompany'
import { extractWithRetry, hasExtract, isOcrError, prepareImage, recognizeWithRetry, type OcrProvider } from './ocr'
import { applyJev, fromStructured, JEV_DEFAULT_THRESHOLD, type StructuredExtraction } from './structured'

/** Jev 的阈值和是否据此降级,由启动时的环境变量设置(server/index.ts)。默认只提示,不改状态。 */
export const jevOpts: { threshold: number; demote: boolean } = { threshold: JEV_DEFAULT_THRESHOLD, demote: false }

const EXT_OK = /\.(jpe?g|png|webp|gif)$/i

/** 同时最多几个识别请求在途(免费接口有频率限制,也避免一次扫几百张把服务拖垮)。 */
export function limiter(n: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r))
    active++
    try { return await fn() } finally { active--; waiting.shift()?.() }
  }
}

const ERROR_MAP: Record<string, [number, string]> = {
  RATE_LIMIT: [429, 'SCAN_RATE_LIMIT'], AUTH: [502, 'SCAN_AUTH'], TOO_BIG: [413, 'SCAN_TOO_BIG'], TIMEOUT: [504, 'SCAN_TIMEOUT'], NETWORK: [502, 'SCAN_NETWORK'], UPSTREAM: [502, 'SCAN_UPSTREAM'],
}

/**
 * 扫描一张图片: 识别文字 → 提取字段 → 对账分流 → 入库(进入待审核队列)。
 * 先按图片内容查重: 已经有的不再调用识别服务(省免费额度)。识别不出文字也会入库(留空让员工手填),图片不会丢。
 */
export async function scanImage(db: Database, dataDir: string, provider: OcrProvider, bytes: Uint8Array, filename: string, batch = `scan ${nowLocal()}`, opts: { hintType?: DocType } = {}): Promise<ScanOutcome> {
  if (!EXT_OK.test(filename)) throw new HttpError(400, 'IMAGE_UNSUPPORTED', { name: filename })
  const hash = new Bun.CryptoHasher('sha1').update(bytes).digest('hex')
  type Row = { id: number; pipeline_status: string; merchant: string | null; total: number | null; currency: string | null; document_type: string | null; direction: string | null; title: string | null }
  const find = () => db.query<Row, [string]>('SELECT id, pipeline_status, merchant, total, currency, document_type, direction, title FROM receipts WHERE img_hash = ?').get(hash)
  const dup = find()
  if (dup) return { file: filename, id: dup.id, duplicate: true, status: dup.pipeline_status as ScanOutcome['status'], reasons: [], ms: 0, merchant: dup.merchant, total: dup.total, currency: dup.currency, documentType: isDocType(dup.document_type) ? dup.document_type : null, direction: isDirection(dup.direction) ? dup.direction : null, title: dup.title }

  let text = ''
  let ms = 0
  let boxes: unknown[] = []
  let structured: StructuredExtraction | null = null // 识别服务直接读出了字段(多模态模型)时,不再从文字里用规则猜
  let cls: ClassifyResult | null = null // 分类模式: 模型同时给出了单据类型 / 对方 / 标题 / 关键词
  try {
    const prepared = await prepareImage(bytes, provider.maxBytes)
    if (hasExtract(provider)) {
      const o0 = await extractWithRetry(provider, prepared, filename)
      // 分类后处理(classify.ts): 类型 / 方向 / 对方 / 标题 / 关键词。旧列 merchant 要的是「对方」(销售类 = 客户),所以先换好再规整
      cls = o0.doc ? classifyDocument(o0.doc, o0.text ?? '', { our: ourCompanyOpts.company, hintType: opts.hintType }) : null
      const o1 = cls?.merchant ? { ...o0, fields: { ...o0.fields, merchant_name: cls.merchant } } : o0
      // 混合读法(可选): 明细字段用 Qwen 从 MiniCPM 的整页转写里抽,总额 / 日期和原生读数对照。Qwen 不可用就原样用原生读数。
      const hy = hybridOpts.enabled && o1.text?.trim() ? await hybridMerge(o1, secondOpts.qwen) : null
      const o = hy?.out ?? o1
      structured = fromStructured(o, { aliasOf: aliasResolver(db), isKnown: knownMerchants(db) })
      if (cls) structured = applyClassification(structured, cls) // 没验证过的类型 / 把握度低 / 证据对不上 → 不能自动放行
      if (hy?.used) {
        structured.reasons.push('detail_from_qwen')
        if (hy.disagree.length) {
          // 两个读者对总额 / 日期读得不一样: 保留原生的值给审核员看,但不能当「基本可信」放行
          structured.reasons.push(`reader_disagree:${hy.disagree.join(',')}`)
          if (structured.status === 'AUTO_VERIFIED' || structured.status === 'AUTO') structured.status = 'REVIEW'
        }
      }
      text = structured.ocrText // 审核页的"原始文字": 整页转写 + 模型对每个提问的原始回答
      ms = o.ms
      // 验证器(Jev,可选): 只对需要的收据打分;失败不影响扫描。打分用的是整页转写,没有转写就不打
      const mode = provider.jevMode ?? 'off'
      const trusted = structured.status === 'AUTO_VERIFIED' || structured.status === 'AUTO'
      if (provider.verify && mode !== 'off' && o.text.trim() && (mode === 'all' || !trusted)) {
        const t0 = performance.now()
        const jev = await provider.verify(prepared, o.text)
        if (jev) {
          structured = applyJev(structured, jev, jevOpts)
          if (structured.timing) structured.timing = { ...structured.timing, jev: Math.round((performance.now() - t0) / 10) / 100 }
          ms += Math.round(performance.now() - t0)
        }
      }
    } else {
      const r = await recognizeWithRetry(provider, prepared, filename)
      text = r.text
      ms = r.ms
      boxes = r.boxes ?? []
    }
  } catch (e) {
    if (isOcrError(e) && e.code !== 'NO_TEXT') {
      // 界面上只显示一句通用提示;真正的原因(HTTP 状态、服务端说明)写到服务器日志,方便排查
      console.warn(`[scan] ${filename} 识别服务出错 ${e.code}: ${e.message}`)
      const [status, code] = ERROR_MAP[e.code] ?? [502, 'SCAN_UPSTREAM']
      throw new HttpError(status, code)
    }
    if (!isOcrError(e)) throw e
    // NO_TEXT: 图片里识别不出文字(太糊、不是收据)。照样入库,让员工看图手填。
    console.warn(`[scan] ${filename} 没有识别出内容: ${e.message}`)
  }

  const ex = structured ?? (text ? extractFromText(text) : null)
  const extra = structured
    ? { timing: structured.timing ?? undefined, verifier_saw: structured.verifier?.saw ?? undefined, verifier_agree: structured.verifier?.agree ?? undefined, verifier_jev: structured.verifier?.jev ?? undefined, corrections: structured.corrections }
    : {}
  const result = ex
    ? { file: filename, status: ex.status, reasons: ex.reasons, data: ex.data, regex_total: ex.regexTotal, ocr_text: text, boxes, ...(cls ? { doc: cls.doc } : {}), ...extra }
    : { file: filename, status: 'REVIEW', reasons: ['scanned_in_portal', 'extract_failed'], data: null, ocr_text: '' }
  // 批次名里带上识别服务的名字,以后在「操作记录」和审核页都能看出这批是谁识别的(OCR.space 还是 MiniCPM)
  const res = ingest(db, dataDir, [result], () => bytes, `${batch} · ${provider.name}`)
  if (res.failed) throw new HttpError(500, 'SERVER_ERROR')
  const row = find()
  // 第二意见(按需升级): 第一轮不是「基本可信」的收据,放进后台队列让第二个读取模型 + 验证器 + 文字仲裁处理;这里立即返回,不等
  if (structured) maybeEnqueue(row?.id, row?.pipeline_status ?? 'REVIEW')
  return {
    file: filename, id: row?.id ?? null, duplicate: false, status: (row?.pipeline_status ?? 'REVIEW') as ScanOutcome['status'], reasons: result.reasons, ms,
    merchant: row?.merchant ?? null, total: row?.total ?? null, currency: row?.currency ?? null, items: ex?.data.items.length ?? 0,
    documentType: cls?.type ?? null, direction: cls?.direction ?? null, title: cls?.doc.title ?? null,
  }
}
