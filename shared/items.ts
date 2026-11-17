/**
 * 模型对"商品明细"的回答的解析。服务端(minicpm.ts)和审核页(ReviewPage.tsx)共用同一份,
 * 这样审核页的"明细表格"看到的行,和服务端入库的行是同一套解析规则,不会出现两边读出不一样的情况。
 */

/** JSON.parse 失败时的兜底。模型常把商品名里的英寸符号 " 直接写进字符串而不转义(如 6"HT),
 *  整段 JSON 就非法了,所有明细都丢。这里按"一个商品一个对象"逐个抓,只认约定的 4 个键(amount 后面多出来的键忽略);
 *  数量/单价/金额不管模型写成带引号的字符串还是裸数字都能读。 */
import { parseAmount } from './amount'

/** 数量: 数字原样;'2x' / '2 pcs' 这类取开头的数字;读不出来(如 '1K'、'1.36K' 这种带重量单位的)就是 null,不猜。 */
export function qtyNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = /^\s*(\d{1,4}(?:\.\d{1,3})?)\s*(?:x|pcs?|units?)?\s*$/i.exec(v)
  return m ? Number(m[1]) : null
}

const CURRENCY_WORDS = new Set(['RM', 'MYR', 'SGD', 'USD', 'BND', 'EUR', 'GBP', 'JPY', 'CNY', 'IDR', 'THB'])

/** 金额格里常带着税码: "2.30 T"、"29.90 Z"、"5.00 SR"。拆成数字和税码(币种写法 RM / MYR 不算税码)。读不懂的当没有,不抛错。 */
export function amountWithCode(v: unknown): { value: number | null; code: string | null } {
  if (v === null || v === undefined || v === '' || v === '###') return { value: null, code: null }
  let x: unknown = typeof v === 'string' ? v.trim() : v
  let code: string | null = null
  if (typeof x === 'string') {
    const m = /^(.*\d)\s*([A-Za-z]{1,3})$/.exec(x)
    if (m && !CURRENCY_WORDS.has(m[2]!.toUpperCase())) { x = m[1]!; code = m[2]!.toUpperCase() }
  }
  const p = parseAmount(x)
  return { value: p.ok ? p.value : null, code }
}

/** ocrText 里的「整页转写」段([full text])。没有就是空串。 */
export function fullTextOf(ocrText: string): string {
  return /(?:^|\n)\[full text\]\n([\s\S]*?)(?=\n\n\[[a-z]|$)/.exec(ocrText ?? '')?.[1] ?? ''
}

/** 整页转写里出现过的所有金额(以分为单位的整数)。用来给「算出的金额 / 模型读到的金额」做独立的佐证: 真的金额一定印在票上。 */
export function amountSet(text: string): Set<number> {
  const out = new Set<number>()
  for (const m of (text ?? '').replace(/(\d)\.\s+(\d{2})(?!\d)/g, '$1.$2').matchAll(/\d[\d.,]*[.,]\d{2}(?!\d)/g)) {
    const p = parseAmount(m[0])
    if (p.ok && p.value !== null) out.add(Math.round(Math.abs(p.value) * 100))
  }
  return out
}

/**
 * 商品区里出现过的金额: 整页转写里「第一个合计行(Total / Sub Total / Item Count / GST Summary …)」之前的部分。
 * 比整张票的金额集合更适合当佐证 —— 否则找零 10.00、实付之类恰好和某个算错的金额相同,就会被当成「印在票上」。
 * 前面没有商品区(第一行就是合计)就退回整张票。
 */
export function itemAmountSet(text: string): Set<number> {
  const lines = (text ?? '').split(/\r?\n/)
  const stop = lines.findIndex((l) => /^\s*(?:sub\s*-?\s*total|total\b|grand\s+total|item\s+count|gst\s+summary|amount\s+due)/i.test(l))
  const region = stop > 0 ? lines.slice(0, stop).join('\n') : (text ?? '')
  const got = amountSet(region)
  return got.size ? got : amountSet(text)
}

export interface LineAmount {
  /** 这一行的金额(票上印的那个口径: 折扣前,折扣另算)。 */
  value: number | null
  /** true = 这个值是用 数量 × 单价 算出来的(模型没读到金额,或读到的和算出的对不上);false = 就是模型读到的金额。 */
  computed: boolean
  /** 模型自己读到的金额(已去掉税码)。 */
  read: number | null
  /** 数量 × 单价(折扣前)。算不出来是 null。 */
  gross: number | null
  /** 读到的金额和 数量 × 单价(折扣前 / 折扣后都不一样)对不上,或金额在整页转写里找不到:多半数量、单价或金额读错了,界面要提示。 */
  conflict: boolean
  /** 金额和 数量 × 单价 一致,但整页转写里没有这个金额、单价却有 → 数量多半读错了(例如整张票都读成 2pc)。conflict 同时为 true。 */
  unseen: boolean
  /** 金额后面跟着的税码(T / Z / SR…),没有是 null。 */
  code: string | null
}

/**
 * 一行商品的金额。模型读「金额」一栏不稳(常读成单价、读错位),而「数量 × 单价」是算术,所以让算术说话:
 *  - 读到的金额和 数量 × 单价(折扣前或折扣后)一致 → 就是读到的(保留票上印的口径,不会因为折扣被改掉);
 *  - 没读到金额 → 用 数量 × 单价 算;
 *  - 对不上(conflict)→ 看整页转写(evidence,出现过的金额集合):只有一个出现在票上,就用它;都出现或都没出现 → 用算出来的。
 *  - 数量读不成数字(如 '1K')或没有单价 → 算不了,用读到的金额,再没有退到单价。
 * 全程不抛错,读不懂的当没有。
 */
export function lineAmount(r: { quantity?: unknown; unit_price?: unknown; amount?: unknown; discount?: unknown }, evidence?: ReadonlySet<number>): LineAmount {
  const n = (v: unknown) => { if (v === null || v === undefined || v === '' || v === '###') return null; const p = parseAmount(v); return p.ok ? p.value : null }
  const r2 = (x: number) => Math.round(x * 100) / 100
  const q = qtyNumber(r.quantity), u = n(r.unit_price)
  const { value: read, code } = amountWithCode(r.amount)
  if (q !== null && q > 0 && u !== null) {
    const gross = r2(q * u), net = r2(gross - Math.abs(n(r.discount) ?? 0))
    const has = (x: number) => !!evidence && evidence.has(Math.round(Math.abs(x) * 100))
    if (read === null) return { value: gross, computed: true, read, gross, conflict: false, unseen: false, code }
    if (Math.abs(read - gross) <= 0.02 || Math.abs(read - net) <= 0.02) {
      // 一致,但转写里没有这个金额而有单价: 数量(和跟着数量算出来的金额)多半读错了
      const unseen = !!evidence && evidence.size > 0 && !has(read) && has(u) && q !== 1
      return { value: read, computed: false, read, gross, conflict: unseen, unseen, code }
    }
    // 含税价: 票上「单价」一栏是不含税价、「金额」一栏是含税价(65.00 → 68.90 = ×1.06),金额 = 数量 × 单价 × (1 + 税率) 也是一致的
    if ([0.06, 0.08, 0.1].some((t) => Math.abs(read - r2(gross * (1 + t))) <= 0.02 || Math.abs(read - r2(net * (1 + t))) <= 0.02)) {
      return { value: read, computed: false, read, gross, conflict: false, unseen: false, code }
    }
    if (evidence && has(read) && !has(gross) && !has(net)) return { value: read, computed: false, read, gross, conflict: true, unseen: false, code }
    return { value: gross, computed: true, read, gross, conflict: true, unseen: false, code }
  }
  return { value: read ?? u, computed: false, read, gross: null, conflict: false, unseen: false, code }
}

/** 模型写的「这一行的税」→ 税率(百分比)。只认两种写法: 带百分号或纯数字(6%、SR 6%、6),以及明确的零税率代码(Z、ZRL、ES、OS…)。
 *  SR、S、T 这类只有字母的代码不猜: 它对应多少要看收据底部的税率汇总,猜错比不填更糟。认不出来返回 null。 */
export function rateOf(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= 30 ? Math.round(raw * 100) / 100 : null
  const s = String(raw).trim().toUpperCase()
  if (!s || s === '###') return null
  const m = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(s) ?? /^(\d{1,2}(?:\.\d{1,2})?)$/.exec(s)
  if (m) { const v = Number(m[1]); return v <= 30 ? v : null }
  return /^(?:Z|ZR|ZRL|ZRE|ZRM|ES|EX|OS|NT|EXEMPT|ZERO)$/.test(s.replace(/[^A-Z]/g, '')) ? 0 : null
}

export function salvageLineItems(s: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  // amount 后面可以跟 uom / discount(明细加详情的提示词会多问这两项),有就一起抢救,没有也照样匹配
  const re = /\{\s*"description"\s*:\s*"([\s\S]*?)"\s*,\s*"quantity"\s*:\s*"?([^"\n]*?)"?\s*,\s*"unit_price"\s*:\s*"?([^"\n]*?)"?\s*,\s*"amount"\s*:\s*"?([^"\n]*?)"?\s*(?:,\s*"uom"\s*:\s*"?([^"\n]*?)"?\s*)?(?:,\s*"discount"\s*:\s*"?([^"\n]*?)"?\s*)?(?:,\s*"tax"\s*:\s*"?([^"\n]*?)"?\s*)?(?:,[^}]*)?\}/g
  for (const m of s.matchAll(re)) out.push({ description: m[1], quantity: m[2], unit_price: m[3], amount: m[4], ...(m[5] !== undefined ? { uom: m[5] } : {}), ...(m[6] !== undefined ? { discount: m[6] } : {}), ...(m[7] !== undefined ? { tax: m[7] } : {}) })
  return out
}

/** 解析重扫(ITEMS_RETRY_PROMPT)的回复: 每行 `描述 | 数量 | 单价 | 金额`。少于 2 列、或表头行(description | quantity …)跳过。 */
export function parseItemLines(s: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of s.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
    if (!line.includes('|')) continue
    const c = line.split('|').map((x) => x.trim())
    if (c.length < 2 || /^description$/i.test(c[0] ?? '')) continue
    const [description = '', quantity = '###', unit_price = '###', amount = '###'] = c
    if (description) out.push({ description, quantity, unit_price, amount })
  }
  return out
}

/** 审核页"明细表格"的一行。全是文字: 模型写什么就显示什么,要不要采用、怎么换算由审核员决定。 */
export interface ModelItemRow { description: string; quantity: string; unit_price: string; amount: string; uom?: string; discount?: string; tax?: string }
const cell = (v: unknown): string => (v === null || v === undefined || v === '###' ? '' : String(v))
export const toRows = (a: Record<string, unknown>[]): ModelItemRow[] =>
  a.map((o) => ({ description: cell(o.description ?? o.name), quantity: cell(o.quantity ?? o.qty), unit_price: cell(o.unit_price ?? o.price), amount: cell(o.amount), uom: cell(o.uom ?? o.unit), discount: cell(o.discount), tax: cell(o.tax ?? o.tax_rate ?? o.taxRate) }))

/** 从审核页拿到的 ocrText 里(服务端拼成 `[line items]\n…\n\n[line items retry]\n…` 的样子)取出模型对商品明细的回答。
 *  顺序: 正常的 JSON → 坏 JSON 抢救 → 重扫的逐行文字。source 告诉界面这些行是怎么来的。 */
export function modelItemRows(ocrText: string, which: 'main' | 'second' = 'main'): { rows: ModelItemRow[]; source: 'json' | 'salvaged' | 'retry' | 'none' } {
  const section = (title: string) => new RegExp(`(?:^|\n)\\[${title}\\]\n([\\s\\S]*?)(?=\n\n\\[[a-z]|$)`).exec(ocrText)?.[1] ?? ''
  const body = section(which === 'second' ? 'second line items' : 'line items')
  const i = body.indexOf('{'), j = body.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      const v = (JSON.parse(body.slice(i, j + 1)) as { line_items?: unknown }).line_items
      if (Array.isArray(v)) return { rows: toRows(v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')), source: 'json' }
    } catch { /* 往下走: 抢救 */ }
  }
  const salvaged = salvageLineItems(body)
  if (salvaged.length) return { rows: toRows(salvaged), source: 'salvaged' }
  const retried = which === 'second' ? [] : parseItemLines(section('line items retry'))
  if (retried.length) return { rows: toRows(retried), source: 'retry' }
  return { rows: [], source: 'none' }
}

// ---------------------------------------------------------------- 从整页转写里补每一行的单位 / 折扣 / 税率
// 模型默认只问 4 项(商品、数量、单价、金额),单位、这一行的折扣、税码都印在转写里,不问模型也能读到:
//   「2pc × 1.15  2.30 T」→ 单位 pc、税码 T;  下一行「Member Discount -0.24」→ 这一行折扣 0.24;  底部「T @ 6%」→ 税码 T 就是 6%。
const UOM_RX = /^(?:pcs?|pkts?|packs?|boxe?s?|btls?|ctns?|sets?|units?|ea|kgs?|g|l|ml|doz|prs?)$/i
const DISC_LINE = /(?:discount|disc\b|diskaun|rebate|voucher|promo)/i
const STOP_LINE = /^\s*(?:sub\s*-?\s*total|total|grand|amount\s+due|cash|change|gst|sst|tax|rounding|item\s+count|payment)/i
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')

/** 转写底部的税率汇总: 「T @ 6%」「SR (@ 6%)」「Z @ 0%」→ { T: 6, SR: 6, Z: 0 }。 */
export function parseTaxCodes(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]{1,3})\s*[@(]?\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/.exec(line)
    if (m) out.set(m[1]!.toUpperCase(), Number(m[2]))
  }
  return out
}

/**
 * 把模型读的明细行补全: 单位(从数量后缀,如 2pc)、税率(从金额后的税码 + 底部税率汇总)、这一行的折扣(转写里紧跟在这个商品下面的 Discount 行)。
 * 模型已经读到的值不动;转写里找不到的不猜。服务端入库和审核页的明细表格共用,所以两边看到的一样。
 */
export function enrichRows(rows: ModelItemRow[], ocrText: string): ModelItemRow[] {
  const text = fullTextOf(ocrText)
  const lines = text ? text.split(/\r?\n/) : []
  const codes = parseTaxCodes(text)
  const nlines = lines.map(norm)
  return rows.map((r) => {
    const out = { ...r }
    if (!(out.uom ?? '').trim()) {
      const m = /^(\d+(?:[.,]\d+)?)\s*([A-Za-z]{1,5})$/.exec(out.quantity.trim())
      if (m && UOM_RX.test(m[2]!)) { out.uom = m[2]!.toLowerCase(); out.quantity = m[1]! }
    }
    if (!(out.tax ?? '').trim()) {
      const code = amountWithCode(out.amount).code ?? amountWithCode(out.unit_price).code
      if (code) { const rate = codes.get(code) ?? rateOf(code); if (rate !== null && rate !== undefined) out.tax = String(rate) }
    }
    if (!(out.discount ?? '').trim() && lines.length) {
      const key = norm(r.description).slice(0, 14)
      const at = key.length >= 5 ? nlines.findIndex((l) => l.includes(key)) : -1
      for (let k = at + 1; at >= 0 && k <= at + 4 && k < lines.length; k++) {
        const line = lines[k]!
        if (DISC_LINE.test(line)) {
          const amts = [...line.replace(/(\d)\.\s+(\d{2})(?!\d)/g, '$1.$2').matchAll(/\d[\d.,]*[.,]\d{2}(?!\d)/g)].map((m) => parseAmount(m[0]))
          const last = amts.length ? amts[amts.length - 1]! : null
          if (last && last.ok && last.value !== null && last.value !== 0) out.discount = Math.abs(last.value).toFixed(2)
          break
        }
        if (STOP_LINE.test(line)) break
        if (!/\d[.,]\d{2}/.test(line) && /[A-Za-z]{3,}/.test(line)) break // 没有金额、全是字: 下一个商品的名字,这一行的折扣行没有了
      }
    }
    return out
  })
}
