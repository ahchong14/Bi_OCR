import { AMOUNT_KEYS, type FieldKey, type Item, type ReceiptData } from '../../shared/types'
import { parseAmount } from '../../shared/amount'
import { rateOf } from '../../shared/items'
import { HttpError } from './errors'

/** 'RM 1,234.56' / '1.234,56' / '(5.00)' / 12 -> number;空 -> null;无法解析或不合理 -> 抛错(规则见 shared/amount.ts,前端同一份)。 */
export function toAmount(v: unknown): number | null {
  const r = parseAmount(v)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

export const emptyData = (): ReceiptData => ({
  merchant: null, date: null, currency: null, subtotal: null, discount: null, service_charge: null, tax: null,
  tip: null, fees: null, rounding: null, total: null, paid: null, change: null, items: [],
})

/** 把机器结果或人工提交的数据整理成统一结构。出错抛 HttpError(400),提示语直接给员工看。 */
export function cleanData(input: unknown, lenient = false): ReceiptData {
  const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out = emptyData()
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())

  out.merchant = str(d.merchant) || null
  const date = str(d.date)
  if (date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    const dt = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null
    if (!m || !dt || dt.getUTCFullYear() !== +m[1]! || dt.getUTCMonth() !== +m[2]! - 1 || dt.getUTCDate() !== +m[3]!) {
      if (!lenient) throw new HttpError(400, 'DATE_FORMAT')
    } else out.date = date
  }
  out.currency = str(d.currency).toUpperCase() || null
  for (const k of AMOUNT_KEYS) {
    try {
      out[k] = toAmount(d[k])
    } catch (e) {
      if (!lenient) throw new HttpError(400, (e as Error).message === 'range' ? 'AMOUNT_RANGE' : 'AMOUNT_INVALID', { field: k })
    }
  }
  const items: Item[] = []
  const raw = Array.isArray(d.items) ? d.items : []
  raw.forEach((it, i) => {
    if (!it || typeof it !== 'object') return
    const o = it as Record<string, unknown>
    const name = str(o.name)
    let qty: number | null
    let price: number | null
    let discount: number | null
    try {
      qty = toAmount(o.qty)
      price = toAmount(o.price)
      discount = toAmount(o.discount)
    } catch {
      if (lenient) return // 流水线给的某一行商品数字不合格: 跳过这一行,不连累整张收据
      throw new HttpError(400, 'ITEM_INVALID', { n: i + 1 })
    }
    const uom = str(o.uom).replace(/\s+/g, ' ').slice(0, 16)
    const taxRate = rateOf(o.taxRate ?? o.tax_rate) // 看不懂的税率当没填,不挡整张收据
    if (name || qty !== null || price !== null) items.push({ name, qty, price, ...(uom ? { uom } : {}), ...(discount !== null ? { discount } : {}), ...(taxRate !== null ? { taxRate } : {}) })
  })
  out.items = items
  return out
}

/** 两份数据之间被改动的字段(用于审计和"人工修改率"统计)。 */
export function changedFields(a: ReceiptData, b: ReceiptData): FieldKey[] {
  const keys: FieldKey[] = ['merchant', 'date', 'currency', ...AMOUNT_KEYS, 'items']
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}
