/**
 * 商品行的金额算法(审核页的表单和测试共用,不依赖界面代码)。
 * 行金额 = 数量 × 单价 − 折扣: 折扣后的净额,AutoCount 明细行的「金额 / SubTotal」就是这个口径;税另算,不加进这一列。
 * 库里只存 金额 / 数量 / 折扣,单价不存,打开时由 (金额 + 折扣) ÷ 数量 反推。
 */
const round2 = (x: number) => Math.round(x * 100) / 100
const numOf = (s: string): number | null => { const t = s.trim().replace(/,/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null }

/** 数量空当 1;单价读不成数 / 数量 ≤ 0 → 算不出(null,调用方保持金额不变)。折扣写成负数也按减处理。 */
export function lineAmountOf(qty: string, unit: string, discount: string): number | null {
  const u = numOf(unit)
  if (u === null) return null
  const q = numOf(qty) ?? 1
  if (q <= 0) return null
  return round2(q * u - Math.abs(numOf(discount) ?? 0))
}

/** 单价 = (金额 + 折扣) ÷ 数量,保留 3 位。金额没有 / 数量 ≤ 0 → 空字符串。 */
export function unitOf(price: number | null | undefined, discount: number | null | undefined, qty: number | null | undefined): string {
  if (price === null || price === undefined || (qty !== null && qty !== undefined && qty <= 0)) return ''
  return String(Math.round(((price + (discount ?? 0)) / (qty ?? 1)) * 1000) / 1000)
}
