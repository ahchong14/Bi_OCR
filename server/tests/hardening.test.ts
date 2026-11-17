import { describe, expect, test } from 'bun:test'
import { reconcile, type ReconInput } from '../../shared/reconcile'
import { cleanData } from '../lib/clean'
import { extractFromText, triage } from '../lib/extract'
import { repairAmounts } from '../lib/structured'

const ids = (i: ReconInput) => reconcile(i).checks.map((c) => `${c.id}:${c.status}`)
const has = (i: ReconInput, s: string) => ids(i).includes(s)
const fix = (o: Record<string, unknown>, transcript = '') => repairAmounts(cleanData(o, true), transcript)

describe('抄值修复: 模型把相邻字段的数字又抄进别的格子', () => {
  test('舍入 / 小费 / 其他费和别的金额完全相同、转写里没有带标签的行 → 清空', () => {
    const r = fix({ subtotal: 31, tax: 1.76, rounding: 1.76, total: 31 })
    expect(r.d.rounding).toBeNull()
    expect(r.fixes).toContain('rounding')
    expect(fix({ subtotal: 20, tax: 1.2, tip: 1.2, total: 21.2 }).d.tip).toBeNull()
    expect(fix({ subtotal: 20, tax: 1.2, fees: 21.2, total: 21.2 }).d.fees).toBeNull()
  })
  test('转写里有带标签的那一行 → 是真的,不动', () => {
    const t = 'Subtotal 20.00\nTax 1.20\nTip 1.20\nTotal 21.20'
    expect(fix({ subtotal: 20, tax: 1.2, tip: 1.2, total: 21.2 }, t).d.tip).toBe(1.2)
  })
  test('很小的舍入(≤0.05)可能就是真的现金舍入,即使碰巧和税额相同也不清空', () => {
    expect(fix({ subtotal: 10, tax: 0.02, rounding: 0.02, total: 10.04 }).d.rounding).toBe(0.02)
  })
  test('找零大于等于实付是算术上不可能的 → 清空找零', () => {
    const r = fix({ total: 29.24, paid: 29.24, change: 29.24 })
    expect(r.d.change).toBeNull()
    expect(r.cleanups).toContain('change') // 清掉没有依据的次要字段 = 清理,不压低状态
    expect(r.corrections.some((c) => c.field === 'change')).toBe(true)
  })
  test('正常的找零不动: 实付 50 总额 31 找零 19;找零恰好等于总额但小于实付(付 20 买 10 找 10)', () => {
    expect(fix({ total: 31, paid: 50, change: 19 }).d.change).toBe(19)
    expect(fix({ total: 10, paid: 20, change: 10 }).d.change).toBe(10)
  })
})

describe('舍入金额: 按币种的现金舍入规则(马币 0.05 → 最多 ±0.02)', () => {
  const base = { currency: 'MYR', subtotal: 27.1, tax: 0, total: 27.1 }
  test('±0.02 以内正常,没有任何提示', () => {
    expect(ids({ ...base, rounding: -0.02, total: 27.08 }).some((x) => x.startsWith('rounding_too_large'))).toBe(false)
  })
  test('0.03–0.05: 只是提示「超出标准范围」(info),不拦自动通过', () => {
    expect(has({ ...base, rounding: -0.03, total: 27.07 }, 'rounding_too_large:info')).toBe(true)
    expect(reconcile({ ...base, rounding: -0.03, total: 27.07 }).flags).not.toContain('rounding_too_large')
  })
  test('超过 0.05: 警告,并带原因代码', () => {
    const r = reconcile({ ...base, rounding: 1.76, total: 28.86 })
    expect(r.checks.some((c) => c.id === 'rounding_too_large' && c.status === 'warn')).toBe(true)
    expect(r.flags).toContain('rounding_too_large')
  })
})

describe('税制日期: 马来西亚 2018-06-01 至 08-31 GST 税率为 0%', () => {
  const i: ReconInput = { currency: 'MYR', subtotal: 100, tax: 6, total: 106 }
  test('这段时间收据上有税额 → 警告', () => {
    expect(has({ ...i, date: '2018-07-15' }, 'tax_in_gst_holiday:warn')).toBe(true)
    expect(reconcile({ ...i, date: '2018-06-01' }).flags).toContain('tax_in_gst_holiday')
    expect(has({ ...i, date: '2018-08-31' }, 'tax_in_gst_holiday:warn')).toBe(true)
  })
  test('窗口之外、没有日期、没有税额、其他币种 → 不触发', () => {
    expect(has({ ...i, date: '2018-05-31' }, 'tax_in_gst_holiday:warn')).toBe(false)
    expect(has({ ...i, date: '2018-09-01' }, 'tax_in_gst_holiday:warn')).toBe(false)
    expect(has(i, 'tax_in_gst_holiday:warn')).toBe(false)
    expect(has({ ...i, tax: 0, total: 100, date: '2018-07-15' }, 'tax_in_gst_holiday:warn')).toBe(false)
    expect(has({ ...i, currency: 'SGD', date: '2018-07-15' }, 'tax_in_gst_holiday:warn')).toBe(false)
  })
})

describe('商品行自己的折扣', () => {
  // 两件 10.00,每件印着折扣 2.00;小计 16.00(金额是折扣前的)
  const items = [{ qty: 1, price: 10, discount: 2 }, { qty: 1, price: 10, discount: 2 }]
  test('金额是折扣前的: 扣掉每行折扣后和小计对上', () => {
    expect(has({ currency: 'MYR', items, subtotal: 16, total: 16 }, 'items_vs_subtotal:ok')).toBe(true)
  })
  test('金额已经是折扣后的: 照常对上', () => {
    expect(has({ currency: 'MYR', items, subtotal: 20, total: 20 }, 'items_vs_subtotal:ok')).toBe(true)
  })
  test('两种读法都对不上: 仍然报错', () => {
    expect(has({ currency: 'MYR', items, subtotal: 25, total: 25 }, 'items_vs_subtotal:fail')).toBe(true)
  })
})

describe('币种没填', () => {
  test('提示一下(info),不影响其他检查', () => {
    expect(has({ subtotal: 10, tax: 0, total: 10 }, 'currency_missing:info')).toBe(true)
    expect(has({ currency: 'MYR', subtotal: 10, tax: 0, total: 10 }, 'currency_missing:info')).toBe(false)
  })
})

describe('分流: 警告级别的检查也不能是「基本可信」', () => {
  test('算术全对、字段齐全,但有 warn(舍入过大) → REVIEW', () => {
    const d = cleanData({ merchant: 'KEDAI RUNCIT MAJU SDN BHD', date: '2025-08-15', currency: 'MYR', subtotal: 10, tax: 0, rounding: 1, total: 11, paid: 11 }, true)
    const recon = reconcile({ ...d })
    expect(recon.hasFail).toBe(false)
    expect(recon.checks.some((c) => c.status === 'warn')).toBe(true)
    expect(triage(d, recon, { ambiguous: false }, [])).toBe('REVIEW')
  })
  test('没有 warn 时照常 AUTO_VERIFIED', () => {
    const d = cleanData({ merchant: 'KEDAI RUNCIT MAJU SDN BHD', date: '2025-08-15', currency: 'MYR', subtotal: 10, tax: 0, total: 10, paid: 10 }, true)
    expect(triage(d, reconcile({ ...d }), { ambiguous: false }, [])).toBe('AUTO_VERIFIED')
  })
})

describe('规则提取: 「Total After Rounding」是舍入后的总额,不是舍入金额', () => {
  test('舍入调整 0.00、舍入后总额 39.90 → 舍入读成 0 或空,不会读成 39.90', () => {
    const t = 'TONY MART SDN BHD\n12/03/2018 10:22\nBD06000800 1 * 39.90 39.90\nTotal Sales Incl. GST 39.90\nRounding Adjustment 0.00\nTotal After Rounding 39.90\nVISA 39.90\n'
    const e = extractFromText(t)
    expect(e.data.rounding === null || e.data.rounding === 0).toBe(true)
    expect(e.data.total).toBe(39.9)
  })
})

describe('总额读成了舍入之前的含税合计(票上: 含税合计 65.72 → 舍入 −0.02 → 应付 65.70)', () => {
  const i: ReconInput = { currency: 'MYR', subtotal: 62, tax: 3.72, rounding: -0.02, total: 65.72 }
  test('对账: 公式对不上,但提示「总额读成了舍入之前的合计」并建议改成 65.70', () => {
    const r = reconcile(i)
    const f = r.checks.find((c) => c.id === 'total_formula')!
    expect(f.status).toBe('fail')
    expect(f.params.hint).toBe('total_before_rounding')
    expect(r.fills).toContainEqual({ field: 'total', value: 65.7, reason: 'total_before_rounding', replaces: 65.72, params: {} })
  })
  test('舍入大、或总额和公式差得不是正好一个舍入 → 不给这条建议', () => {
    expect(reconcile({ ...i, rounding: -1, total: 65.72 }).fills.some((x) => x.reason === 'total_before_rounding')).toBe(false)
    expect(reconcile({ ...i, total: 65.9 }).fills.some((x) => x.reason === 'total_before_rounding')).toBe(false)
    expect(reconcile({ ...i, rounding: null, total: 65.72 }).fills.some((x) => x.reason === 'total_before_rounding')).toBe(false)
  })
  test('扫描修复: 实付 65.70 佐证 → 自动把总额改成 65.70,留更正记录', () => {
    const r = fix({ subtotal: 62, tax: 3.72, rounding: -0.02, total: 65.72, paid: 65.7 })
    expect(r.d.total).toBe(65.7)
    expect(r.fixes).toContain('total')
    expect(r.corrections.find((c) => c.field === 'total')).toMatchObject({ old: 65.72, new: 65.7 })
  })
  test('没有实付佐证、或实付等于现在的总额 → 不自动改', () => {
    expect(fix({ subtotal: 62, tax: 3.72, rounding: -0.02, total: 65.72 }).d.total).toBe(65.72)
    expect(fix({ subtotal: 62, tax: 3.72, rounding: -0.02, total: 65.72, paid: 65.72 }).d.total).toBe(65.72)
  })
})
