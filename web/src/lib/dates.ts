/** 宽松解析员工常打的日期写法,统一成 年-月-日。写法不明确(日/月都 ≤12)时按「日在前」理解(小票上最常见),并告诉调用方"这是猜的"。 */
export interface LooseDate { iso: string; assumed: boolean }

const real = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function parseLooseDate(text: string): LooseDate | null {
  const s = text.trim()
  if (!s) return null
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) return real(+m[1]!, +m[2]!, +m[3]!) ? { iso: iso(+m[1]!, +m[2]!, +m[3]!), assumed: false } : null
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s)
  if (!m) return null
  const a = +m[1]!, b = +m[2]!
  const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!
  if (b > 12 && a <= 12) return real(y, a, b) ? { iso: iso(y, a, b), assumed: false } : null // 第二位大于 12,只能是 月/日/年
  if (!real(y, b, a)) return null
  return { iso: iso(y, b, a), assumed: a <= 12 && a !== b }
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && parseLooseDate(s)?.iso === s
