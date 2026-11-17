import { describe, expect, test } from 'bun:test'
import cases from '../../shared/recon-cases.json'
import { normCurrency, reconcile, roundUnit, type ReconInput } from '../../shared/reconcile'

interface Case {
  name: string
  input: ReconInput
  expect: {
    mode?: string
    checks?: Record<string, string>
    absent?: string[]
    fills?: { field: string; value: number; reason: string; replaces?: number }[]
    noFills?: boolean
    params?: Record<string, Record<string, unknown>>
  }
}

describe('对账算法:共用测试用例(Python 版用同一份文件)', () => {
  for (const c of cases as Case[]) {
    test(c.name, () => {
      const r = reconcile(c.input)
      const e = c.expect
      if (e.mode) expect(r.mode).toBe(e.mode as never)
      for (const [id, status] of Object.entries(e.checks ?? {})) {
        const found = r.checks.find((x) => x.id === id)
        expect(found, `缺少检查 ${id};实际: ${JSON.stringify(r.checks)}`).toBeDefined()
        expect(found!.status, `检查 ${id}`).toBe(status as never)
      }
      for (const id of e.absent ?? []) expect(r.checks.find((x) => x.id === id), `不应出现 ${id}`).toBeUndefined()
      for (const f of e.fills ?? []) {
        const found = r.fills.find((x) => x.field === f.field && Math.abs(x.value - f.value) < 0.005)
        expect(found, `缺少建议 ${f.field}=${f.value};实际: ${JSON.stringify(r.fills)}`).toBeDefined()
        expect(found!.reason).toBe(f.reason as never)
        if (f.replaces !== undefined) expect(found!.replaces).toBe(f.replaces)
      }
      if (e.noFills) expect(r.fills).toEqual([])
      for (const [id, want] of Object.entries(e.params ?? {})) {
        const found = r.checks.find((x) => x.id === id)
        expect(found).toBeDefined()
        for (const [k, v] of Object.entries(want)) expect(found!.params[k], `${id}.${k}`).toEqual(v as never)
      }
    })
  }
})

describe('币种', () => {
  test('现金舍入单位', () => {
    expect(roundUnit('MYR')).toBe(0.05)
    expect(roundUnit('RM')).toBe(0.05)
    expect(roundUnit('MYR?')).toBe(0.05) // 流水线用问号标记"推断出的币种"
    expect(roundUnit('USD')).toBe(0.01)
    expect(roundUnit(null)).toBe(0.01)
    expect(roundUnit('JPY')).toBe(1)
  })
  test('币种符号归一', () => {
    expect(normCurrency('S$')).toBe('SGD')
    expect(normCurrency('Rp')).toBe('IDR')
    expect(normCurrency('$')).toBeNull() // 美元符号有歧义,不猜
  })
})

describe('健壮性', () => {
  test('全空输入不报错', () => {
    expect(reconcile({}).checks).toEqual([])
  })
  test('商品价格缺失的行被忽略', () => {
    const r = reconcile({ items: [{ qty: 1, price: null }, { qty: 1, price: 10 }], subtotal: 10, total: 10 })
    expect(r.checks.find((c) => c.id === 'items_vs_subtotal')?.status).toBe('ok')
  })
  test('结果只依赖输入,没有随机性', () => {
    const input: ReconInput = { currency: 'MYR', items: [{ qty: 1, price: 10 }], subtotal: 10, tax: 0.6, total: 10.6 }
    expect(JSON.stringify(reconcile(input))).toBe(JSON.stringify(reconcile(input)))
  })
})

describe('小计读成了含税合计(subtotal_is_total)', () => {
  // 一张不含税的收据: 商品 20.00 + 税 6% 1.20 + 服务费 2.00 = 23.20。模型把 23.20 同时读成了小计和总额。
  const base: ReconInput = { currency: 'MYR', subtotal: 23.2, tax: 1.2, service_charge: 2, total: 23.2, items: [{ qty: 1, price: 12 }, { qty: 1, price: 8 }] }
  test('小计=总额、还有税/服务费、公式对不上 → 只提示小计,商品合计印证时建议改成反推值', () => {
    const r = reconcile(base)
    expect(r.checks.find((c) => c.id === 'subtotal_is_total')?.status).toBe('warn')
    expect(r.flags).toContain('subtotal_is_total')
    expect(r.fills).toContainEqual(expect.objectContaining({ field: 'subtotal', value: 20, reason: 'subtotal_from_total', replaces: 23.2 }))
  })
  test('商品合计和反推值对不上 → 只提示,不建议改', () => {
    const r = reconcile({ ...base, items: [{ qty: 1, price: 5 }] })
    expect(r.checks.find((c) => c.id === 'subtotal_is_total')).toBeDefined()
    expect(r.fills.some((f) => f.reason === 'subtotal_from_total')).toBe(false)
  })
  test('含税价的收据(税已包含在价格里,小计=总额,公式通过)不提示', () => {
    const r = reconcile({ currency: 'MYR', subtotal: 53, tax: 3, total: 53, items: [{ qty: 1, price: 53 }] })
    expect(r.checks.find((c) => c.id === 'subtotal_is_total')).toBeUndefined()
    expect(r.flags).not.toContain('subtotal_is_total')
  })
  test('没有税和费用时,小计=总额是正常的,不提示', () => {
    const r = reconcile({ currency: 'MYR', subtotal: 20, total: 20, items: [{ qty: 1, price: 20 }] })
    expect(r.checks.find((c) => c.id === 'subtotal_is_total')).toBeUndefined()
  })
  test('小计和总额不同(普通的对不上)时不走这条', () => {
    const r = reconcile({ ...base, subtotal: 20, total: 99 })
    expect(r.checks.find((c) => c.id === 'subtotal_is_total')).toBeUndefined()
  })
})

describe('商品价格已含税: 商品合计 = 总额,小计(不含税)比它少一个税额', () => {
  const base = { currency: 'MYR', subtotal: 32.07, tax: 1.93, total: 34, items: [{ qty: 1, price: 19 }, { qty: 1, price: 10 }, { qty: 2, price: 2.5 }] }
  test('单价×数量 = 34.00 = 总额,不再报「商品合计和小计对不上」', () => {
    const c = reconcile(base).checks.find((x) => x.id === 'items_vs_subtotal')
    expect(c?.status).toBe('ok')
    expect(c?.params.itemsSum).toBe(34)
    expect(c?.params.refLabel).toBe('items_tax_incl')
  })
  test('商品合计和小计、和含税总额都对不上时,仍然报错', () => {
    const r = reconcile({ ...base, items: [{ qty: 1, price: 19 }, { qty: 1, price: 10 }] })
    expect(r.checks.find((x) => x.id === 'items_vs_subtotal')?.status).toBe('fail')
  })
  test('没有税时不引入这条参照', () => {
    const r = reconcile({ currency: 'MYR', subtotal: 20, total: 20, items: [{ qty: 1, price: 15 }] })
    expect(r.checks.find((x) => x.id === 'items_vs_subtotal')?.status).toBe('fail')
  })
})
