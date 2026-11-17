import type { FieldKey } from '../../../shared/types'
import type { Key } from '../i18n/zh'

/** 与 i18n/index.tsx 里的 T 结构相同。在这里单独声明,是为了让本文件不依赖 React(这样服务端的测试和类型检查也能引用它)。 */
type T = (key: Key, params?: Record<string, string | number>) => string

/** code: 归并后的原因代码(用来判断是不是只是提示、要不要逐项确认,见 lib/review.ts)。 */
export interface Explained { text: string; fields: FieldKey[]; level: 'warn' | 'info'; code: string }

/** 流水线用中文写进 auto_corrected / fix_suggested 的字段名 → 字段键。 */
const ZH_FIELD: Record<string, FieldKey> = { 总额: 'total', 日期: 'date', 商家: 'merchant', 商品明细: 'items' }

/** 把同一类的原因代码归并成一个键(比如各种 OCR 质量问题)。 */
function canonical(k: string): string {
  if (k === 'ocr_truncated' || k === 'ocr_too_little_text' || k === 'ocr_repetition') return 'ocr_bad'
  if (k === 'date_day_month_swapped') return 'date_ambiguous'
  if (k === 'implausible_date') return 'bad_date_format'
  if (k === 'repair_error') return 'error'
  if (k.startsWith('rotated_')) return 'rotated'
  return k
}

const FIELDS: Record<string, FieldKey[]> = {
  missing_total: ['total'], non_positive_total: ['total'], total_not_in_text: ['total'], subtotal_not_in_text: ['subtotal'], tax_not_in_text: ['tax'],
  paid_not_in_text: ['paid'], change_not_in_text: ['change'], total_conflicts_with_text_rule: ['total'], totals_dont_add_up: ['total', 'subtotal', 'tax'],
  items_sum_ne_subtotal: ['items'], items_not_extracted: ['items'], items_reextract_failed: ['items'], verifier_unreadable: ['total'],
  date_ambiguous: ['date'], bad_date_format: ['date'], missing_date: ['date'], missing_merchant: ['merchant'], tax_rate_odd: ['tax'], tax_differs_by_rate: ['tax'], large_total: ['total'],
  payment_mismatch: ['total', 'paid', 'change'], merchant_unsure: ['merchant'], merchant_legal_name_differs: ['merchant'], date_implausible: ['date'], total_negative: ['total'], single_ocr_unverified: ['total'], item_exceeds_total: ['items'], discount_exceeds_subtotal: ['discount'], subtotal_is_total: ['subtotal'], rounding_too_large: ['rounding'], tax_exceeds_subtotal: ['tax'], paid_less_than_total: ['paid'], tax_in_gst_holiday: ['tax'],
}
const FIELD_KEYS = new Set(['merchant', 'date', 'currency', 'subtotal', 'discount', 'service_charge', 'tax', 'tip', 'fees', 'rounding', 'total', 'paid', 'change', 'items'])
const INFO = new Set(['detail_from_qwen', 'detail_unverified', 'second_agrees', 'second_disagrees', 'second_resolved', 'auto_cleared', 'merchant_tidied', 'merchant_from_text', 'merchant_alias', 'date_day_first_assumed', 'items_rows_dropped', 'items_amount_recomputed', 'paid_from_text', 'change_from_text', 'items_reextracted', 'very_tall_image', 'audit_sample', 'fix_suggested', 'rotated', 'card_number_masked', 'scanned_in_portal']) // auto_corrected 要审核员确认更正对不对,所以是 warn

/** 把流水线给出的原因代码翻译成员工看得懂的话,并指出该重点核对哪些字段。 */
export function explain(code: string, t: T, field: (k: FieldKey) => string): Explained {
  const i = code.indexOf(':')
  const raw = i < 0 ? code : code.slice(0, i)
  const arg = i < 0 ? '' : code.slice(i + 1)
  const k = canonical(raw)
  const level = INFO.has(k) ? 'info' : 'warn'
  const label = (a: string) => { const k = ZH_FIELD[a] ?? (FIELD_KEYS.has(a) ? (a as FieldKey) : null); return k ? field(k) : a }

  if (k === 'reader_disagree') {
    const keys = arg.split(',').filter(Boolean) as FieldKey[]
    return { text: t('reason.reader_disagree', { names: keys.map(field).join(' / ') }), fields: keys, level, code: k }
  }
  if (k === 'verifier_disagrees') {
    const keys = arg.split(',').filter(Boolean) as FieldKey[]
    return { text: t('reason.verifier_disagrees', { names: keys.map(field).join(' / ') }), fields: keys, level, code: k }
  }
  // 第二意见: 参数是字段名(逗号分隔)。只是提示,不影响状态;不一致 / 已采纳的字段指给审核员看
  if (k === 'second_disagrees' || k === 'second_resolved') {
    const keys = arg.split(',').filter(Boolean).map((x) => ZH_FIELD[x] ?? (FIELD_KEYS.has(x) ? (x as FieldKey) : null)).filter((x): x is FieldKey => x !== null)
    return { text: t(`reason.${k}` as Key, { names: keys.map(field).join(' / ') }), fields: keys, level, code: k }
  }
  const key = `reason.${k}` as Key
  let a = arg
  if (k === 'auto_corrected' || k === 'auto_cleared' || k === 'fix_suggested') a = arg.split(',').map(label).join(' / ')
  if (k === 'rotated') a = raw.slice(8)
  const text = t(key, { arg: a })
  // 被自动更正的字段要指给审核员看(界面据此高亮并要求确认)
  const corrected = k === 'auto_corrected' || k === 'auto_cleared' ? arg.split(',').map((x) => ZH_FIELD[x] ?? (FIELD_KEYS.has(x) ? (x as FieldKey) : null)).filter((x): x is FieldKey => x !== null) : null
  return { text: text === key ? code : text, fields: corrected ?? FIELDS[k] ?? [], level, code: k }
}

/** 一句话摘要(队列里显示):优先显示第一条"需要核对"的提示。 */
export function headline(reasons: string[], t: T, field: (k: FieldKey) => string): string {
  // 「商品明细没读出来」在门户扫描的收据里几乎每张都有,别让它盖住更要紧的提示(日期有歧义、商家存疑…)
  const all = reasons.filter((r) => !r.startsWith('items_not_extracted') && r !== 'scanned_in_portal').map((r) => explain(r, t, field)) // 「只有一个识别来源」每张都有,不能当摘要
  const rest = reasons.filter((r) => r.startsWith('items_not_extracted')).map((r) => explain(r, t, field))
  return (all.find((e) => e.level === 'warn') ?? rest.find((e) => e.level === 'warn') ?? all[0] ?? rest[0])?.text ?? t('review.noIssue')
}

/** 提示的简短名字(统计页"提示是否可靠"表使用)。 */
export function codeName(code: string, t: T): string {
  const key = `reasonShort.${canonical(code)}` as Key
  const text = t(key)
  return text === key ? code : text
}
