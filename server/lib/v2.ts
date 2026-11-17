/**
 * 对外 API v2(单据分类版)的处理函数。路由在 app.ts(口令走 Authorization: Bearer,和 /v1 同一套),这里只放和 HTTP 无关的逻辑,方便测试。
 * /v1 完全不动: v2 是新增的,已经在联调的调用方不受影响。
 */
import type { Database } from 'bun:sqlite'
import { PAYMENT_METHODS } from '../../shared/doc'
import { DIRECTIONS, DOC_TYPES, DOC_TYPE_INFO, MODEL_DOC_TYPES, TYPE_VERDICTS, isDirection, isDocType, type Direction, type DocType } from '../../shared/doctypes'
import { PUBLIC_V2_SCHEMA_VERSION, toPublicV2, type PublicDocumentV2 } from '../../shared/public2'
import { reconcile } from '../../shared/reconcile'
import type { PipelineStatus, ReceiptRow, ReviewState, ScanOutcome } from '../../shared/types'
import { classifyOpts } from './classify'
import { HttpError } from './errors'
import { MAX_IMG } from './importer'
import type { OcrProvider } from './ocr'
import { ourCompanyOpts } from './ourCompany'
import { getDetail, listReceipts } from './receipts'

export const V2_DEFAULT_PAGE_SIZE = 20
export const V2_MAX_PAGE_SIZE = 100

/** 一张单据的完整公开结构(含最新的人工修改)。 */
export function getPublicV2(db: Database, id: number): PublicDocumentV2 {
  const d = getDetail(db, id)
  return toPublicV2(d, reconcile({ ...d.data }))
}

/** hint_type: 没给 → undefined;给了就必须是认识的类型,否则 422。 */
export function parseHintType(raw: string | undefined): DocType | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!isDocType(raw)) throw new HttpError(422, 'TYPE_NOT_ENABLED', { type: raw.slice(0, 40) })
  return raw
}

// ---------------------------------------------------------------- 扫描结果
/** POST /v2/scan 返回的 scan 部分: 对外统一用下划线命名(内部的 ScanOutcome 是驼峰,门户界面在用,不动它)。 */
export interface PublicScanV2 {
  file: string
  id: number | null
  /** true = 这张图(按内容判断)以前传过,返回的是已有结果,没有再调用模型。 */
  duplicate: boolean
  /** 质量判定(REVIEW / PARTIAL / CORRECTED / AUTO_VERIFIED / AUTO)。 */
  status: PipelineStatus | null
  /** 原因代码(语言无关)。 */
  reasons: string[]
  /** 识别耗时(毫秒);重复的为 0。 */
  ms: number
  /** 「对方」: 销售类是客户,其余是开单方 / 商家。 */
  merchant: string | null
  total: number | null
  currency: string | null
  items: number
  document_type: DocType | null
  direction: Direction | null
  title: string | null
}

export const toScanV2 = (s: ScanOutcome): PublicScanV2 => ({
  file: s.file, id: s.id, duplicate: s.duplicate, status: s.status, reasons: s.reasons, ms: s.ms, merchant: s.merchant, total: s.total, currency: s.currency,
  items: s.items ?? 0, document_type: s.documentType ?? null, direction: s.direction ?? null, title: s.title ?? null,
})

// ---------------------------------------------------------------- 列表
export interface PublicListItemV2 {
  id: number
  file: string
  title: string | null
  /** null = 没分类过(旧数据)。 */
  document_type: DocType | null
  direction: Direction
  doc_no: string | null
  /** 「对方」: 销售类是客户,其余是开单方 / 商家。 */
  party: string | null
  doc_date: string | null
  currency: string | null
  total: number | null
  confidence: number | null
  /** 质量判定,和 GET /v2/receipts/{id} 里的 quality.verdict 一致。 */
  verdict: PipelineStatus
  /** 还没有人工确认(待审核且不是 AUTO)。 */
  needs_review: boolean
  review_state: ReviewState
  imported_at: string
}

export interface V2ListQuery { type?: string; direction?: string; state?: string; q?: string; from?: string; to?: string; page?: number; page_size?: number }
export interface V2ListResult { items: PublicListItemV2[]; total: number; page: number; page_size: number }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const STATES = new Set(['pending', 'approved', 'rejected', 'all'])

export const toListItemV2 = (r: ReceiptRow): PublicListItemV2 => ({
  id: r.id, file: r.file, title: r.title, document_type: r.documentType, direction: r.direction ?? 'unknown', doc_no: r.docNo, party: r.merchant,
  doc_date: r.date, currency: r.currency, total: r.total, confidence: r.typeConfidence, verdict: r.pipelineStatus,
  needs_review: r.state === 'pending' && r.pipelineStatus !== 'AUTO', review_state: r.state, imported_at: r.importedAt,
})

/** 校验并规整列表查询: 不认识的类型 422,其余格式问题 400(不会悄悄当成没传而返回全部数据)。 */
export function listPublicV2(db: Database, q: V2ListQuery): V2ListResult {
  if (q.type !== undefined && q.type !== 'none' && !isDocType(q.type)) throw new HttpError(422, 'TYPE_NOT_ENABLED', { type: String(q.type).slice(0, 40) })
  if (q.direction !== undefined && !isDirection(q.direction)) throw new HttpError(400, 'VALIDATION')
  if (q.state !== undefined && !STATES.has(q.state)) throw new HttpError(400, 'VALIDATION')
  for (const d of [q.from, q.to]) if (d !== undefined && !DATE.test(d)) throw new HttpError(400, 'VALIDATION')
  const page = Math.max(1, Math.trunc(q.page ?? 1))
  const pageSize = Math.min(V2_MAX_PAGE_SIZE, Math.max(1, Math.trunc(q.page_size ?? V2_DEFAULT_PAGE_SIZE)))
  const r = listReceipts(db, {
    state: (q.state as ReviewState | 'all' | undefined) ?? 'all', type: q.type as DocType | 'none' | undefined, direction: q.direction as Direction | undefined,
    q: q.q, from: q.from, to: q.to, page, pageSize, sort: 'id', dir: 'desc', // 最新的在前;按编号排,翻页稳定
  })
  return { items: r.rows.map(toListItemV2), total: r.total, page: r.page, page_size: r.pageSize }
}

// ---------------------------------------------------------------- 类型清单 / 联调
/** GET /v2/types: 调用方可以动态读取当前有哪些类型、各自的字段要求、能不能写入 AutoCount。 */
export function typesPayload() {
  return {
    schema_version: PUBLIC_V2_SCHEMA_VERSION,
    types: DOC_TYPES.map((id) => {
      const i = DOC_TYPE_INFO[id]
      const target = (t: (typeof i.autocount)['sales']) => (t ? { entity: t.entity, code: t.code, party_role: t.party, post_as: t.postAs, verified: t.verified } : null)
      return {
        id,
        label: { zh: i.zh, en: i.en },
        default_direction: i.defaultDirection,
        postable: i.postable,
        reconcile_amounts: i.reconcileAmounts,
        needs: i.needs,
        /** true = 模型直接输出这个类型;false = 由代码按方向从「发票」落成(sales_invoice / purchase_invoice)。 */
        model_outputs: (MODEL_DOC_TYPES as readonly string[]).includes(id),
        autocount: { sales: target(i.autocount.sales), purchase: target(i.autocount.purchase) },
      }
    }),
    directions: [...DIRECTIONS],
    payment_methods: [...PAYMENT_METHODS],
    type_verdicts: [...TYPE_VERDICTS],
  }
}

/** GET /v2/health: 不调用模型,不花钱。 */
export function healthPayload(ocr: OcrProvider | null | undefined) {
  return {
    ok: true,
    scan_enabled: !!ocr,
    provider: ocr?.name ?? null,
    classify_enabled: !!ocr?.classify,
    max_image_bytes: MAX_IMG,
    schema_version: PUBLIC_V2_SCHEMA_VERSION,
    our_company_configured: !!ourCompanyOpts.company,
    trusted_types: [...classifyOpts.trusted],
    min_confidence: classifyOpts.minConfidence,
  }
}
