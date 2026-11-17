/**
 * 文字识别(OCR)接入。门户只依赖 OcrProvider 这个接口,换识别服务(以后换成自己的 GPU 服务)只需要再写一个实现。
 * 现在内置 OCR.space(有免费额度)。图片会被发送到第三方,界面上有明确提示。
 */
import sharp from 'sharp'

export type OcrErrorCode = 'RATE_LIMIT' | 'AUTH' | 'TOO_BIG' | 'TIMEOUT' | 'NETWORK' | 'UPSTREAM' | 'NO_TEXT'
export class OcrError extends Error {
  constructor(public code: OcrErrorCode, message: string, public retryable = false) {
    super(message)
    this.name = 'OcrError'
  }
}
/** 用名字判断而不是 instanceof: 同一个模块被不同路径加载成两份时 instanceof 会失灵。 */
export const isOcrError = (e: unknown): e is OcrError => e instanceof OcrError || (e instanceof Error && e.name === 'OcrError')

import type { OcrBox } from '../../shared/types'

export interface OcrResult { text: string; ms: number; provider: string; /** 文字框(可选;占整张图的比例)。 */ boxes?: OcrBox[] }

/**
 * 把 OCR.space 的 TextOverlay(像素坐标)换算成占整张图的比例。宽高是发送给识别服务的那张图的尺寸。
 * 超出图片范围或形状不对的框直接丢掉,免得审核页上出现飘在图外的框。
 */
export function overlayToBoxes(overlay: unknown, width: number, height: number): OcrBox[] {
  if (!width || !height) return []
  const lines = (overlay as { Lines?: { Words?: unknown[] }[] } | null | undefined)?.Lines
  if (!Array.isArray(lines)) return []
  const out: OcrBox[] = []
  const r4 = (n: number) => Math.round(n * 10000) / 10000
  for (const l of lines) {
    for (const w of Array.isArray(l?.Words) ? l.Words : []) {
      const o = w as { WordText?: unknown; Left?: unknown; Top?: unknown; Width?: unknown; Height?: unknown }
      const t = typeof o.WordText === 'string' ? o.WordText.trim() : ''
      const [x, y, bw, bh] = [o.Left, o.Top, o.Width, o.Height].map(Number)
      if (!t || ![x, y, bw, bh].every(Number.isFinite) || bw! <= 0 || bh! <= 0) continue
      if (x! < 0 || y! < 0 || x! + bw! > width * 1.02 || y! + bh! > height * 1.02) continue
      out.push({ t: t.slice(0, 60), x: r4(x! / width), y: r4(y! / height), w: r4(Math.min(bw!, width - x!) / width), h: r4(Math.min(bh!, height - y!) / height) })
      if (out.length >= 1500) return out
    }
  }
  return out
}

/**
 * 结构化识别服务(多模态模型直接从图片读出字段)的原始输出。字段合不合理由 structured.ts 检查和分流,这里不做判断。
 * 键名是各识别服务自己的提示词里约定的(见 minicpm.ts)。
 */
export interface StructuredOutput {
  /** 各次提问得到的 JSON 合并后的字段;读不出的为 null。 */
  fields: Record<string, unknown>
  /** 商品明细(每项是 {description, quantity, unit_price, amount} 一类的对象,字段名由服务约定)。 */
  items: unknown[]
  /** 整页文字(可选: 多一次调用才有),放进审核页的"识别出的原始文字"。没有就是空串。 */
  text: string
  /** 哪些提问没有得到可解析的 JSON(用来提示"这张只读到了一部分")。 */
  failed: string[]
  /** 模型对每个提问的原始回答(已截断)。放进审核页的"原始文字",模型读到的一切审核员都能看到,包括门户没有对应字段的内容。 */
  answers?: { name: string; raw: string }[]
  /** 分类模式下模型读到的整份文档信息(类型、证据、对方、表头、标题、关键词 …,MODEL_DOC_SCHEMA 的形状,不可信,由 classify.ts 处理)。没开分类就没有。 */
  doc?: Record<string, unknown>
  /** 各阶段耗时(秒): core / extra / items / text / total。审核页和扫描列表会显示,用来了解识别速度。 */
  timing?: Record<string, number>
  ms: number
  provider: string
}

export interface OcrProvider {
  name: string
  /** 单张图片允许的最大字节数(OCR.space 免费版 1MB)。 */
  maxBytes: number
  recognize(image: Uint8Array, filename: string): Promise<OcrResult>
  /** 有这个方法就优先用(模型直接读字段);没有就退回 recognize + 规则提取。 */
  extract?(image: Uint8Array, filename: string): Promise<StructuredOutput>
  /** 识别服务在本机或内网: 图片不会离开内网,界面据此不再提示"发送给第三方"。 */
  local?: boolean
  /** 同时在途的最多请求数,默认 2。单卡单路的模型服务设 1,免得请求在对方排队超时。 */
  concurrency?: number
  /** 验证器(Jev): 对"图片 + 整页转写"打一个分,衡量转写和图片是否一致。失败返回 null,绝不影响扫描本身。 */
  verify?(image: Uint8Array, transcript: string): Promise<JevScore | null>
  /** 第二个读取模型(GLM-OCR): 对同一张图再读一遍(表头、次要字段、商品行、整页转写)。没配第二个模型或全部失败返回 null,绝不抛错影响扫描。 */
  readSecond?(image: Uint8Array): Promise<StructuredOutput | null>
  /** 识别服务是否在分类模式(一次调用同时判断单据类型);/v2/health 据此告诉调用方。 */
  classify?: boolean
  /** 什么时候调用验证器: off 不用;flagged 只对初判不是「基本可信」的(省时间);all 每张都打(用来标定阈值)。 */
  jevMode?: JevMode
}

export type JevMode = 'off' | 'flagged' | 'all'
/** verdict 不是 "scored" 时 score 无意义(0.0 / -1.0 是固定的失败值,不是低分),必须先看 verdict。 */
export interface JevScore { score: number | null; verdict: string }

// ---------------------------------------------------------------- 发送前处理: 超过上限就缩小重新压缩
/**
 * 图片超过服务商上限(或边长过大)时缩小并转成 JPEG。收据是黑白小字,缩到长边 2400 像素对识别影响很小,
 * 先试较高画质,逐步降低直到小于上限。已经够小的原图原样发送,不做任何改动。
 */
export async function prepareImage(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const limit = Math.floor(maxBytes * 0.94)
  if (bytes.length <= limit) return bytes
  const base = sharp(Buffer.from(bytes), { failOn: 'none' }).rotate() // 按 EXIF 方向转正
  for (const [edge, quality] of [[2600, 86], [2200, 82], [1800, 78], [1500, 72], [1200, 66]] as const) {
    const out = await base.clone().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer()
    if (out.length <= limit) return new Uint8Array(out)
  }
  throw new OcrError('TOO_BIG', 'image too big even after resizing')
}

// ---------------------------------------------------------------- OCR.space
interface OcrSpaceBody { OCRExitCode?: number; IsErroredOnProcessing?: boolean; ErrorMessage?: string[] | string; ParsedResults?: { ParsedText?: string; TextOverlay?: unknown }[] }
export interface OcrSpaceOptions { apiKey: string; engine?: '1' | '2' | '3'; timeoutMs?: number; fetchImpl?: typeof fetch; endpoint?: string }

export function ocrSpaceProvider(opts: OcrSpaceOptions): OcrProvider {
  const f = opts.fetchImpl ?? fetch
  const endpoint = opts.endpoint ?? 'https://api.ocr.space/parse/image'
  return {
    name: 'ocr.space',
    maxBytes: 1024 * 1024,
    async recognize(image, filename) {
      const t0 = performance.now()
      const form = new FormData()
      form.set('apikey', opts.apiKey)
      form.set('language', 'eng')
      form.set('OCREngine', opts.engine ?? '2')
      form.set('isTable', 'true') // 表格模式: 保留"商品 / 金额"同一行,方便提取
      form.set('scale', 'true')
      form.set('isOverlayRequired', 'true') // 要每个词的位置,审核页用它在图上画框
      form.set('file', new Blob([image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer], { type: 'image/jpeg' }), filename.replace(/[^\w.\-]/g, '_') || 'receipt.jpg')
      let res: Response
      try {
        res = await f(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
      } catch (e) {
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new OcrError('TIMEOUT', 'OCR timed out', true)
        throw new OcrError('NETWORK', e instanceof Error ? e.message : 'network error', true)
      }
      if (res.status === 403 || res.status === 429) throw new OcrError('RATE_LIMIT', `HTTP ${res.status}`, false)
      if (res.status >= 500) throw new OcrError('UPSTREAM', `HTTP ${res.status}`, true)
      let body: OcrSpaceBody
      try { body = ((await res.json()) ?? {}) as OcrSpaceBody } catch { throw new OcrError('UPSTREAM', 'bad response', true) }
      if (!res.ok || body.IsErroredOnProcessing || (body.OCRExitCode ?? 1) > 2) {
        const msg = Array.isArray(body.ErrorMessage) ? body.ErrorMessage.join('; ') : String(body.ErrorMessage ?? `HTTP ${res.status}`)
        if (/limit|quota|too many|exceed/i.test(msg)) throw new OcrError('RATE_LIMIT', msg, false)
        if (/api\s*key|invalid\s*key|unauthor/i.test(msg)) throw new OcrError('AUTH', msg, false)
        if (/size|large|1024|1 ?mb/i.test(msg)) throw new OcrError('TOO_BIG', msg, false)
        throw new OcrError('UPSTREAM', msg, true)
      }
      const text = (body.ParsedResults ?? []).map((r) => r.ParsedText ?? '').join('\n').trim()
      if (!text) throw new OcrError('NO_TEXT', 'no text recognised', false)
      let boxes: OcrBox[] = []
      try {
        const meta = await sharp(Buffer.from(image), { failOn: 'none' }).metadata()
        const swap = (meta.orientation ?? 1) >= 5 // 按 EXIF 方向转正之后宽高互换
        boxes = overlayToBoxes(body.ParsedResults?.[0]?.TextOverlay, (swap ? meta.height : meta.width) ?? 0, (swap ? meta.width : meta.height) ?? 0)
      } catch { /* 读不出尺寸就不画框,不影响识别结果 */ }
      return { text, ms: Math.round(performance.now() - t0), provider: 'ocr.space', boxes }
    },
  }
}

/** 临时性错误(网络、超时、服务端 5xx)自动重试,限流/密钥/图片问题不重试。 */
export async function retrying<T>(fn: () => Promise<T>, tries = 3, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isOcrError(e) || !e.retryable || i === tries - 1) throw e
      await sleep(800 * 2 ** i)
    }
  }
  throw lastErr
}

/** 实现了结构化识别(extract)的识别服务。 */
export type StructuredProvider = OcrProvider & { extract: NonNullable<OcrProvider['extract']> }
export const hasExtract = (p: OcrProvider): p is StructuredProvider => typeof p.extract === 'function'

type Sleep = (ms: number) => Promise<unknown>
export const recognizeWithRetry = (p: OcrProvider, image: Uint8Array, filename: string, tries = 3, sleep?: Sleep): Promise<OcrResult> =>
  retrying(() => p.recognize(image, filename), tries, sleep)
/** 一次 extract 要问模型好几次,所以默认只重试 1 次(共 2 轮),免得一张图把等待时间拉得太长。 */
export const extractWithRetry = (p: StructuredProvider, image: Uint8Array, filename: string, tries = 2, sleep?: Sleep): Promise<StructuredOutput> =>
  retrying(() => p.extract(image, filename), tries, sleep)
