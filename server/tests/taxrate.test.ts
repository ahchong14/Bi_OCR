import { describe, expect, test } from 'bun:test'
import { reconcile } from '../../shared/reconcile'

// Farmasi 收据: SR 6% 的不含税金额 68.25(含税 72.35,税 4.10),ZRL 0% 的 7.00;总额 79.35
const farmasi = (over: Record<string, unknown> = {}) => ({
  currency: 'MYR',
  items: [
    { name: 'A', qty: 1, price: 40.0, taxRate: 6 },
    { name: 'B', qty: 1, price: 32.35, taxRate: 6 },
    { name: 'C', qty: 1, price: 7.0, taxRate: 0 },
  ],
  total: 79.35,
  ...over,
})

describe('按税率分组算税', () => {
  test('含税价、两种税率: 算出 4.10,而不是总额统一反推的 4.49', () => {
    const r = reconcile(farmasi({ tax: 4.1 }))
    const c = r.checks.find((x) => x.id === 'tax_by_rate')!
    expect(c.status).toBe('ok')
    expect(c.params.computed).toBe(4.1)
    expect(r.fills.some((f) => f.reason === 'computed_by_rate' && f.field === 'tax')).toBe(false)
  })

  test('模型读错了税额: 给出可替换的建议', () => {
    const r = reconcile(farmasi({ tax: 4.49 }))
    expect(r.checks.find((x) => x.id === 'tax_by_rate')!.status).toBe('warn')
    const f = r.fills.find((x) => x.field === 'tax' && x.reason === 'computed_by_rate')!
    expect(f.value).toBe(4.1)
    expect(f.replaces).toBe(4.49)
    expect(r.flags).toContain('tax_differs_by_rate')
    expect(r.hasFail).toBe(false)
  })

  test('没读到税额和小计: 都补全,小计是不含税的', () => {
    const r = reconcile(farmasi())
    expect(r.fills.find((x) => x.field === 'tax')!.value).toBe(4.1)
    expect(r.fills.find((x) => x.field === 'subtotal')!.value).toBe(75.25) // 68.25 + 7.00
    expect(r.fills.filter((x) => x.field === 'subtotal' && x.reason === 'items_sum')).toHaveLength(0)
  })

  test('不含税价: 税额另加在总额上', () => {
    const r = reconcile({ currency: 'MYR', items: [{ qty: 1, price: 50, taxRate: 6 }, { qty: 1, price: 20, taxRate: 0 }], total: 73.0 })
    expect(r.fills.find((x) => x.field === 'tax')!.value).toBe(3.0)
    expect(r.fills.find((x) => x.field === 'subtotal')!.value).toBe(70.0)
  })

  test('有一行没税率: 不下结论', () => {
    const r = reconcile({ currency: 'MYR', items: [{ qty: 1, price: 50, taxRate: 6 }, { qty: 1, price: 20 }], total: 73.0 })
    expect(r.checks.some((x) => x.id === 'tax_by_rate')).toBe(false)
  })

  test('算出来的总额对不上: 不建议任何值', () => {
    const r = reconcile({ currency: 'MYR', items: [{ qty: 1, price: 50, taxRate: 6 }], total: 99.99 })
    expect(r.checks.some((x) => x.id === 'tax_by_rate')).toBe(false)
    expect(r.fills.some((x) => x.reason === 'computed_by_rate')).toBe(false)
  })

  test('整单折扣先于税', () => {
    // 100 含 6% 税,整单折扣 10 → 90,税 = 90 - 90/1.06 = 5.09
    const r = reconcile({ currency: 'MYR', items: [{ qty: 1, price: 100, taxRate: 6 }], discount: 10, total: 90 })
    expect(r.fills.find((x) => x.field === 'tax')!.value).toBe(5.09)
  })
})

import { cleanData } from '../lib/clean'
import { modelItemRows, rateOf, salvageLineItems } from '../../shared/items'

describe('每行税率的读取', () => {
  test('rateOf: 百分比和零税率代码认得,含糊的字母代码不猜', () => {
    expect(rateOf('6%')).toBe(6)
    expect(rateOf('SR 6%')).toBe(6)
    expect(rateOf(' 8.0 ')).toBe(8)
    expect(rateOf(0)).toBe(0)
    expect(rateOf('ZRL')).toBe(0)
    expect(rateOf('Z')).toBe(0)
    expect(rateOf('SR')).toBeNull()
    expect(rateOf('S')).toBeNull()
    expect(rateOf('###')).toBeNull()
    expect(rateOf('99%')).toBeNull()
    expect(rateOf(null)).toBeNull()
  })
  test('清洗: 有税率就保留,没有或看不懂就不带这个键', () => {
    const d = cleanData({ items: [{ name: 'A', qty: 1, price: 10, taxRate: '6%' }, { name: 'B', qty: 1, price: 3, taxRate: 'SR' }, { name: 'C', qty: 1, price: 2 }] }, false)
    expect(d.items[0]).toEqual({ name: 'A', qty: 1, price: 10, taxRate: 6 })
    expect(Object.keys(d.items[1]!)).toEqual(['name', 'qty', 'price'])
    expect(Object.keys(d.items[2]!)).toEqual(['name', 'qty', 'price'])
  })
  test('坏 JSON 抢救和明细表格: tax 跟在 discount 后面一起读出来', () => {
    const s = '{"line_items":[{"description":"a","quantity":"1","unit_price":"2","amount":"2","uom":"pcs","discount":"###","tax":"6%"}]}'
    expect(salvageLineItems(s)[0]).toMatchObject({ tax: '6%' })
    expect(modelItemRows('[line items]\n' + s).rows[0]).toMatchObject({ tax: '6%' })
  })
})
