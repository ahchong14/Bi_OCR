/**
 * 从 OCR 文字里直接提取收据字段(不用大模型)。
 * 总额、付款、日期的规则是 kaggle_receipt_workflow.py 里同名函数的 TypeScript 版,两边用同样的真实样本约束。
 *
 * 原则: 宁可留空,也不猜。读不准的字段留给人工,而不是塞一个看起来合理的值。
 * 状态只有两种: 能用算术互相印证的 → AUTO_VERIFIED;其余一律 REVIEW(只有一个识别来源,没有第二个意见)。
 */
import { reconcile, type ReconResult } from '../../shared/reconcile'
import type { PipelineStatus, ReceiptData } from '../../shared/types'

export interface Extraction { data: ReceiptData; status: PipelineStatus; reasons: string[]; regexTotal: number | null }

// ---------------------------------------------------------------- 文字清理与金额
/** 有的 OCR 会在小数点后插空格('39. 90'),不处理会被读成 39 和 90。只合并"数字 . 空格 恰好两位数字"。 */
export const fixSpacedDecimals = (t: string) => t.replace(/(\d)([.,])[ \t]+(\d{2})(?!\d)/g, '$1$2$3')

/** 带小数的金额文本 → 数字(只处理正则抓出来的 d.dd / d,dd / 1,234.56 / 1.234,56 这几种)。 */
export function amountOf(s: string): number | null {
  let t = s.replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '')
  if (!t) return null
  if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '') // 千分位
  else if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  else if (t.includes(',')) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '')
  const x = Number(t)
  return Number.isFinite(x) ? x : null
}

const SKIP = String.raw`(?:[^\d\n]|\d+(?:[.,]\d+)?\s*%)` // 跳过非数字字符,以及 '6%' 这样的百分比(GST@6%)
const AMT2 = String.raw`${SKIP}{0,30}?(\d[\d.,]*[.,]\d{2})(?![\d%])`
const T1 = String.raw`total\s*(?:amt\.?|amount)?\s*\(?\s*rounded\s*\)?|rounded\s+(?:total|amount)|grand\s+total|total\s+payable|amount\s+payable|amount\s+due|amt\.?\s+due|balance\s+due|net\s+total|jumlah\s+bayaran|total\s+after\s+rounding|final\s+total`
const T2 = String.raw`(?:total[^\n\d]{0,20}?incl(?:usive|\.)?|total\s*\([^)\n]{0,14}incl[^)\n]{0,6}\))`
const EN = String.raw`grand\s+total|total\s+payable|total\s+due|amount\s+due|amt\.?\s+due|balance\s+due|net\s+total|total\s+amount|amount\s+payable|total|jumlah(?:\s+bayaran)?|gesamt|summe|montant`
const ZH = '总计|合计|总额|应付|應付|合計|總計'
const EXCL = String.raw`(?!\s*\(?\s*(?:tax|item|qty|quantity|count|discount|saving|savings|paid|excl|before|gst\s*(?:summary|amt)|sst|vat))`
// 「Sub Total」「TAX TOTAL: 0.69」「GST TOTAL」不是应付总额(前面是 sub / tax / gst / sst 的 Total 跳过)
const NOSUB = String.raw`(?<!sub )(?<!sub-)(?<!tax )(?<!gst )(?<!sst )(?<!accepted )`
const TIERS = [
  new RegExp(`${NOSUB}\\b(?:${T1})\\b${AMT2}`, 'gi'), // 舍入后应付
  new RegExp(`${NOSUB}\\b(?:${T2})${AMT2}`, 'gi'), // 含税总额
  new RegExp(`${NOSUB}(?:\\b(?:${EN})\\b|(?:${ZH}))${EXCL}${AMT2}`, 'gi'), // 普通 Total
]

/** 不靠模型从文字找应付总额: 舍入后总额 > 含税总额 > 普通 Total,每层取最后一个(GST 汇总表里也有一个不含舍入的 Total)。 */
const SUMMARY_HEAD = /\b(?:gst|sst|tax|vat)\s*(?:summary|analysis|breakdown)\b/i
export function regexTotal(text: string): number | null {
  const full = fixSpacedDecimals(text)
  // 「GST Summary」表之后的 Total 是税基汇总(不含舍入、可能只是某个税率),不是应付总额: 先只看汇总表之前的文字,那里找不到才看全文
  const cut = full.search(SUMMARY_HEAD)
  for (const t of cut > 0 ? [full.slice(0, cut), full] : [full]) {
    for (const rx of TIERS) {
      const vals = [...t.matchAll(rx)].map((m) => amountOf(m[1]!)).filter((v): v is number => v !== null)
      if (vals.length) return vals[vals.length - 1]!
    }
  }
  return null
}

// 付款方式行: 「CASH RM 50.00」「VISA 27.00」「TNG E-WALLET 27.00」。发票上的付款方式那一行金额就是实付,模型有时没把它读进 amount_paid。
// 现金/卡/电子钱包都算;「CASH SALE」「CASHIER」「Card No」这类不是付款行的写法排除。
const PAY_METHOD = String.raw`accepted\s+total|cash(?!\s+(?:sales?|bill|invoice|receipt|register|memo|counter|discount))|tunai|tendered|amount\s+paid|total\s+paid|paid|payment|bayaran|visa|master\s*card|master|amex|american\s+express|jcb|union\s*pay|debit(?:\s*card)?|credit(?:\s*card)?|card(?!\s*(?:no|number|disc|point|member))|e-?\s*wallet|touch\s*['’]?\s*n\s*go|tng|grab\s*pay|boost|duit\s*now|shopee\s*pay|big\s*pay|qr(?:\s*pay)?|online\s+banking|fpx|cheque`
const PAYLINE = new RegExp(String.raw`(?<![A-Za-z])(${PAY_METHOD})\b(?!\s*back)[^\d\n]{0,25}(\d[\d.,]*[.,]\d{2})(?![\d%])`, 'gi')
const CHANGE = /\b(?:change(?:\s+due|\s+amt|\s+amount)?|baki|kembali)\b[^\d\n]{0,25}(\d[\d.,]*[.,]\d{2})(?![\d%])/gi
const last = (t: string, rx: RegExp) => { const v = [...t.matchAll(rx)].map((m) => amountOf(m[1]!)).filter((x): x is number => x !== null); return v.length ? v[v.length - 1]! : null }

/**
 * 从整页文字里取实付和找零。付款行可能有好几行(现金 20 + 刷卡 10),同一行也可能重复出现(付款明细里又印一遍),所以:
 *  - 相同的「付款方式 + 金额」只算一次(不会因为印了两遍就翻倍);
 *  - 候选实付 = 最后一行 / 所有行相加 / 最大的一行,哪个满足「实付 − 找零 ≈ 总额」就用哪个;知道不了总额就用最后一行。
 * methods 是出现过的付款方式(原文大写),以后放进商家详情。
 */
export function paymentFromText(raw: string, total: number | null): { paid: number | null; change: number | null; methods: string[] } {
  const t = fixSpacedDecimals(raw ?? '')
  const seen = new Set<string>()
  const lines: { method: string; amount: number }[] = []
  for (const m of t.matchAll(PAYLINE)) {
    const v = amountOf(m[2]!)
    if (v === null || v <= 0) continue
    const method = m[1]!.replace(/\s+/g, ' ').trim().toUpperCase()
    const key = `${method}:${v}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({ method, amount: v })
  }
  const change = last(t, CHANGE)
  if (!lines.length) return { paid: null, change, methods: [] }
  const r2 = (n: number) => Math.round(n * 100) / 100
  const lastAmt = lines[lines.length - 1]!.amount
  const cands = [...new Set([lastAmt, r2(lines.reduce((a, l) => a + l.amount, 0)), Math.max(...lines.map((l) => l.amount))])]
  const fit = total === null ? undefined : cands.find((c) => Math.abs(c - (change ?? 0) - total) <= 0.036)
  return { paid: fit ?? lastAmt, change, methods: [...new Set(lines.map((l) => l.method))] }
}
export const regexPayment = (text: string, total: number | null = null) => { const { paid, change } = paymentFromText(text, total); return { paid, change } }

// ---------------------------------------------------------------- 其他金额字段(每个只取一个明确的标签,取不到就留空)
const labeled = (t: string, label: string, exclude = '') => last(t, new RegExp(`(?<![A-Za-z])(?:${label})\\b${exclude}${AMT2}`, 'gi'))
const SUBTOTAL = String.raw`sub\s*-?\s*total|total\s+sales\s*\(?\s*excl[^\n\d]{0,12}|total\s+\(?excl[^\n\d]{0,12}|net\s+amount|amount\s+excl[^\n\d]{0,12}`
// 税额标签: 不能是「Total Sales Incl. GST 39.90」「Total 6% supplies (Inc. GST)」这类含税合计行
const TAX = String.raw`(?<!incl\. )(?<!incl )(?<!inc\. )(?<!inc )(?<!inclusive )(?<!excl\. )(?<!excl )(?<!excluding )(?:total\s+gst|gst\s+payable|gst\s+amount|tax\s+amt|tax\s+amount|gst|sst|service\s+tax|vat)`
/** 一个标签可能在好几行出现(汇总表里有 6% 行和 0% 行): 取第一个"可能是税额"的数,即大于 0 且不超过总额 30%。 */
function taxOf(t: string, total: number | null): number | null {
  const rx = new RegExp(String.raw`(?<![A-Za-z])(?:${TAX})\b(?!\s*(?:id|reg|no\b|summary))${AMT2}`, 'gi')
  for (const m of t.matchAll(rx)) {
    const v = amountOf(m[1]!)
    if (v !== null && v > 0 && (total === null || v <= total * 0.3)) return v
  }
  return null
}
const ROUNDING = String.raw`rounding(?:\s+adj(?:ustment)?\.?)?|round\s*adj|rounding\s+amt`

function roundingOf(t: string): number | null {
  const m = [...t.matchAll(new RegExp(`(?<![A-Za-z])(?<!after\\s+)(?:${ROUNDING})\\b[^\\d\\n-]{0,15}(-?)\\s*(\\d+[.,]\\d{2})(?![\\d%])`, 'gi'))].pop()
  if (!m) return null
  const v = amountOf(m[2]!)
  return v === null ? null : m[1] ? -v : v
}

// ---------------------------------------------------------------- 日期
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const real = (y: number, m: number, d: number) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d }
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** 文字里第一个像样的日期。日/月顺序有歧义时按「日在前」理解(东南亚小票最常见),并标记 ambiguous。 */
export function findDate(text: string): { iso: string; ambiguous: boolean } | null {
  const cands: { idx: number; iso: string; ambiguous: boolean }[] = []
  for (const m of text.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) if (real(+m[1]!, +m[2]!, +m[3]!)) cands.push({ idx: m.index!, iso: iso(+m[1]!, +m[2]!, +m[3]!), ambiguous: false })
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g)) {
    const a = +m[1]!, b = +m[2]!, y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!
    if (b > 12 && a <= 12 && real(y, a, b)) cands.push({ idx: m.index!, iso: iso(y, a, b), ambiguous: false }) // 第二位 >12 只能是 月/日
    else if (real(y, b, a)) cands.push({ idx: m.index!, iso: iso(y, b, a), ambiguous: a <= 12 && a !== b })
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[\s-]*([A-Za-z]{3,9})\.?,?[\s-]*(\d{4}|\d{2})(?!\d)/g)) {
    const mo = MON[m[2]!.slice(0, 3).toLowerCase()]
    const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!
    if (mo && real(y, mo, +m[1]!)) cands.push({ idx: m.index!, iso: iso(y, mo, +m[1]!), ambiguous: false })
  }
  for (const m of text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/g)) {
    const mo = MON[m[1]!.slice(0, 3).toLowerCase()]
    if (mo && real(+m[3]!, mo, +m[2]!)) cands.push({ idx: m.index!, iso: iso(+m[3]!, mo, +m[2]!), ambiguous: false })
  }
  const thisYear = new Date().getUTCFullYear()
  const sane = cands.filter((c) => +c.iso.slice(0, 4) >= 2000 && +c.iso.slice(0, 4) <= thisYear + 1).sort((a, b) => a.idx - b.idx)
  const best = sane[0]
  return best ? { iso: best.iso, ambiguous: best.ambiguous } : null
}

// ---------------------------------------------------------------- 商家 / 币种
const NOT_MERCHANT = /\b(?:your|order|number|thank|welcome|please)\b|tax\s+invoice|^\s*invoice|receipt|cash\s+bill|\btel\b|\bfax\b|gst|\breg\b|company\s+no|www\.|http|@|^\s*(?:no|date|time|doc|inv|order|table|cashier)\b|^\W*\d/i
const COMPANY = /\b(?:sdn\.?\s*bhd|bhd|berhad|pte|ltd|plt|enterprise|trading|restaurant|cafe|store|mart|shop|market|bakery|bakeries|hardware|pharmacy|supermarket)\b/i

/** 公司法律后缀(明确是公司全名的结尾)。Shop/Store/Mart 这类只是店名里的词,不算。 */
const STRONG = /\b(?:sdn\.?\s*bhd|bhd|berhad|pte\.?\s*ltd|ltd|plt|inc|corp)\b\.?/i

/** 整理成「公司名」: 去掉注册号括号 (139386 X) / (126926-H) / (95874),以及公司后缀之后的杂字(手写、编号)。
 *  用标准答案核对发现这两类最常把相似度拉低,而它们本来就不属于公司名。 */
export function tidyName(line: string): string {
  let s = line.replace(/\(\s*(?:\d[\d\s-]*[A-Za-z]?|[A-Za-z]-?\d[\d\s-]*)\s*\)/g, ' ')
  const m = STRONG.exec(s)
  if (m) s = s.slice(0, m.index + m[0].length)
  return s.replace(/\s{2,}/g, ' ').trim()
}

export function guessMerchant(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t+/g, ' ').replace(/[�]/g, '').trim()).filter(Boolean).slice(0, 14)
  const ok = lines.filter((l) => (l.match(/[A-Za-z一-龥]/g) ?? []).length >= 3 && !NOT_MERCHANT.test(l) && (l.match(/\d/g) ?? []).length <= l.length / 3)
  // 第一行本身就是带公司后缀的全名 → 用它;否则在前几行里找带后缀的;都没有再退回第一行(店名)
  const strong = STRONG.test(ok[0] ?? '') ? ok[0] : ok.slice(0, 8).find((l) => STRONG.test(l))
  if (strong) {
    const letters = strong.replace(STRONG, '').replace(/[^A-Za-z一-龥]/g, '')
    const i = ok.indexOf(strong)
    if (letters.length < 3 && i > 0) return tidyName(`${ok[i - 1]} ${strong}`) // 'Sdn Bhd' 单独一行: 和上一行合起来才是公司名
    return tidyName(strong)
  }
  const weak = ok.find((l) => COMPANY.test(l))
  return ok[0] ? tidyName(ok[0]) : weak ? tidyName(weak) : null
}

/** OCR 读乱的商家名通常有这些特征: 大写词里夹小写(FRwOnL)、字母数字混在一起(T33L)、写成 SDN 却不是 SDN BHD(IBHC)。有这些就别当成"已确认"。 */

export function merchantLooksNoisy(m: string): boolean {
  if (/\b[A-Z]+[a-z][A-Z][A-Za-z]*\b/.test(m)) return true // 大写词里夹小写: FRwOnL
  if (/\b(?=\w*\d)(?=\w*[A-Za-z])\w{3,}\b/.test(m.replace(/\(.*?\)/g, ''))) return true // 字母数字混在一起: T33L
  if (/\bsdn\b/i.test(m) && !/\bsdn\.?\s*bhd\b/i.test(m)) return true // SDN IBHC
  if (/[a-z]/.test(m) && !/[A-Z]/.test(m)) return true // 全是小写(tealive):多半是 Logo 文字或口号,不是登记的商家名
  // 商家栏里混进了地址(邮编、路名、过长): "SOON FATT S/B (81497-P) LUT 1504, BATU 8 1/2, JALAN KLANG LAMA, 46000 PETALING JAYA" —— 名字没取干净,不能自动通过
  if (/\b\d{5}\b/.test(m.replace(/\(.*?\)/g, '')) || /\b(?:JALAN|JLN|LORONG|LRG|TAMAN|LEBUH|PERSIARAN)\b/i.test(m) || m.length > 60) return true
  return m.replace(/[^A-Za-z一-龥]/g, '').length < 4
}

export function guessCurrency(text: string): string | null {
  if (/\bRM\s?\d|\bMYR\b|\bRM\b/i.test(text)) return 'MYR'
  if (/\bS\$|\bSGD\b/i.test(text)) return 'SGD'
  if (/\bUSD\b|US\$/i.test(text)) return 'USD'
  if (/\bRp\.?\s?\d|\bIDR\b/i.test(text)) return 'IDR'
  if (/฿|\bTHB\b/i.test(text)) return 'THB'
  if (/\bGBP\b|£/i.test(text)) return 'GBP'
  if (/\bEUR\b|€/i.test(text)) return 'EUR'
  if (/\bCNY\b|\bRMB\b|¥|￥|元/i.test(text)) return 'CNY'
  if (/\bsdn\.?\s*bhd\b|\bGST\s*(?:ID|REG)/i.test(text)) return 'MYR' // 马来西亚公司后缀 / GST 登记号
  return null
}

// ---------------------------------------------------------------- 商品行(只在合计能对上时才采用)
const ITEM_SKIP = /total|sub\s*-?\s*total|gst|sst|tax|cash|change|round|visa|master|amount|discount|service|balance|due|summary|qty|item\s*count|sales|paid|payment|tender|card|ref\b|date|inv\b|tel\b|fax|thank|point|voucher|bayaran|jumlah|tunai|baki/i
function itemsOf(text: string): { name: string; qty: number | null; price: number | null }[] {
  const out: { name: string; qty: number | null; price: number | null }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t+/g, '  ').trim()
    const m = /^(?:(\d{1,3})\s+)?([A-Za-z][^\d]{1,}?[A-Za-z0-9)\]]?)(?:\s+@?\s*\d+[.,]\d{2})?\s{1,}(-?\d{1,6}[.,]\d{2})\s*[A-Za-z]{0,2}$/.exec(line)
    if (!m || ITEM_SKIP.test(m[2]!)) continue
    const price = amountOf(m[3]!)
    if (price === null) continue
    out.push({ name: m[2]!.trim(), qty: m[1] ? Number(m[1]) : null, price: m[1] && Number(m[1]) > 1 ? price : price })
  }
  return out
}

// ---------------------------------------------------------------- 分流
/**
 * 字段是否齐全、算术能否互相印证 → 状态(AUTO_VERIFIED 或 REVIEW),并把原因代码追加到 reasons。
 * 规则提取(extractFromText)和模型直接读字段(structured.ts)共用它,保证两条路用同一把尺子。
 * 只有一个识别来源,没有第二个意见,所以永远不给 AUTO(最高档)。
 */
/** 日期一律「日在前」的地区(马来西亚、新加坡、印尼)。这些地区的小票 12/10/2017 只会是 12 号 10 月,日/月歧义不构成风险。
 *  评测集 41 张被标「日/月有歧义」的票,40 张日期读对、0 张是日月颠倒(另 1 张没有标准答案);所以这里不再拦。
 *  币种未知或是美元等月在前的地区,歧义仍然交给人工。 */
const DAY_FIRST_CURRENCIES = new Set(['MYR', 'SGD', 'IDR'])
const MONTH_FIRST_CURRENCIES = new Set(['USD', 'CAD', 'PHP'])

/** 模型常把税码(SR/ZR)读进币种栏,币种就丢了。整页文字里有 RM/MYR、SDN BHD、GST 登记号、马来西亚地名,也认为是日在前的地区。 */
export function textIsDayFirst(text: string): boolean {
  const cur = guessCurrency(text)
  return (cur !== null && DAY_FIRST_CURRENCIES.has(cur)) || /\bSDN\.?\s*BHD\b|\bGST\s*(?:ID|REG)|\bMALAYSIA\b|\bSELANGOR\b|\bKUALA\s+LUMPUR\b/i.test(text)
}

/** 分流开关(评测用:关掉就是旧行为,方便对比)。 */
export const triageOpts = { relaxDetail: true }

export function triage(d: ReceiptData, recon: ReconResult, dateIn: { ambiguous: boolean } | null, reasons: string[], dayFirstHint = false): PipelineStatus {
  const { merchant, total } = d
  // 日期歧义在「日在前」地区降级为提示(info),不影响状态
  // 明确读到美元等月在前的币种时,文字里的 SDN BHD 之类线索不能推翻它
  const dayFirst = dateIn?.ambiguous === true && !(d.currency !== null && MONTH_FIRST_CURRENCIES.has(d.currency))
    && ((d.currency !== null && DAY_FIRST_CURRENCIES.has(d.currency)) || dayFirstHint)
  const date = dateIn && dayFirst ? { ...dateIn, ambiguous: false } : dateIn
  if (merchant === null) reasons.push('missing_merchant')
  if (date === null) reasons.push('missing_date')
  else if (dayFirst) reasons.push('date_day_first_assumed')
  else if (date.ambiguous) reasons.push('date_day_month_swapped')
  if (total === null) reasons.push('missing_total')
  for (const f of recon.flags) reasons.push(f)

  // 互相印证: 付款−找零=总额,或 小计+税(+舍入)=总额。只有一个识别来源时,这是我们能拿到的最强"第二意见"
  const paymentOk = recon.checks.some((c) => c.id === 'payment_vs_total' && c.status === 'ok')
  const formulaOk = recon.checks.some((c) => c.id === 'total_formula' && c.status === 'ok') && d.subtotal !== null
  const paidEqualsTotal = total !== null && d.paid !== null && Math.abs(d.paid - total) <= 0.011 && (d.change === null || d.change === 0) // 刷卡: 付款额=总额且没有找零
  const corroborated = total !== null && (paymentOk || formulaOk || paidEqualsTotal)
  const noisy = merchant !== null && merchantLooksNoisy(merchant)
  if (noisy) reasons.push('merchant_unsure')
  const complete = merchant !== null && !noisy && date !== null && total !== null && !date.ambiguous
  // 「总额已经被付款独立印证」时,明细(小计 / 税额 / 商品行)对不上不再算硬伤:
  // 付款 − 找零 = 总额 是和「小计+税=总额」「商品合计=小计」完全独立的一条证据,
  // 总额有它佐证,那两条算不平说明的是小计 / 税额 / 商品行读错了,不是总额错。
  // 这样放行的收据会带 detail_unverified 提示(信息类,不拦),明细字段仍要核对;不想放行就把 triageOpts.relaxDetail 关掉。
  const DETAIL = new Set(['total_formula', 'items_vs_subtotal'])
  const failed = recon.checks.filter((c) => c.status === 'fail')
  const detailOnly = failed.length > 0 && failed.every((c) => DETAIL.has(c.id))
  // 付款证据必须是模型自己读到的:从文字里补出来的付款 / 找零(paid_from_text / change_from_text)可能只是把付款额抄成了总额
  // (现金收据 CASH 28.00 被当成总额,真总额 27.90),不够独立,不放行。
  // 折扣 / 服务费 / 舍入 / 小费 / 其他费 里有数时不放行: 这些是模型最容易串位的字段(把进位填进服务费、把合计填进舍入),它们一动,「对不上」就可能是它们读错了
  const extrasQuiet = [d.discount, d.service_charge, d.rounding, d.tip, d.fees].every((x) => x === null || Math.abs(x) < 0.005)
  const relaxed = triageOpts.relaxDetail && detailOnly && total !== null && (paymentOk || paidEqualsTotal) && !reasons.includes('paid_from_text') && !reasons.includes('change_from_text') && extrasQuiet
  if (relaxed) reasons.push('detail_unverified')
  const hard = (recon.hasFail && !relaxed) || reasons.includes('ocr_too_little_text')
  const warned = recon.checks.some((c) => c.status === 'warn') // 舍入过大、税额大于小计、日期与税制矛盾…不是算不平,但同样说明有字段读错了,不能放行
  if (complete && corroborated && !hard && !warned) return 'AUTO_VERIFIED'
  if (complete && !hard) reasons.push('single_ocr_unverified') // 字段齐了但没有算术印证
  return 'REVIEW'
}

// ---------------------------------------------------------------- 总入口
const clean = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)

export function extractFromText(rawText: string): Extraction {
  const text = fixSpacedDecimals(rawText ?? '')
  const reasons: string[] = ['scanned_in_portal']
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 3 || (text.match(/\d/g) ?? []).length < 4) reasons.push('ocr_too_little_text')

  const total = regexTotal(text)
  const { paid, change } = regexPayment(text, total)
  const date = findDate(text)
  const merchant = guessMerchant(text)
  const currency = guessCurrency(text)
  let subtotal = labeled(text, SUBTOTAL)
  let tax = taxOf(text, total)
  // 「Total After Rounding 39.90」是舍入后的总额,不是舍入金额。金额恰好等于总额的一定是读串了行
  const rawRounding = roundingOf(text)
  const rounding = rawRounding !== null && total !== null && Math.abs(Math.abs(rawRounding) - total) < 0.005 ? null : rawRounding
  const discount = labeled(text, 'discount|disc|diskaun')
  const service = labeled(text, 'service\\s+charge|svc\\s*chg|s\\.?\\s*charge')

  const base = (): ReceiptData => ({ merchant, date: date?.iso ?? null, currency, subtotal, discount, service_charge: service, tax, tip: null, fees: null, rounding, total, paid, change, items: [] })
  const check = (d: ReceiptData): ReconResult => reconcile({ ...d })

  // 税额和小计是"带标签的猜测": 对不上总额公式时,先试着去掉它们,哪个说得通留哪个
  let d = base()
  let recon = check(d)
  if (recon.hasFail) {
    for (const drop of ['tax', 'subtotal', 'both'] as const) {
      const t = { ...d, tax: drop === 'subtotal' ? d.tax : null, subtotal: drop === 'tax' ? d.subtotal : null }
      const r = check(t)
      if (!r.hasFail) { d = t; recon = r; tax = t.tax; subtotal = t.subtotal; break }
    }
  }

  // 商品行: 只有合计能对上小计/总额才采用(宁缺毋滥)
  const items = itemsOf(text)
  if (items.length) {
    const withItems = { ...d, items }
    const r = check(withItems)
    const itemsFail = r.checks.some((c) => c.id === 'items_vs_subtotal' && c.status === 'fail')
    const itemsOk = r.checks.some((c) => c.id === 'items_vs_subtotal' && c.status === 'ok')
    if (itemsOk && !itemsFail) { d = withItems; recon = r }
    else reasons.push('items_not_extracted')
  } else reasons.push('items_not_extracted')

  const status = triage(d, recon, date, reasons)

  d = { ...d, total: clean(d.total), subtotal: clean(d.subtotal), tax: clean(d.tax), paid: clean(d.paid), change: clean(d.change), rounding: clean(d.rounding), discount: clean(d.discount), service_charge: clean(d.service_charge) }
  return { data: d, status, reasons: [...new Set(reasons)], regexTotal: total }
}
