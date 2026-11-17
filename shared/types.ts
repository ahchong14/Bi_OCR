/** 前后端共用的类型。接口两边都以这里为准。 */
import type { StoredDoc } from './doc'
import type { Direction, DocType } from './doctypes'

export type PipelineStatus = 'REVIEW' | 'PARTIAL' | 'CORRECTED' | 'AUTO_VERIFIED' | 'AUTO'
export type ReviewState = 'pending' | 'approved' | 'rejected'
export type ReviewAction = 'approve' | 'reject' | 'save' | 'reopen'

export const PIPELINE_STATUSES: PipelineStatus[] = ['REVIEW', 'PARTIAL', 'CORRECTED', 'AUTO_VERIFIED', 'AUTO']
export const PRIORITY: Record<PipelineStatus, number> = { REVIEW: 0, PARTIAL: 1, CORRECTED: 2, AUTO_VERIFIED: 3, AUTO: 4 }

export const AMOUNT_KEYS = ['subtotal', 'discount', 'service_charge', 'tax', 'tip', 'fees', 'rounding', 'total', 'paid', 'change'] as const
export type AmountKey = (typeof AMOUNT_KEYS)[number]
export type FieldKey = 'merchant' | 'date' | 'currency' | AmountKey | 'items'

export type Lang = 'zh' | 'en'

/** uom(单位,如 pcs/kg/箱)和 discount(这一行自己的折扣)只在有值时才出现,没有就不写这两个键: 旧数据和没读到的行长得一样,不会被误判成「被改过」。
 *  price 仍然是这一行印在收据上的金额,对账只看 price,折扣只是展示/导出用。
 *  taxRate(这一行适用的税率,百分比,0 表示零税率/免税)同样只在读到时才出现;所有行都有税率时,对账会按税率分组独立算出税额。 */
export interface Item { name: string; qty: number | null; price: number | null; uom?: string; discount?: number; taxRate?: number }

/** 一张收据的业务数据(机器识别的,或人工确认后的)。 */
export interface ReceiptData {
  merchant: string | null
  date: string | null // YYYY-MM-DD
  currency: string | null
  subtotal: number | null
  discount: number | null
  service_charge: number | null
  tax: number | null
  tip: number | null
  fees: number | null // 外送费、包装费等既不是税也不是服务费的额外费用
  rounding: number | null
  total: number | null
  paid: number | null // 实付(现金或刷卡金额)
  change: number | null // 找零
  items: Item[]
}

/** 列表里的一行(队列 / 数据表格共用)。 */
export interface ReceiptRow {
  id: number
  /** 第二意见的状态;没有触发为 null。 */
  secondState?: SecondState | null
  file: string
  hasImage: boolean
  batch: string | null
  importedAt: string
  pipelineStatus: PipelineStatus
  reasons: string[]
  state: ReviewState
  merchant: string | null
  date: string | null
  currency: string | null
  subtotal: number | null
  discount: number | null
  serviceCharge: number | null
  tax: number | null
  tip: number | null
  fees: number | null
  rounding: number | null
  total: number | null
  paid: number | null
  change: number | null
  itemCount: number
  editedFields: FieldKey[]
  reviewer: string | null
  reviewedAt: string | null
  note: string | null
  version: number
  /** 单据分类。documentType 为 null = 没分类过(旧数据)。direction 为 null 同理。 */
  documentType: DocType | null
  direction: Direction | null
  typeConfidence: number | null
  docNo: string | null
  title: string | null
  /** 人工改过分类 / 方向 / 标题 / 关键词。 */
  docEdited: boolean
}

export interface Correction { field: string; old: unknown; new: unknown; why: string; value?: unknown }
/** jev: 验证器(MiniCPM-OCR-Jev)给"整页转写和图片是否一致"打的分。score 为 null = 没打成(verdict 说明原因)。threshold 是当时用的阈值。 */
export interface JevInfo { score: number | null; verdict: string; threshold: number }
export interface VerifierInfo { saw: { merchant?: string; date?: string; total?: number | string; item_prices?: number[] } | null; agree: Record<string, boolean | null> | null; jev?: JevInfo | null }
export interface AuditEntry { id: number; receiptId: number | null; ts: string; user: string; action: string; detail: { changed?: string[]; note?: string; bulk?: boolean; batch?: string; pipeline_status?: string; unresolved?: string[] }; file?: string | null }

/** 第二意见的状态: 排队 / 进行中 / 完成 / 失败。null = 没有触发(第一轮就基本可信,或没开)。 */
export type SecondState = 'pending' | 'running' | 'done' | 'failed'
/** 第二意见的结果(影子模式下只显示,不改字段和状态)。字段键: merchant / date / total / subtotal / tax / paid / change。 */
export interface SecondResult {
  at: string
  /** 第二个读取模型(GLM-OCR)的读数;读不出为 null。 */
  model2: { candidate: Partial<Record<string, string | number | null>>; status: string; reasons: string[]; text: string; ms: number } | null
  /** 每个字段两个模型读数是否一致。 */
  agree: Partial<Record<string, boolean>>
  disputed: string[]
  /** Jev 给两份转写的打分(和图片吻合程度,0..1);没开或失败为 null。 */
  jev: { first: number | null; second: number | null } | null
  /** Qwen 对争议字段的仲裁(选的值已经过「必须在转写里找到」的硬约束);没开为 null。 */
  qwen: Partial<Record<string, { pick: 'A' | 'B' | 'neither'; value: string | number | null; evidence: string }>> | null
  /** 如果打开自动升级会怎样(影子模式下只记录)。 */
  decision: { upgrade: boolean; why: string; fields: string[] }
  applied?: boolean
  ms: number
}

export interface ReceiptDetail extends ReceiptRow {
  /** 分类、标题、关键词、对方、表头、付款、关联单据;没分类过的旧数据为 null。金额和商品行不在这里(以 data 为准)。 */
  doc: StoredDoc | null
  second: SecondResult | null
  data: ReceiptData // 当前值(待审核时是机器结果或草稿;已审核时是人工确认的最终值)
  machine: ReceiptData // 流水线的原始识别结果,用来对比人工改了什么
  corrections: Correction[]
  suggestions: Correction[]
  verifier: VerifierInfo
  regexTotal: number | null
  suggestedTotal: number | null
  ocrText: string
  /** 识别出的文字框(坐标是占整张图的比例 0..1);识别服务没有给位置时是空数组。 */
  boxes: OcrBox[]
  timing: Record<string, number> | null
  audit: AuditEntry[]
  /** 跨批次的疑似重复:商家、日期、总额都相同的其他收据。 */
  duplicates: { id: number; file: string; state: ReviewState }[]
}

/** 一个识别出的词和它在图片上的位置(都是占整张图宽/高的比例,和图片显示大小无关)。 */
export interface OcrBox { t: string; x: number; y: number; w: number; h: number }

export interface AmountSum { currency: string | null; count: number; sum: number }
export interface ListResponse { rows: ReceiptRow[]; total: number; page: number; pageSize: number; sums: AmountSum[] }

export interface Stats {
  pending: number
  approved: number
  rejected: number
  pendingByStatus: Partial<Record<PipelineStatus, number>>
}

export interface ReceiptQuery {
  state?: ReviewState | 'all'
  status?: PipelineStatus
  q?: string
  currency?: string
  from?: string
  to?: string
  edited?: 'yes' | 'no'
  /** 按单据类型筛选;'none' = 没分类过的。 */
  type?: DocType | 'none'
  direction?: Direction
  ids?: string // 逗号分隔的收据编号,只导出/查询选中的
  lang?: Lang // 导出 CSV 时表头的语言
  reviewer?: string
  sort?: string
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

/** 批量通过的范围: clean = 只通过没发现问题的(默认);all = 连同有问题的一起通过(要员工明确选择)。 */
export type BulkScope = 'clean' | 'all'
export interface BulkRequest { ids: number[]; action: 'approve' | 'reject' | 'reopen'; user: string; note?: string; scope?: BulkScope }
/** 批量通过时有问题的收据。codes: 语言无关的问题代码(对账检查项、系统初判、缺字段…),界面翻译。 */
export interface BulkProblem { id: number; file: string; merchant: string | null; total: number | null; codes: string[] }
export interface BulkPreview { clean: number; flagged: BulkProblem[]; blocked: BulkProblem[] }
export interface BulkResult { done: number; skipped: number; flagged: BulkProblem[]; blocked: BulkProblem[]; approvedFlagged: number }

export interface ReviewRequest {
  action: ReviewAction
  version: number
  user: string
  note?: string
  final?: Partial<Record<FieldKey, unknown>>
}

/** 门户内直接扫描(上传图片 → 识别 → 进入待审核)。 */
/** local: 识别服务在本机或内网,图片不会发送给第三方(界面据此不再提示"发送给第三方")。 */
export interface ScanInfo { enabled: boolean; provider: string | null; sharedTestKey: boolean; maxBytes: number; local: boolean }
/** items: 这张识别出几行商品明细(识别服务读不出来就是 0);ms: 识别耗时(毫秒)。 */
export interface ScanOutcome {
  file: string; id: number | null; duplicate: boolean; status: PipelineStatus | null; reasons: string[]; ms: number; merchant: string | null; total: number | null; currency: string | null; items?: number
  /** 分类模式下的结果;没开分类 / 没分过类为 null。 */
  documentType?: DocType | null; direction?: Direction | null; title?: string | null
}

/** 标准答案导入结果。 */
export interface TruthImportResult { added: number; updated: number; failed: number; errors: string[] }
/** 一个字段的对照: n = 有标准答案的收据数;machine = 机器原始结果读对的;finalN/final = 其中已审核通过的、人工确认后读对的。 */
export interface AccuracyField { n: number; machine: number; final: number; finalN: number }
export interface AccuracySource { source: string; receipts: number; total: AccuracyField; date: AccuracyField; company: AccuracyField }
export interface AccuracyRow { id: number; file: string; source: string; field: 'total' | 'date' | 'company'; machine: string | null; truth: string | null; finalOk: boolean | null }
export interface AccuracyReport { labelled: number; matched: number; sources: AccuracySource[]; mismatches: AccuracyRow[] }

export interface ImportResult { added: number; duplicates: number; withoutImage: number; failed: number; errors?: string[] }

export interface Meta { currencies: string[]; reviewers: string[]; merchants: string[] }

export type Granularity = 'day' | 'week' | 'month'
export interface AnalyticsQuery { from?: string; to?: string; currency?: string; granularity?: Granularity }

/** 按识别来源(OCR.space / MiniCPM / 流水线导入…)分组的对比。来源取自批次名,见 server/lib/analytics.ts 的 providerOf。 */
export interface ProviderStat {
  provider: string
  count: number
  pending: number
  approved: number
  rejected: number
  autoShare: number // 系统初判为「基本可信」(AUTO / AUTO_VERIFIED)的占比
  reviewShare: number // 系统初判为「需检查」(REVIEW)的占比
  editRate: number | null // 逐张审核通过的收据里被人工改过的比例(批量通过的不计入);没有样本时为 null
  editSample: number
  avgSeconds: number | null // 平均识别耗时(只统计记录了耗时的收据,目前只有 MiniCPM 记录)
  timedCount: number
}

export interface Analytics {
  range: { from: string | null; to: string | null }
  currencies: string[]
  currency: string | null
  kpis: {
    total: number
    pending: number
    approved: number
    rejected: number
    approvedAmounts: { currency: string | null; count: number; sum: number; avg: number }[]
    editRate: number | null // 逐张审核通过的收据里,被人工改过的比例(批量通过的不计入)
    editSample: number // editRate 的样本量: 逐张审核通过的张数
    bulkApproved: number // 批量通过的张数(没有逐张看过,不计入任何准确率)
    autoPrecision: number | null // 系统标为 AUTO / AUTO_VERIFIED 的,逐张审核后没改就通过的比例
    autoSample: number // autoPrecision 的样本量
    avgReviewHours: number | null
  }
  series: { period: string; count: number; sum: number }[]
  topMerchants: { merchant: string; count: number; sum: number }[]
  calibration: { status: PipelineStatus; approvedUnchanged: number; approvedEdited: number; approvedBulk: number; rejected: number; pending: number }[]
  fieldCorrections: { field: FieldKey; count: number; rate: number }[]
  flagStats: { code: string; flagged: number; edited: number; rate: number }[]
  reviewers: { reviewer: string; approved: number; rejected: number; edited: number; bulk: number }[]
  daily: { day: string; approved: number; rejected: number }[]
  providers: ProviderStat[]
}

export interface AuditQuery { user?: string; action?: string; q?: string; page?: number; pageSize?: number }
export interface AuditResponse { rows: AuditEntry[]; total: number; page: number; pageSize: number; users: string[] }
