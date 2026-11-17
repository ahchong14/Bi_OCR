import { lineAmountOf, unitOf } from '../../../shared/linecalc'
import { AMOUNT_KEYS, type FieldKey, type Item, type ReceiptData } from '../../../shared/types'
import { reconcile, type CheckStatus, type ReconCheck, type ReconInput, type ReconResult } from '../../../shared/reconcile'
import type { AmountError } from '../../../shared/amount'
import type { Key, T } from '../i18n'
import { amountError, money, parseNum } from './format'

/** 表单里的所有值都是字符串(员工正在输入),提交时由服务端统一清洗。 */
/** 表单里的一行商品。unit(单价)是可编辑的输入,price(金额)由它算出来: 金额 = 数量 × 单价 − 折扣(见 lineAmountOf)。库里只存 price / qty / discount,单价不存,打开时由 (金额 + 折扣) ÷ 数量 反推。 */
export interface FormItem { key: number; name: string; qty: string; uom: string; discount: string; taxRate: string; price: string; unit: string }

/** 改了数量 / 单价 / 折扣之后,重新算金额。单价为空就不动金额(算不出来,让员工直接填金额)。 */
export function withAmount(it: FormItem): FormItem {
  const a = lineAmountOf(it.qty, it.unit, it.discount)
  return a === null ? it : { ...it, price: a.toFixed(2) }
}
export interface FormState {
  merchant: string; date: string; currency: string; note: string
  subtotal: string; discount: string; service_charge: string; tax: string; tip: string; fees: string; rounding: string; total: string; paid: string; change: string
  items: FormItem[]
}

let itemKey = 0
export const newItem = (i: Partial<Item> = {}): FormItem => ({
  key: ++itemKey, name: i.name ?? '', qty: i.qty === null || i.qty === undefined ? '' : String(i.qty), uom: i.uom ?? '', discount: i.discount === undefined ? '' : i.discount.toFixed(2), taxRate: i.taxRate === undefined ? '' : String(i.taxRate), price: i.price === null || i.price === undefined ? '' : i.price.toFixed(2),
  // 单价 = (金额 + 折扣) ÷ 数量(数量空当 1;金额没有就留空)。只用于显示 / 编辑,不改金额
  unit: unitOf(i.price, i.discount, i.qty),
})

export function toForm(d: ReceiptData, note = ''): FormState {
  const f = { merchant: d.merchant ?? '', date: d.date ?? '', currency: d.currency ?? '', note } as FormState
  for (const k of AMOUNT_KEYS) f[k] = d[k] === null ? '' : d[k]!.toFixed(2)
  f.items = d.items.map(newItem)
  return f
}

export const toPayload = (f: FormState) => ({
  merchant: f.merchant, date: f.date, currency: f.currency,
  ...Object.fromEntries(AMOUNT_KEYS.map((k) => [k, f[k]])),
  items: f.items.map((i) => ({ name: i.name, qty: i.qty, uom: i.uom, discount: i.discount, taxRate: i.taxRate, price: i.price })),
})

const r2 = (x: number | null) => (x === null || Number.isNaN(x) ? null : Math.round(x * 100) / 100)

/** 规范化后的表单(用于判断有没有改动、改了哪些字段、以及跑对账)。 */
export function canon(f: FormState): ReceiptData {
  const d = { merchant: f.merchant.trim() || null, date: f.date.trim() || null, currency: f.currency.trim().toUpperCase() || null } as ReceiptData
  for (const k of AMOUNT_KEYS) d[k] = r2(parseNum(f[k]))
  d.items = f.items
    .map((i) => {
      const uom = i.uom.trim(), discount = r2(parseNum(i.discount)), taxRate = r2(parseNum(i.taxRate))
      // 单位/折扣没填就不带这两个键,和服务端存的旧数据长得一样(否则每张都会被判成「改过」)
      return { name: i.name.trim(), qty: r2(parseNum(i.qty)), price: r2(parseNum(i.price)), ...(uom ? { uom } : {}), ...(discount !== null ? { discount } : {}), ...(taxRate !== null && taxRate >= 0 && taxRate <= 30 ? { taxRate } : {}) } as Item
    })
    .filter((i) => i.name || i.qty !== null || i.price !== null)
  return d
}

/** 表单里写得有问题的金额格子(金额字段 + 每行商品的数量/金额),通过或保存前必须先改对。 */
export interface FormErrors { fields: Partial<Record<(typeof AMOUNT_KEYS)[number], AmountError>>; items: Record<number, { qty?: AmountError; discount?: AmountError; price?: AmountError }>; count: number }
export function formErrors(f: FormState): FormErrors {
  const out: FormErrors = { fields: {}, items: {}, count: 0 }
  for (const k of AMOUNT_KEYS) { const e = amountError(f[k]); if (e) { out.fields[k] = e; out.count++ } }
  for (const i of f.items) {
    const qty = amountError(i.qty), price = amountError(i.price), discount = amountError(i.discount)
    if (qty || price || discount) { out.items[i.key] = { qty: qty ?? undefined, discount: discount ?? undefined, price: price ?? undefined }; out.count += (qty ? 1 : 0) + (price ? 1 : 0) + (discount ? 1 : 0) }
  }
  return out
}

export function diffFields(a: ReceiptData, b: ReceiptData): FieldKey[] {
  const keys: FieldKey[] = ['merchant', 'date', 'currency', ...AMOUNT_KEYS, 'items']
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

// ---------------------------------------------------------------- 对账结果的展示
export interface CheckLine { id: ReconCheck['id']; status: CheckStatus; text: string; hint?: string }
export interface Recon {
  result: ReconResult
  lines: CheckLine[]
  /** 对账引擎里"有价格的商品"第 i 个 → 表单里的商品行 key / 行号(1 起)。 */
  priced: { key: number; row: number }[]
  /** 可能多出来的商品行(商品合计对不上时,去掉它就能对上)。 */
  suspectKeys: Set<number>
}

export function runRecon(form: FormState, t: T): Recon {
  const d = canon(form)
  const input: ReconInput = { ...d }
  const result = reconcile(input)

  // 引擎只看"有价格的商品",这里还原它们在表单里的行号,提示才能说"第 3 行"
  const priced: Recon['priced'] = []
  form.items.forEach((it, idx) => {
    const p = r2(parseNum(it.price))
    if (p !== null) priced.push({ key: it.key, row: idx + 1 })
  })
  const rowOf = (i: number) => priced[i]?.row ?? i + 1
  const suspectKeys = new Set<number>()
  const lines: CheckLine[] = []
  const m = (n: unknown) => money(Number(n))

  for (const c of result.checks) {
    const p = c.params
    const base = { id: c.id, status: c.status }
    switch (c.id) {
      case 'items_vs_subtotal': {
        const ref = t(`ref.${p.refLabel}` as Key)
        if (c.status === 'ok') lines.push({ ...base, text: t('check.items_vs_subtotal.ok', { itemsSum: m(p.itemsSum), ref }) })
        else {
          const extra = (p.extraItems as number[] | undefined) ?? []
          extra.forEach((i) => priced[i] && suspectKeys.add(priced[i]!.key))
          lines.push({
            ...base, text: t('check.items_vs_subtotal.fail', { itemsSum: m(p.itemsSum), ref, refValue: m(p.ref), diff: m(Math.abs(Number(p.diff))) }),
            hint: extra.length ? t('check.items.extra', { rows: extra.map(rowOf).join(', ') }) : p.missingAmount ? t('check.items.missing', { amount: m(p.missingAmount) }) : undefined,
          })
        }
        break
      }
      case 'total_formula': {
        if (c.status === 'ok') lines.push({ ...base, text: t(`check.total_formula.ok.${result.mode}` as Key, { expected: m(p.expected), total: m(p.total) }) })
        else lines.push({ ...base, text: t('check.total_formula.fail', { expected: m(p.expected), total: m(p.total), diff: m(Math.abs(Number(p.diff))) }), hint: t(`hint.${p.hint}` as Key) })
        break
      }
      case 'tax_rate':
        lines.push({ ...base, text: c.status === 'ok' ? t('check.tax_rate.ok', { rate: Number(p.rate), base: m(p.base) }) : c.status === 'warn' ? t('check.tax_rate.warn', { rate: Number(p.rate) }) : t(`check.tax_rate.${p.kind}` as Key, { rate: Number(p.rate) }) })
        break
      case 'tax_by_rate': {
        const g = p.groups as number[]
        const groups = Array.from({ length: g.length / 3 }, (_, k) => `${g[k * 3]}%: ${m(g[k * 3 + 1])} → ${m(g[k * 3 + 2])}`).join(' · ')
        lines.push({ ...base, text: t(c.status === 'ok' ? 'check.tax_by_rate.ok' : c.status === 'warn' ? 'check.tax_by_rate.warn' : 'check.tax_by_rate.info', { computed: m(p.computed), tax: m(p.tax ?? 0), groups }) })
        break
      }
      case 'payment_vs_total':
        lines.push({ ...base, text: t(c.status === 'ok' ? 'check.payment_vs_total.ok' : 'check.payment_vs_total.fail', { paid: m(p.paid), change: m(p.change), implied: m(p.implied), total: m(p.total), diff: m(Math.abs(Number(p.diff ?? 0))) }) })
        break
      case 'rounding_implied': lines.push({ ...base, text: t('check.rounding_implied', { amount: m(p.amount) }) }); break
      case 'non_positive_total': lines.push({ ...base, text: t('check.non_positive_total') }); break
      case 'discount_exceeds_subtotal': lines.push({ ...base, text: t('check.discount_exceeds_subtotal', { discount: m(p.discount), subtotal: m(p.subtotal) }) }); break
      case 'tax_exceeds_subtotal': lines.push({ ...base, text: t('check.tax_exceeds_subtotal', { tax: m(p.tax), subtotal: m(p.subtotal) }) }); break
      case 'subtotal_is_total': lines.push({ ...base, text: t('check.subtotal_is_total', { subtotal: m(p.subtotal), derived: m(p.derived) }) }); break
      case 'item_exceeds_total': lines.push({ ...base, text: t('check.item_exceeds_total', { row: rowOf(Number(p.index)), price: m(p.price), total: m(p.total) }) }); break
      case 'paid_less_than_total': lines.push({ ...base, text: t('check.paid_less_than_total', { paid: m(p.paid), total: m(p.total) }) }); break
      case 'tax_in_gst_holiday': lines.push({ ...base, text: t('check.tax_in_gst_holiday', { tax: m(p.tax), date: String(p.date) }) }); break
      case 'currency_missing': lines.push({ ...base, text: t('check.currency_missing') }); break
      case 'rounding_too_large': lines.push({ ...base, text: t(c.status === 'warn' ? 'check.rounding_too_large' : 'check.rounding_unusual', { rounding: m(p.rounding), limit: m(p.limit ?? 0) }) }); break
    }
  }
  return { result, lines, priced, suspectKeys }
}

/** 日期字符串尽力转成 ISO(日在前),用于"第二个模型读到的日期"一键采用。 */
export function toISO(s: string | undefined | null): string {
  const v = String(s ?? '').trim()
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})/.exec(v)
  if (m) return `${m[3]!.length === 2 ? '20' + m[3] : m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return ''
}
