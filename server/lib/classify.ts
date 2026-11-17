/**
 * 分类后处理: 把模型读到的「分类 + 内容」(MODEL_DOC_SCHEMA 的形状)变成入库用的 StoredDoc,并决定要不要强制转人工。
 * 模型只负责「读到什么」;类型是否可信、方向、商家(对方)、AutoCount 映射、要不要放行,全部由这里的确定性规则决定
 * (IMPLEMENTATION-PLAN D2 / D4 / D5 / D10)。
 *
 * 状态方向别搞反: 在这个系统里 AUTO 比 AUTO_VERIFIED 更可信。「没验证过的类型不能自动放行」意思是降到 REVIEW(需检查),不是升到 AUTO。
 */
import { PAYMENT_METHODS, emptyDoc, type DocAlternative, type DocParty, type StoredDoc } from '../../shared/doc'
import type { PipelineStatus } from '../../shared/types'
import { DOC_TYPE_INFO, amountsRequired, defaultDirectionOf, isDocLanguage, isDocType, specificType, type Direction, type DocType, type TypeVerdict } from '../../shared/doctypes'
import { cleanDoc } from './doc'
import { dateSanity, evidenceCheck, idIssues, isWalkInName, partyKey, sanitizeKeywords, sanitizeTitle } from './docchecks'
import { DOC_PROMPT_VERSION } from './docPrompt'
import { isUs, type OurCompany } from './ourCompany'

/**
 * 全局开关(index.ts 按环境变量设置;评测 / 测试可以直接改):
 *   trusted        分类结果被信任到「可以自动放行」的类型。默认只有收据 —— 其余类型没有真实样本验证过,一律转人工(D10);
 *   minConfidence  把握度低于它 → 转人工;altGap 第一候选和第二候选的把握度差小于它 → 转人工。阈值是占位值,要用真实样本标定。
 */
export const classifyOpts: { trusted: Set<DocType>; minConfidence: number; altGap: number } = { trusted: new Set<DocType>(['receipt']), minConfidence: 0.8, altGap: 0.2 }

export interface ClassifyOptions {
  our?: OurCompany | null
  /** 调用方明确指定了类型(/v2/scan 的 hint_type)。以它为准,不再用模型的把握度 / 证据判断;模型自己的判断留作候选。仍然经过信任类型、日期 / 证件号、冲突检查。 */
  hintType?: DocType
  trusted?: ReadonlySet<DocType>
  minConfidence?: number
  altGap?: number
  now?: Date
}

export interface ClassifyResult {
  doc: StoredDoc
  /** 最终类型(发票会按方向落成 sales_invoice / purchase_invoice)。 */
  type: DocType
  direction: Direction
  /** 旧列 merchant 该填的「对方」(D2): 销售类 = 客户,其余 = 开单方 / 商家。 */
  merchant: string | null
  /** 追加到收据 reasons 里的原因代码。 */
  reasons: string[]
  /** true = 不管金额对不对得上,这张都不能自动放行。 */
  forceReview: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** 宽松取字符串: 字符串、数字都接受(没有强制 Schema 时模型会返回 null 或数字),null / 别的类型当没有。 */
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const nul = (v: unknown): string | null => str(v) || null
const isoDate = (v: unknown): string | null => {
  const s = str(v)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null
}
const num01 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null)

function partyOf(v: unknown): DocParty | null {
  if (!isObj(v)) return null
  const name = nul(v.name)
  const p: DocParty = {
    name_as_printed: name, name_normalized: name ? partyKey(name) || null : null,
    reg_no: nul(v.reg_no), tax_id: nul(v.tax_id), address: nul(v.address), phone: nul(v.phone), email: nul(v.email),
  }
  return Object.values(p).some((x) => x !== null) ? p : null
}

const DIRECTION_DEPENDENT: ReadonlySet<DocType> = new Set<DocType>(['invoice', 'credit_note', 'delivery_order'])

export function classifyDocument(model: Record<string, unknown>, transcript: string, opts: ClassifyOptions = {}): ClassifyResult {
  const our = opts.our ?? null
  const trusted = opts.trusted ?? classifyOpts.trusted
  const minConf = opts.minConfidence ?? classifyOpts.minConfidence
  const altGap = opts.altGap ?? classifyOpts.altGap
  const now = opts.now ?? new Date()
  const reasons: string[] = []

  // ---- 类型、把握度、候选
  const hint = opts.hintType ?? null
  const modelKind: DocType = isDocType(model.document_type) ? model.document_type : 'other'
  const kind: DocType = hint ?? modelKind
  const conf = hint ? 1 : num01(model.confidence) // 调用方指定的类型不是模型推断的,把握度记 1
  const alternatives: DocAlternative[] = []
  if (Array.isArray(model.alternatives)) {
    for (const a of model.alternatives) {
      if (alternatives.length >= 2) break
      if (isObj(a) && isDocType(a.document_type) && a.document_type !== kind) {
        const c = num01(a.confidence)
        if (c !== null) alternatives.push({ document_type: a.document_type, confidence: c })
      }
    }
  }

  // ---- 证据必须是图上真有的字(D5): 在转写里找得到才算
  const claimed = Array.isArray(model.evidence) ? model.evidence.map(str).filter(Boolean).slice(0, 5) : []
  const ev = evidenceCheck(claimed, transcript)
  const evidenceMissing = !hint && ev.checked && kind !== 'other' && ev.found.length === 0

  // ---- 对方: 付款方式被读成客户名(CASH)→ 当成没有客户
  const issuer = partyOf(model.issuer)
  let counterparty = partyOf(model.counterparty)
  if (counterparty && isWalkInName(counterparty.name_as_printed) && !counterparty.reg_no && !counterparty.tax_id) counterparty = null

  // ---- 方向(D4): 只有配置了「我方身份」才能判断;没配置时只有收据这类天然只有一个方向的类型有默认方向
  const issuerUs = isUs(issuer, our)
  const counterpartyUs = isUs(counterparty, our)
  const derived: Direction | null = our && issuerUs && !counterpartyUs ? 'sales' : our && counterpartyUs && !issuerUs ? 'purchase' : null
  let direction: Direction = derived ?? defaultDirectionOf(kind)
  // 调用方明确指定了「销售发票 / 采购发票」: 方向跟着类型走;如果和「我方身份」判出来的方向矛盾,按指定的走,但转人工
  const intended: Direction | null = hint === 'sales_invoice' ? 'sales' : hint === 'purchase_invoice' ? 'purchase' : null
  const hintConflict = intended !== null && derived !== null && derived !== intended
  if (intended) direction = intended
  const type = specificType(kind, direction)
  const info = DOC_TYPE_INFO[type]
  // 调用方的类型和模型自己的判断不一样: 模型的判断留作第一候选,并记一条提示
  const hintDiffers = hint !== null && specificType(modelKind, direction) !== type
  if (hintDiffers) { alternatives.splice(0, 0, { document_type: modelKind, confidence: num01(model.confidence) ?? 0 }); alternatives.length = Math.min(alternatives.length, 2) }

  // ---- 旧列 merchant = 「对方」(D2)
  const other = direction === 'sales' ? counterparty : issuer
  const merchant = other?.name_as_printed ?? issuer?.name_as_printed ?? counterparty?.name_as_printed ?? null

  // ---- 表头、付款、关联单据
  const docNo = nul(model.doc_no)
  const docDate = isoDate(model.doc_date)
  const pm = str(model.payment_method)
  const last4 = str(model.card_last4)
  const header = {
    doc_no: docNo, due_date: isoDate(model.due_date), valid_until: isoDate(model.valid_until), reference: nul(model.reference),
    customer_po_no: nul(model.customer_po_no), terms: nul(model.terms), supplier_invoice_no: nul(model.supplier_invoice_no), delivery_address: nul(model.delivery_address),
  }
  const payment = {
    method: (PAYMENT_METHODS as readonly string[]).includes(pm) ? (pm as StoredDoc['payment']['method']) : null,
    reference: nul(model.payment_reference), card_last4: /^\d{4}$/.test(last4) ? last4 : null,
  }
  const relations = {
    original_invoice_no: nul(model.original_invoice_no), related_po_no: nul(model.related_po_no), related_so_no: nul(model.related_so_no),
    related_do_no: nul(model.related_do_no), reason: nul(model.reason),
  }

  // ---- 标题和关键词: 去掉金额 / 电话 / 邮箱 / 长数字 / 证件号
  const fallbackTitle = [merchant, info.en, docNo ?? docDate].filter(Boolean).join(' ')
  const title = sanitizeTitle(str(model.title), fallbackTitle)
  const keywords = sanitizeKeywords(Array.isArray(model.keywords) ? model.keywords.map(str) : [], {
    forbidden: [issuer?.tax_id, issuer?.reg_no, counterparty?.tax_id, counterparty?.reg_no], docNo,
  })

  // ---- 类型和内容矛盾: 订单 / 报价 / 送货单 / 贷项上不该有「实付 / 找零」
  const conflict = hintConflict || (info.needs.payment === 'none' && !!(str(model.amount_paid) || str(model.change_given)))

  // ---- 日期 / 证件号的确定性检查
  const dateReasons = dateSanity(docDate, transcript, now)
  const idSuspect = idIssues(issuer).length + idIssues(counterparty).length > 0

  // ---- 判定。优先级: 证据缺失 > 矛盾 > 把握度低 > 方向未定 > 没验证过 > 可信
  const lowConf = !hint && (kind === 'other' || conf === null || conf < minConf || (alternatives[0] !== undefined && conf - alternatives[0].confidence < altGap))
  const dirUnknown = DIRECTION_DEPENDENT.has(kind) && direction === 'unknown'
  const isTrusted = trusted.has(type)
  let verdict: TypeVerdict
  if (evidenceMissing) verdict = 'evidence_missing'
  else if (conflict) verdict = 'conflict'
  else if (lowConf) verdict = 'low_confidence'
  else if (dirUnknown) verdict = 'direction_unknown'
  else if (!ev.checked || !isTrusted) verdict = 'unverified'
  else verdict = 'ok'

  if (hint) reasons.push('type_hinted') // 类型是调用方指定的,不是模型判断的
  if (hintDiffers) reasons.push('type_hint_differs')
  if (evidenceMissing) reasons.push('type_evidence_missing')
  if (conflict) reasons.push('type_conflict')
  if (lowConf) reasons.push('type_low_confidence')
  if (dirUnknown) reasons.push('direction_unknown')
  if (!isTrusted && kind !== 'other') reasons.push('type_unverified')
  if (!ev.checked) reasons.push('type_unchecked') // 没有整页转写,证据没法核对(只是提示)
  reasons.push(...dateReasons)
  if (idSuspect) reasons.push('id_format_suspect')

  const forceReview = evidenceMissing || conflict || lowConf || !isTrusted || dateReasons.length > 0 || (idSuspect && kind !== 'receipt')

  const doc = cleanDoc({
    prompt_version: DOC_PROMPT_VERSION,
    classification: { document_type: type, confidence: conf, alternatives, evidence: ev.found, title_printed: nul(model.title_printed), type_verdict: verdict },
    direction,
    title,
    keywords,
    language: isDocLanguage(model.language) ? model.language : null,
    header,
    parties: { issuer, counterparty },
    payment,
    relations,
  }) ?? emptyDoc()

  return { doc, type, direction, merchant, reasons, forceReview }
}

/**
 * 把分类结果合进收据的初判(状态 + 原因代码):
 *   - 这个类型不要求总额(送货单 / 订单 / 报价单 / other)→ 去掉「缺总额」;
 *   - forceReview 时,原本「基本可信」的降成「需检查」(没有验证过的类型、把握度低、证据对不上、类型矛盾、日期 / 证件号存疑)。
 * 只会让结果更谨慎,从不会让它更「可信」。
 */
export function applyClassification<T extends { status: PipelineStatus; reasons: string[] }>(ex: T, cls: ClassifyResult): T {
  let reasons = [...ex.reasons, ...cls.reasons]
  if (!amountsRequired(cls.type)) reasons = reasons.filter((r) => r !== 'missing_total')
  const trustedStatus = ex.status === 'AUTO_VERIFIED' || ex.status === 'AUTO'
  return { ...ex, reasons: [...new Set(reasons)], status: cls.forceReview && trustedStatus ? 'REVIEW' : ex.status }
}
