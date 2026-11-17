import { describe, expect, test } from 'bun:test'
import { lineAmountOf, unitOf } from '../../shared/linecalc'

describe('商品行: 金额 = 数量 × 单价 − 折扣', () => {
  test('打开时单价由 (金额 + 折扣) ÷ 数量 反推', () => {
    expect(unitOf(48.93, 20.97, 1)).toBe('69.9')
    expect(unitOf(48.93, 20.97, null)).toBe('69.9')        // 数量空当 1
    expect(unitOf(null, 1, 1)).toBe('')
    expect(unitOf(5, 0, 0)).toBe('')                       // 数量 0 → 空
  })
  test('改数量 / 单价 / 折扣,金额重算(折扣减进金额)', () => {
    expect(lineAmountOf('1', '69.9', '20.97')).toBe(48.93)
    expect(lineAmountOf('2', '69.9', '20.97')).toBe(118.83)
    expect(lineAmountOf('1', '69.9', '0')).toBe(69.9)
    expect(lineAmountOf('1', '70', '20.97')).toBe(49.03)
  })
  test('折扣写成负数也按减处理;数量空当 1;单价空 → 算不出;数量 ≤ 0 → 算不出', () => {
    expect(lineAmountOf('', '10', '-2')).toBe(8)
    expect(lineAmountOf('3', '', '')).toBeNull()
    expect(lineAmountOf('0', '10', '')).toBeNull()
    expect(lineAmountOf('1,000', '1', '')).toBe(1000)      // 千分位
  })
})
