/**
 * 金额文本解析(前端表单和服务端共用,保证两边结论一致)。
 *
 * 原则:宁可拒绝,也不能悄悄改成别的数。
 * 以前的写法是"把所有非数字字符删掉",于是 `1O.50`(字母 O)变成 1.50、`12abc.5.5` 变成 12.50 —— 金额被默默改错。
 * 现在只接受:数字、千分位/小数分隔符、正负号或括号、以及已知的币种符号/代码(RM、$、MYR…)。
 */

export const AMOUNT_MAX = 1_000_000_000

export type AmountError = 'format' | 'ambiguous' | 'range'
export type AmountResult = { ok: true; value: number | null } | { ok: false; error: AmountError }

const CURRENCY = '(?:RM|MYR|SGD|USD|CNY|RMB|EUR|GBP|JPY|THB|IDR|INR|AUD|HKD|TWD|KRW|VND|PHP|CAD|NZD|S\\$|US\\$|HK\\$|\\$|€|£|¥|￥|₩|฿|₫|₱|₹|Rp|元|块)'
const LEAD = new RegExp(`^${CURRENCY}\\s*`, 'i')
const TAIL = new RegExp(`\\s*${CURRENCY}$`, 'i')

const round2 = (x: number) => Math.round(x * 100) / 100
const fail = (error: AmountError): AmountResult => ({ ok: false, error })

/** 空 → null;数字原样检查范围;字符串按上面的规则解析。 */
export function parseAmount(v: unknown): AmountResult {
  if (v === null || v === undefined || v === '') return { ok: true, value: null }
  if (typeof v === 'boolean') return fail('format')
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return fail('format')
    return Math.abs(v) > AMOUNT_MAX ? fail('range') : { ok: true, value: round2(v) }
  }
  if (typeof v !== 'string') return fail('format')

  let s = v.trim().replace(/[   ]/g, ' ')
  if (!s) return { ok: true, value: null }

  // 括号 = 负数;前后可以有一个符号
  let neg = false
  const paren = /^\((.*)\)$/.exec(s)
  if (paren) { neg = true; s = paren[1]!.trim() }
  s = s.replace(/^[−–]/, '-')
  s = s.replace(/[−–]$/, '-')
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim() }
  else if (s.startsWith('+')) s = s.slice(1).trim()
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1).trim() }

  // 去掉一个币种前缀和/或后缀(只认已知的,随便的字母不行)
  s = s.replace(LEAD, '').replace(TAIL, '').trim()
  if (!/^\d[\d.,' ]*$/.test(s)) return fail('format')

  s = s.replace(/[ ']/g, '') // 空格/撇号当千分位
  const commas = (s.match(/,/g) ?? []).length
  const dots = (s.match(/\./g) ?? []).length
  const grouped = (sep: string, str: string) => new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`).test(str)
  let normalized: string

  if (!commas && !dots) normalized = s
  else if (commas && dots) {
    // 两种都有: 最后出现的是小数点,另一种必须是规整的千分位
    const decSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    const thouSep = decSep === ',' ? '.' : ','
    const at = s.lastIndexOf(decSep)
    const head = s.slice(0, at), frac = s.slice(at + 1)
    if (s.split(decSep).length !== 2 || !/^\d{1,2}$/.test(frac) || !grouped(thouSep, head)) return fail('format')
    normalized = head.split(thouSep).join('') + '.' + frac
  } else {
    const sep = commas ? ',' : '.'
    const parts = s.split(sep)
    if (parts.length > 2) {
      if (!grouped(sep, s)) return fail('format') // 12.5.5 这类
      normalized = parts.join('')
    } else {
      const [head, frac] = parts as [string, string]
      if (/^\d{1,2}$/.test(frac)) normalized = head + '.' + frac
      else if (/^\d{3}$/.test(frac)) {
        // 1,234 按千分位(最常见);1.234 既可能是欧洲千分位也可能是写错的小数,不猜,让员工写清楚
        if (sep === '.' || head.length > 3) return fail('ambiguous')
        normalized = head + frac
      } else return fail('format')
    }
  }

  const x = Number(normalized)
  if (!Number.isFinite(x)) return fail('format')
  if (x > AMOUNT_MAX) return fail('range')
  return { ok: true, value: round2(neg ? -x : x) }
}
