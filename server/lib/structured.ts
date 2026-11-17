/**
 * 结构化识别(模型直接读字段)的结果 → 门户的统一字段 + 分流状态 + 交叉验证。
 *
 * 和 extract.ts 的区别: 那边是从 OCR 文字里用规则"猜"字段;这边字段是模型按提示词读出来的,
 * 所以这里做四件事:
 *   1. 把模型的文字规整成门户的格式(日期、币种、金额、商品行);
 *   2. 用同一套对账算法检查,再用同一个 triage 分流;
 *   3. 交叉验证(有整页转写时): 模型读出的每个金额,必须能在另一次独立的"整页转写"里找到,
 *      否则按门户已有的原因代码标出来(total_not_in_text 等)——这是防止多模态模型"编造一个看似合理的数字"的关键;
 *   4. 把模型的原始回答、各阶段耗时、第二次读取的结果一并交给门户存下来并展示。
 *
 * 原则和 extract.ts 一致: 读不准的留空,不猜;模型的输出一律当作不可信文本,字段只做规整,不当指令。
 */
import { amountWithCode, enrichRows, itemAmountSet, lineAmount, qtyNumber as qtyOf, rateOf, toRows } from '../../shared/items'
import { normCurrency, reconcile, roundUnit } from '../../shared/reconcile'
import type { Correction, Item, ReceiptData, VerifierInfo } from '../../shared/types'
import { cleanData } from './clean'
import { amountOf, findDate, fixSpacedDecimals, guessCurrency, guessMerchant, paymentFromText, regexTotal, textIsDayFirst, triage, type Extraction } from './extract'
import type { AliasResolver } from './aliases'
import type { JevScore, StructuredOutput } from './ocr'

/** 提示词里约定的字段名。minicpm.ts 用它们拼提示词,下面按同样的键读结果。 */
export const CORE_FIELDS = ['merchant_name', 'date', 'currency', 'subtotal', 'tax_amount', 'total'] as const
export const EXTRA_FIELDS = ['discount_amount', 'service_charge_amount', 'rounding_adjustment', 'amount_paid', 'change_given'] as const

const MAX_TEXT = 200
const MAX_ITEMS = 200

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && (v.trim() === '' || v.trim() === '###'))
const val = (o: Record<string, unknown>, k: string): unknown => (blank(o[k]) ? null : o[k])
/** 文字字段: 去掉换行和多余空白,截断。模型输出是不可信文本,不信任长度和格式。 */
const text = (v: unknown): string | null => {
  if (blank(v) || typeof v === 'object') return null
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  return s || null
}

/** 把模型对明细的回答整理成商品行。每一行: 先用整页转写补上单位 / 这一行的折扣 / 税率(shared/items.ts 的 enrichRows),
 *  再定「这一行的金额」(lineAmount: 读到的金额和 数量 × 单价 对得上就用读到的,对不上看转写里哪个金额真的印在票上,都不行用算出来的)。
 *  stats.recomputed: 读到的金额和 数量 × 单价 对不上的行数(多半是模型读错了某一栏),用来给审核页一条提示。 */
/** 商家名清理: 去掉括号里的公司注册号 `(519537-X)`;公司名(… SDN BHD / S/B / BERHAD)后面还拖着地址(逗号、邮编、楼层)时,截到公司名为止。
 *  评测集里这两类共 7 张票,商家其实读对了,只是多带了东西;其余情况原样不动。 */
export function tidyMerchant(raw: string): string {
  let m = raw.replace(/\s*\(\s*\d{5,}\s*[-–]?\s*[A-Za-z]?\s*\)/g, '').replace(/\s{2,}/g, ' ').trim()
  const suffix = /\b(?:SDN\.?\s*BHD\.?|S\/B|BERHAD|BHD\.?)(?![A-Za-z])/i.exec(m)
  if (suffix) {
    const end = suffix.index + suffix[0].length
    const tail = m.slice(end)
    if (tail.trim() && (/[,，]/.test(tail) || /\d{3,}/.test(tail) || tail.trim().length > 12)) m = m.slice(0, end).trim() // 不加 \b: 尾巴 ` (S19537-X)` 里的数字前面是字母,也要算
  }
  // `JIMART@SP3 OGN GROUP SDN BHD`: 门店代码 `词@词` 粘在公司名前面 → 去掉,但剩下的必须带公司后缀(是个完整的公司名)才去
  const at = /^\S+@\S+\s+(.+)$/.exec(m)
  if (at && /\b(?:SDN\.?\s*BHD|S\/B|BERHAD|BHD)\b/i.test(at[1]!)) m = at[1]!.trim()
  // OCR 常把 S/B 读成 5/8、S/D: 名字末尾孤零零的 `5/8` 当作 S/B(评测集里 99 SPEED MART 5/8 出现 3 次)
  m = m.replace(/(\S)\s+5\/8\s*$/, '$1 S/B')
  // 末尾括号里只是重复了前面已有的词(TONYMOLY VIVA CITY (TONYMOLY SHOP))→ 去掉。括号里是 (M) (KL) 这类短缩写、或和前面没有共同词的不动。
  const tail = /^(.*\S)\s*\(([^()]{6,})\)\s*$/.exec(m)
  if (tail) {
    const head = new Set(tail[1]!.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4))
    if (tail[2]!.toUpperCase().split(/[^A-Z0-9]+/).some((w) => w.length >= 4 && head.has(w))) m = tail[1]!.trim()
  }
  return m || raw
}

/** 模型有时把「合计行」当成商品(STTL / TOTAL / GST / CASH…),或把商品行又抄一遍(描述里全是数字、没有字母,金额和别的行相同)。 */
const SUMMARY_ROW = /^\s*(?:s\.?\s*ttl|sub\s*-?\s*total|grand\s*total|net\s*total|total|gst|sst|tax|rounding|cash|change|balance|amount\s*due|jumlah)\b/i
export function isJunkRow(name: string, amount: unknown, all: { name: string; amount: unknown }[]): boolean {
  if (SUMMARY_ROW.test(name)) return true
  if (/[A-Za-z一-龥]/.test(name)) return false
  const a = amountWithCode(amount).value
  return a !== null && all.some((o) => o.name !== name && amountWithCode(o.amount).value === a)
}

/** 评测 / 回退开关: false = 旧口径(金额 = 票上印的那个数,折扣只记录)。 */
export const itemOpts = { netAmount: true }

/**
 * 行金额 = 数量 × 单价 − 这一行的折扣(折扣后的净额;AutoCount 明细行的「金额 / SubTotal」就是这个口径,税另算,不加进这一列)。
 * 票上多半先印「数量 × 单价」(折扣前),折扣另起一行(「Disc 30% −20.97」);也有直接印折扣后的金额的。
 * 到底是哪种,不能只看一行猜(没有单价就没法判断),而是让对账引擎来裁判: 它会把「各行金额合计」和小计 / 总额对照,
 * 分别试 合计 和 合计 − 各行折扣,哪个对得上就说明票上印的是哪种。
 *   · 「合计 − 各行折扣」对得上(模型 LD / UD)→ 票上印的是折扣前,把每一行减去它的折扣,变成净额;
 *   · 「合计」直接对得上 → 票上印的已经是净额(或折扣是单独一行),金额不动;
 *   · 都对不上 → 不动(对账会提示)。
 * 另外: 如果折扣已经单独成了一行(商品里有一行金额 = −折扣,如「Item promo @10  −3.86」),这一行上的折扣是重复记录,去掉,不然会减两次。
 */
export function normaliseLineAmounts(items: Item[], modelUsed: string | null): Item[] {
  if (!itemOpts.netAmount) return items
  const r2 = (x: number) => Math.round(x * 100) / 100
  // 折扣已经是单独一行的,这一行的折扣去掉(重复)
  const prices = items.map((i) => i.price)
  let out = items.map((it) => {
    if (!it.discount) return it
    const dup = prices.some((p, k) => p !== null && items[k] !== it && Math.abs(p + it.discount!) <= 0.02)
    if (!dup) return it
    const { discount: _d, ...rest } = it
    return rest as Item
  })
  if (modelUsed === 'LD' || modelUsed === 'UD') {
    out = out.map((it) => (it.discount && it.price !== null && it.price - it.discount >= 0 ? { ...it, price: r2(it.price - it.discount) } : it))
  }
  return out
}

/** 各行金额(减去各行折扣)对得上小计或「总额 − 其他费用(− 税)」,而不减折扣对不上 → 票上印的是折扣前的金额。 */
export function printedBeforeDiscount(d: ReceiptData): boolean {
  const items = d.items.filter((i) => i.price !== null)
  if (!items.some((i) => i.discount)) return false
  const r2 = (x: number) => Math.round(x * 100) / 100
  const gross = r2(items.reduce((a, i) => a + i.price!, 0)), net = r2(items.reduce((a, i) => a + i.price! - (i.discount ?? 0), 0))
  const refs: number[] = []
  if (d.subtotal !== null) refs.push(d.subtotal)
  if (d.total !== null) {
    const rest = (d.service_charge ?? 0) + (d.fees ?? 0) + (d.tip ?? 0) + (d.rounding ?? 0)
    refs.push(r2(d.total - rest))                       // 含税价: 各行金额已经含税
    if (d.tax) refs.push(r2(d.total - rest - d.tax))    // 不含税价
  }
  const hit = (x: number) => refs.some((q) => Math.abs(x - q) <= 0.03)
  return hit(net) && !hit(gross)
}

function itemsOf(raw: unknown[], fullText: string, stats?: { recomputed: number; dropped?: number }): Item[] {
  const objs = raw.slice(0, MAX_ITEMS).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  const all = objs.map((o) => ({ name: text(o.description) ?? '', amount: o.amount }))
  const kept = objs.filter((o, i) => !isJunkRow(all[i]!.name, o.amount, all))
  if (stats) stats.dropped = objs.length - kept.length
  const rows = enrichRows(toRows(kept), fullText ? `[full text]\n${fullText}` : '')
  const evidence = fullText ? itemAmountSet(fullText) : undefined
  const out: Item[] = []
  for (const r of rows) {
    const name = text(r.description) ?? ''
    const la = lineAmount(r, evidence)
    if (stats && la.conflict) stats.recomputed++
    const uom = text(r.uom)?.slice(0, 16)
    const dv = amountWithCode(r.discount).value
    const taxRate = rateOf(r.tax)
    out.push({ name, qty: qtyOf(r.quantity), price: la.value, ...(uom ? { uom } : {}), ...(dv !== null && dv !== 0 ? { discount: Math.abs(dv) } : {}), ...(taxRate !== null ? { taxRate } : {}) })
  }
  return out
}

// ---------------------------------------------------------------- 交叉验证
const AMOUNT_TOKEN = /\d[\d.,]*[.,]\d{2}(?!\d)/g
const cents = (n: number) => Math.round(Math.abs(n) * 100)

// ---------------------------------------------------------------- 模型常见的两类读错(在真实扫描里观察到的)
/**
 * 1) "抄值": 问到收据上根本没有的字段(服务费、折扣)时,小模型不说"没有",而是抄一个相邻的数字——
 *    实测 9 张里有 6 张的服务费等于税额,另外 3 张等于小计或总额。这类数字在原文里确实存在,所以"金额在原文里"的检查抓不到。
 * 2) "小计和总额颠倒": 含税价的收据上有"不含税合计"和"含税合计"两行,模型有时把含税的当成小计、不含税的当成总额。
 *
 * 修复得保守、可追溯: 只动这两个低先验字段(服务费、折扣)和这一种明确的颠倒,并且留下更正记录和原因代码,
 * 状态最高只给「已更正」,由审核员确认(不会是「基本可信」)。
 */
const LABEL: Record<'service_charge' | 'discount' | 'rounding' | 'tip' | 'fees' | 'tax' | 'subtotal', RegExp> = {
  subtotal: /sub\s*-?\s*total|s\.?\s*ttl|total\s+sales\s*\(?\s*excl|total\s+\(?excl|net\s+amount|amount\s+excl|excluding|before\s+(?:gst|tax)|jumlah\s+kecil/i,
  service_charge: /service|svc|s\.?\s*charge|servis/i,
  discount: /disc|diskaun|voucher|promo|rebate|saving/i,
  rounding: /round|rnd|adj|pembundaran/i,
  tip: /tip|gratuity/i,
  fees: /fee|deliver|packag|handling|surcharge/i,
  tax: /\b(?:tax|gst|sst|vat|cukai)\b/i,
}
/** 转写里有没有这样一行: 带"服务费/折扣"的标签,并且金额就是 v。 */
function hasLabelledAmount(transcript: string, key: keyof typeof LABEL, v: number): boolean {
  return fixSpacedDecimals(transcript).split(/\r?\n/).some((line) => LABEL[key].test(line) && [...line.matchAll(AMOUNT_TOKEN)].some((m) => { const x = amountOf(m[0]); return x !== null && cents(x) === cents(v) }))
}

/** fixes = 改了关键字段(总额/小计),要审核员确认;cleanups = 清掉了没有依据的次要字段(服务费/折扣/舍入/税额/找零…),不碰总额、日期、商家,不压低状态。 */
interface Repair { d: ReceiptData; fixes: string[]; cleanups: string[]; corrections: Correction[] }
export function repairAmounts(input: ReceiptData, transcript = ''): Repair {
  const d: ReceiptData = { ...input }
  const fixes: string[] = []
  const cleanups: string[] = []
  const corrections: Correction[] = []

  // 1) 次要字段(服务费/折扣/舍入/小费/其他费)没有依据 → 清空。模型问到收据上根本没有的字段时不说「没有」,而是抄一个别处的数
  //    (GST 汇总里的税基、找零、税额、总额…),所以不能只看「和别的字段一样」:
  //      · 有整页转写: 转写里必须有一行带该字段的标签(Service Charge / Discount / Rounding …)、金额也对得上,否则就是没有依据,清空。
  //        这只是去掉没有依据的数,不碰总额、日期、商家,所以记成 cleanups,不把这张压成「已更正」。
  //      · 没有转写: 只能靠「和别的字段的金额完全相同」判断(证据弱),仍按「已更正」处理。
  const haveText = transcript.trim() !== ''
  for (const k of ['service_charge', 'discount', 'rounding', 'tip', 'fees'] as const) {
    const v = d[k]
    if (v === null || v === 0) continue
    const absV = Math.abs(v)
    if (haveText) {
      if (absV <= 0.05) continue // 这么小的数本来就可能是真的(现金舍入、几分钱的折扣)
      if (hasLabelledAmount(transcript, k, absV)) continue
      corrections.push({ field: k, old: v, new: null, why: '整页文字里找不到带这个字段标签的一行(金额对得上的),这个数没有依据,疑似模型抄了别处的数字' })
      d[k] = null
      cleanups.push(k)
      continue
    }
    if (k === 'rounding' && absV <= 0.05) continue
    const others = (['tax', 'subtotal', 'total', 'paid', 'change', 'service_charge', 'discount', 'rounding', 'tip', 'fees'] as const)
      .filter((o) => o !== k).map((o) => (d[o] === null ? null : Math.abs(d[o]!)))
    if (!others.some((x) => x !== null && x !== 0 && Math.abs(x - absV) < 0.005)) continue
    corrections.push({ field: k, old: v, new: null, why: '与别的字段的金额完全相同,疑似模型抄了相邻的数字' })
    d[k] = null
    fixes.push(k)
  }

  // 1a) 税额不可能和小计、总额或实付一样(那要 100% 的税率):模型把它们抄进了税额。纯算术,不需要转写;清空后税率检查和分税率算税照常判断。
  if (d.tax !== null && d.tax > 0 && [d.subtotal, d.total, d.paid].some((x) => x !== null && Math.abs(x - d.tax!) < 0.005)) {
    corrections.push({ field: 'tax', old: d.tax, new: null, why: '税额和小计/总额/实付完全相同(不可能),疑似模型抄了相邻的数字' })
    d.tax = null
    cleanups.push('tax')
  }
  // 1a') 税额和找零一样:模型常把找零抄进税额(评测集 3 张: 税额 41 / 5.10 / 24.15 都等于找零)。
  //      找零和税额偶然相等是可能的,所以必须有转写、且转写里没有带「税」标签、金额相同的一行,才清。
  if (haveText && d.tax !== null && d.tax > 0 && d.change !== null && d.change > 0 && Math.abs(d.change - d.tax) < 0.005 && !hasLabelledAmount(transcript, 'tax', d.tax)) {
    corrections.push({ field: 'tax', old: d.tax, new: null, why: '税额和找零完全相同,而整页文字里没有带「税」标签的这一行,疑似模型把找零抄进了税额' })
    d.tax = null
    cleanups.push('tax')
  }

  // 1b) 找零不可能大于等于实付(找零 = 实付 − 总额,总额为正):常见的读错是把总额或实付又抄进了找零。
  //     这是纯算术上的不可能,不需要转写佐证;清空后付款核对会按"实付 − 找零"重新判断。
  if (d.paid !== null && d.change !== null && d.change > 0 && d.paid > 0 && d.change >= d.paid - 0.005) {
    corrections.push({ field: 'change', old: d.change, new: null, why: '找零大于或等于实付(不可能),疑似模型把总额/实付抄进了找零' })
    d.change = null
    cleanups.push('change')
  }

  // 1c) 总额读成了「舍入前」的合计: 舍入已写明(很小),而实付−找零恰好等于「总额 + 舍入」、与现在的总额不符 → 总额应是舍入之后的数。
  //     有实付作为独立佐证才自动改;没有佐证时只在审核页给「一键采用」的建议(对账引擎里的 total_before_rounding)。
  if (d.total !== null && d.rounding !== null && d.rounding !== 0 && Math.abs(d.rounding) <= 0.05 && d.paid !== null) {
    const net = d.paid - (d.change ?? 0)
    const after = Math.round((d.total + d.rounding) * 100) / 100
    // 金额按分比较:「25.44 + 舍入 0.01 = 25.45 = 实付 − 找零」也要改(以前容差 0.011 把 1 分钱的舍入漏掉了)
    if (Math.abs(net - after) <= 0.005 && Math.abs(net - d.total) > 0.005) {
      corrections.push({ field: 'total', old: d.total, new: after, why: '总额是舍入之前的含税合计;实付−找零与「总额 + 舍入」一致,所以应付金额是舍入之后的数' })
      d.total = after
      fixes.push('total')
    }
  }

  // 2) 小计和总额颠倒: 实付−找零 = "小计",并且 "总额"+税 = "小计"。付款信息是独立的佐证,没有它就不动
  const paidNet = d.paid === null ? null : d.paid - (d.change ?? 0)
  if (d.total !== null && d.subtotal !== null && d.tax !== null && paidNet !== null
    && Math.abs(paidNet - d.subtotal) < 0.011 && Math.abs(paidNet - d.total) > 0.011 && Math.abs(d.total + d.tax - d.subtotal) <= 0.011) {
    const why = '含税合计被读成了小计、不含税合计被读成了总额(与实付一致的是前者)'
    corrections.push({ field: '总额', old: d.total, new: d.subtotal, why }, { field: 'subtotal', old: d.subtotal, new: d.total, why })
    ;[d.total, d.subtotal] = [d.subtotal, d.total]
    fixes.push('total', 'subtotal')
  }

  // 3) 小计没有依据 → 清空。含税价的小票(Price Inclusive Of GST)根本没有「小计」这一行,模型会抄第一行商品的金额当小计(7.10、4.40…),
  //    于是「小计 + 税 ≠ 总额」。三个条件同时成立才清: 总额有付款佐证(实付 − 找零 = 总额)、小计加上其他项算不到总额、转写里没有带「小计」标签的行写着这个金额。
  if (haveText && d.subtotal !== null && d.total !== null && d.subtotal > 0 && Math.abs(d.subtotal - d.total) > 0.005) {
    const net = d.paid === null ? null : d.paid - (d.change ?? 0)
    const sum = d.subtotal + (d.tax ?? 0) + (d.service_charge ?? 0) - Math.abs(d.discount ?? 0) + (d.rounding ?? 0)
    if (net !== null && Math.abs(net - d.total) <= 0.011 && Math.abs(sum - d.total) > 0.02 && !hasLabelledAmount(transcript, 'subtotal', d.subtotal)) {
      corrections.push({ field: 'subtotal', old: d.subtotal, new: null, why: '小计加税等算不到总额,而整页文字里没有带「小计」标签、金额相同的一行(含税价的小票常常没有小计),疑似模型抄了某一行商品的金额' })
      d.subtotal = null
      cleanups.push('subtotal')
    }
  }
  return { d, fixes, cleanups, corrections }
}
/**
 * 总额仲裁: 模型读的总额错了,而整页转写里有两个互相独立的读数一致 —— 规则从文字里找的总额(Total After Rounding / Total 等)
 * 和付款行算出的总额(实付 − 找零)—— 就用它们。在 131 张真实收据上: 总额读错的 40 张,正确答案全部出现在转写里;
 * 两个读数一致的 103 张里 101 张是对的,按这个规则改,总额从错变对 25 张、从对变错 1 张。
 * 只在「两个独立来源一致、而且和模型读的不一样」时才改,并记成更正(auto_corrected:total,审核页可见、可撤销)。
 * 状态: 只有仲裁改过、没有别的更正时,证据和「模型本来就读对」的自动通过票一样强,所以不压低;只要还有别的关键字段更正(小计/总额颠倒、舍入前总额),最高「已更正」。
 */
export function arbitrateTotal(d: ReceiptData, transcript: string): { fixes: string[]; corrections: Correction[] } {
  const none = { fixes: [] as string[], corrections: [] as Correction[] }
  if (!transcript.trim()) return none
  const rt = regexTotal(transcript)
  const pay = paymentFromText(transcript, rt)
  const pt = pay.paid === null ? null : Math.round((pay.paid - (pay.change ?? 0)) * 100) / 100
  const fixTo = (v: number, why: string) => {
    const old = d.total
    d.total = v
    return { fixes: ['total'], corrections: [{ field: 'total', old, new: v, why }] }
  }
  const same = (x: number | null, y: number | null) => x !== null && y !== null && Math.abs(x - y) <= 0.005
  // 路径 1: 规则总额和付款行一致
  if (rt !== null && pt !== null && Math.abs(rt - pt) <= 0.005 && !same(d.total, rt)) {
    return fixTo(rt, '整页文字里「总额」和「付款行(实付 − 找零)」两处一致,与模型读到的总额不同,采用前者')
  }
  // 路径 2: 票上有明确的「应付」标签(Total Payable / Amount Due / Balance Due / Grand Total / Net Total / 单独一行 Due)。
  //   多税率发票(Gardenia)分税率印了好几个「Total 6% supplies」,最后才是 Total Payable;规则取总额也会被「Total Included GST @ 6% : 1.09」这种税额行带偏。
  //   应付标签那一行写的就是最终应付额。付款行存在时必须和它一致(不一致说明票上有矛盾,不动);没有付款行就直接采用。
  const pa = payableAmount(transcript)
  // 付款行不反对: 没有付款行 / 实付 − 找零 = 应付额 / 找零没读到而实付(现金)大于应付额(Paid Amount 100.00 对 Total Amt Payable 8.50)
  const rounds = Math.round(roundUnit(d.currency) * 100) === 5 // 需要 0.05 舍入的币种(MYR / SGD…): 实付 − 找零和印出来的总额差几分钱是正常的现金舍入
  const payAgrees = (v: number) => pt === null || same(pt, v) || (rounds && Math.abs(pt - v) < 0.05) || (pay.change === null && pay.paid !== null && pay.paid > v)
  if (pa !== null && d.total !== null && !same(d.total, pa) && payAgrees(pa)) {
    return fixTo(pa, '整页文字里「应付」类标签(Total Payable / Amount Due / Due / Grand Total…)那一行写的是这个数,模型读到的多半是某个分类小计或实付,采用票上写明的应付额')
  }
  // 路径 4: 模型把「实付」抄成了总额。有找零(> 0)时,总额 = 实付 − 找零,不可能等于实付;而「实付 − 找零」这个数在票上印着(如 Amount Incl. GST 5.00)→ 采用它。
  if (d.total !== null && pay.paid !== null && pay.change !== null && pay.change > 0 && pay.change < pay.paid && same(d.total, pay.paid) && pt !== null && pt > 0.005 && textHasAmount(transcript, pt)) {
    return fixTo(pt, '模型读到的总额等于实付,而票上有找零:总额应是实付 − 找零,这个数在原文里也印着,采用它')
  }
  // 路径 4b: 模型把现金(实付)抄成了总额,而票上没有(可读的)找零行: 规则找到的总额 rt 比实付小,并且「实付 − rt」这个数也印在票上(就是找零,
  //   版式乱了才没被认成找零,例如 `Tendered: RM66.10` 排在 `Change:` 空行上面)→ 采用 rt。三个条件同时成立才改。
  if (rt !== null && d.total !== null && d.paid !== null && same(d.total, d.paid) && rt < d.paid - 0.005
    && textHasAmount(transcript, Math.round((d.paid - rt) * 100) / 100) && (d.change === null || d.change === 0 || same(d.change, d.paid - rt))) {
    return fixTo(rt, '模型读到的总额等于实付(现金),而规则找到的总额更小,「实付 − 总额」这个数在原文里也印着(找零),采用规则读到的总额')
  }
  // 路径 3: 模型读的总额在整页文字里根本找不到(凭空的数),而规则找到了一个总额,付款行也不反对规则 → 采用规则的。
  //   评测集里「总额不在原文里」这条提示 9/9 是读错的。付款行等于模型的总额时不动(模型可能是按付款算的)。
  if (rt !== null && d.total !== null && !same(d.total, rt) && !textHasAmount(transcript, d.total) && (!same(pt, d.total) || (rounds && Math.abs(d.total - rt) < 0.05)) && payAgrees(rt)) {
    return fixTo(rt, '模型读到的总额在整页文字里找不到,而规则从文字里读到了一个总额,采用文字里的')
  }
  return none
}

/** 「应付」类标签。单独一行的 `Due 19.20` 也算(整行就是「Due + 金额」,免得把 Due Date 当成金额)。 */
const PAYABLE_LABEL = /total\s+after\s+(?:adj\w*|round\w*)|total\s+(?:amt\.?\s+)?payable|amount\s+payable|balance\s+due|amount\s+due|amt\.?\s+due|grand\s+total|net\s+total/i
const BARE_DUE = /^\s*(?:net\s+)?due\s*:?\s*(?:RM|\$)?\s*\d[\d,]*[.,]\d{2}\s*$/i
/** 转写里最后一行「应付」标签上的金额(同一行有几个金额取最后一个);没有返回 null。 */
function payableAmount(transcript: string): number | null {
  let out: number | null = null
  for (const line of fixSpacedDecimals(transcript).split(/\r?\n/)) {
    if (!PAYABLE_LABEL.test(line) && !BARE_DUE.test(line)) continue
    // 金额前面紧跟着负号(`Total Payable: -1.73`,调整单/退货单)→ 负数
    const vals = [...line.matchAll(AMOUNT_TOKEN)].map((m) => { const x = amountOf(m[0]); return x !== null && /-\s?$/.test(line.slice(0, m.index)) ? -Math.abs(x) : x }).filter((x): x is number => x !== null)
    if (vals.length) out = vals[vals.length - 1]!
  }
  return out
}
/** 转写里出现过这个金额吗(按分比较)。 */
function textHasAmount(transcript: string, v: number): boolean {
  return [...fixSpacedDecimals(transcript).matchAll(AMOUNT_TOKEN)].some((m) => { const x = amountOf(m[0]); return x !== null && cents(x) === cents(v) })
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9一-龥]/g, '')
/** 两个商家名是不是同一个: 去掉符号后相同,或者短的完整包含在长的里(至少 4 个字)。比不了的(空)当作一致,不制造分歧。 */
function sameName(a: string, b: string): boolean {
  const x = norm(a), y = norm(b)
  if (!x || !y || x === y) return true
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  return s.length >= 4 && l.includes(s)
}

/** 公司法定名的后缀(Sdn Bhd / Berhad / Enterprise …)。 */
const LEGAL_SUFFIX = /\b(?:SDN\.?\s*BHD|BERHAD|BHD|ENTERPRISE|TRADING|PLT|S\/B)\b/i

interface Cross { regexTotal: number | null; flags: string[]; verifier: VerifierInfo }

/**
 * 用整页转写做第二次独立的读取。转写和字段提问是同一个模型的两种不同用法(一个读全文,一个答具体问题),
 * 再加上规则提取,能抓到"字段里的数字在原文里根本不存在"这类编造,以及日期/总额的读错。
 * 只在有转写文字时才做;没有就不做(不会因此误报)。
 */
function crossCheck(transcript: string, d: ReceiptData, isKnown: (name: string) => boolean = () => false): Cross {
  const t = fixSpacedDecimals(transcript)
  const rt = regexTotal(t)
  const flags: string[] = []

  // 1) 模型读到的每个金额,必须能在转写里找到。无小数的币种(日元、印尼盾…)转写里没有 .00,跳过这一项以免全部误报
  if (roundUnit(d.currency) < 1) {
    const present = new Set<number>()
    for (const m of t.matchAll(AMOUNT_TOKEN)) { const v = amountOf(m[0]); if (v !== null) present.add(cents(v)) }
    const checks = [['total', 'total_not_in_text'], ['subtotal', 'subtotal_not_in_text'], ['tax', 'tax_not_in_text'], ['paid', 'paid_not_in_text'], ['change', 'change_not_in_text']] as const
    for (const [k, code] of checks) {
      const v = d[k]
      if (v !== null && v !== 0 && !present.has(cents(v))) flags.push(code)
    }
  }
  // 2) 规则从转写里读到的总额和模型读到的不同
  // 规则找的总额不一致,但「付款行(实付 − 找零)」正好等于模型读的总额 → 规则(取最后一个 Total 之类)才是离群的那个,不算冲突。
  //   (规则选错的典型: 票上有多个「Total」,如商品合计、含税合计、舍入后合计。)
  const textPay = paymentFromText(t, d.total)
  const payNet = textPay.paid === null ? null : Math.round((textPay.paid - (textPay.change ?? 0)) * 100) / 100
  // 还要求模型的总额本身印在票上(转写里出现过),否则「付款行刚好等于一个没印出来的数」不可信
  const totalPrinted = d.total !== null && [...t.matchAll(AMOUNT_TOKEN)].some((m) => { const v = amountOf(m[0]); return v !== null && cents(v) === cents(d.total!) })
  const payConfirmsModel = d.total !== null && payNet !== null && Math.abs(payNet - d.total) <= 0.005 && totalPrinted
  const totalDiffers = rt !== null && d.total !== null && Math.abs(rt - d.total) > 0.011 && !payConfirmsModel
  if (totalDiffers) flags.push('total_conflicts_with_text_rule')

  // 3) 日期、商家的"第二次读取"。只有分歧时才写 saw(审核页据此给出"第二次读到:…"的一键采用建议)
  const saw: NonNullable<VerifierInfo['saw']> = {}
  const agree: Record<string, boolean | null> = { merchant: null, date: null, total: null }
  const d2 = findDate(t)
  if (d2 && d.date) { agree.date = d2.iso === d.date; if (!agree.date) saw.date = d2.iso }
  if (rt !== null && d.total !== null) agree.total = !totalDiffers // 总额的建议由 regex_total("文字中读到")提供,这里不重复给
  const m2 = guessMerchant(t)
  if (m2 && d.merchant) { agree.merchant = sameName(m2, d.merchant); if (!agree.merchant) saw.merchant = m2 }
  // 商家名的启发式本来就不太准,分歧只作为建议,不单独当成"需要检查"的理由;日期和总额的分歧才标出来
  const disagree = (['date', 'total'] as const).filter((k) => agree[k] === false)
  if (disagree.length) flags.push(`verifier_disagrees:${disagree.join(',')}`)
  // 例外: 模型读的是品牌名(MYNEWS、Morganfields®),而转写开头有一行带公司后缀的法定名(… SDN BHD / BERHAD)且和它不一样 → 供应商匹配需要法定名,要人看一眼。
  //   (只在「转写里的是法定名、模型读的不是」时才标,避免把普通的写法差异都当成问题。)
  //   审核员以前确认过这个商家名(商家记忆表 / 已通过的收据)→ 品牌名就是他们要的名字,不再标。
  if (m2 && d.merchant && !sameName(m2, d.merchant) && LEGAL_SUFFIX.test(m2) && !LEGAL_SUFFIX.test(d.merchant) && !isKnown(d.merchant)) flags.push('merchant_legal_name_differs')
  // 总额是负数(退货单 / 调整单以外几乎不可能): 多半把调整行读成了总额
  if (d.total !== null && d.total < 0) flags.push('total_negative')
  // 日期不可能: 票上有 GST 登记号,而日期早于马来西亚 GST 开始的 2015-04-01;或者日期在未来。两次读取都读错同一位数(如 18 → 13)时,验证也发现不了。
  if (d.date && (d.date > new Date().toISOString().slice(0, 10) || (d.date < '2015-04-01' && /\bGST\b/i.test(t)))) flags.push('date_implausible')

  return { regexTotal: rt, flags, verifier: { saw: Object.keys(saw).length ? saw : null, agree } }
}

// ---------------------------------------------------------------- 原始文字(审核页"识别出的原始文字"面板)
export const ANSWER_TITLES: Record<string, string> = { core: 'core fields', extra: 'extra fields', items: 'line items', items_retry: 'line items retry', second_core: 'second core fields', second_extra: 'second extra fields', second_items: 'second line items', qwen_detail: 'qwen detail fields' }
/** 整页转写在前(最像"原文"),后面是模型对每个提问的原始回答。数字可以在审核页点一下直接填进金额格。 */
function composeText(out: StructuredOutput): string {
  const parts: string[] = []
  if (out.text) parts.push(`[full text]\n${out.text}`)
  for (const a of out.answers ?? []) parts.push(`[${ANSWER_TITLES[a.name] ?? a.name}]\n${a.raw}`)
  return parts.join('\n\n')
}

export interface StructuredExtraction extends Extraction {
  /** 存进"识别出的原始文字"的内容。 */
  ocrText: string
  /** 各阶段耗时(秒)。 */
  timing: Record<string, number> | null
  /** 第二次读取(整页转写 + 规则)的结果;没有转写文字时为 null。 */
  verifier: VerifierInfo | null
  /** 系统自动更正的记录(审核页会显示"系统把总额从 A 改成了 B",并提供恢复原值)。 */
  corrections: Correction[]
}

/** Jev 的默认阈值只是占位(官方不给通过线),必须用自己的收据标定;所以默认只提示、不改状态。 */
export const JEV_DEFAULT_THRESHOLD = 0.5

/**
 * 把验证器(Jev)的分数合进结果。分数只会让结果更谨慎,从不会让它更"可信":
 *  - 总是记录分数(审核页显示,也用来以后标定阈值);
 *  - 分数低于阈值 → 加 jev_low 提示;demote=true 时,原本「基本可信」的降为「需检查」;
 *  - 没打成(verdict 不是 scored)只记录原因,不加任何提示——验证器故障不该变成对收据的怀疑。
 */
export function applyJev(ex: StructuredExtraction, jev: JevScore, opts: { threshold?: number; demote?: boolean } = {}): StructuredExtraction {
  const threshold = opts.threshold ?? JEV_DEFAULT_THRESHOLD
  const verifier: VerifierInfo = { saw: ex.verifier?.saw ?? null, agree: ex.verifier?.agree ?? null, jev: { score: jev.score, verdict: jev.verdict, threshold } }
  const low = jev.verdict === 'scored' && jev.score !== null && jev.score < threshold
  if (!low) return { ...ex, verifier }
  const status = opts.demote && (ex.status === 'AUTO_VERIFIED' || ex.status === 'AUTO') ? 'REVIEW' : ex.status
  return { ...ex, verifier, status, reasons: [...new Set([...ex.reasons, 'jev_low'])] }
}

export function fromStructured(out: StructuredOutput, opts: { aliasOf?: AliasResolver; isKnown?: (name: string) => boolean } = {}): StructuredExtraction {
  const f = out.fields
  const reasons: string[] = ['scanned_in_portal']

  const merchantRaw = text(val(f, 'merchant_name'))
  let tidied = merchantRaw === null ? null : tidyMerchant(merchantRaw)
  let merchantFromText = false
  if (tidied !== null && /[a-z]/.test(tidied) && !/[A-Z]/.test(tidied) && out.text.trim()) {
    // 全是小写(`tan woon yann`): 多半是照片顶部手写的客户名,不是商家。转写开头有带公司后缀的名字就用它,没有就保持原样(照旧会因为「商家名读乱」进人工)
    const g = guessMerchant(fixSpacedDecimals(out.text))
    if (g && LEGAL_SUFFIX.test(g)) { tidied = tidyMerchant(g); merchantFromText = true }
  }
  // 商家记忆表: 这个读法以前被审核员确认成了另一个名字(品牌名 → 公司法定名)→ 直接用确认过的名字
  const aliased = tidied === null ? null : opts.aliasOf?.(tidied) ?? null
  const merchant = aliased ?? tidied
  const dateRaw0 = text(val(f, 'date'))
  // 模型读的日期里分隔符乱(「05 02-18」「27 03 2018」)时统一成 /;整个字符串就是一个日期才这样处理,不碰自由文本
  const dateRaw = dateRaw0 && /^\d{1,2}[\s\-/.]+\d{1,2}[\s\-/.]+\d{2,4}$/.test(dateRaw0) ? dateRaw0.replace(/[\s\-/.]+/g, '/') : dateRaw0
  let date = dateRaw ? findDate(dateRaw) : null // 日/月有歧义时按"日在前"理解并标记,由 triage 转人工
  // 模型没读到日期(或读成乱码),而整页转写里有一个读得出来的日期 → 用转写里的,记成更正(日期是关键字段,所以状态最高「已更正」)
  let dateFromText: { raw: string | null; iso: string } | null = null
  if (!date && out.text.trim()) {
    const t = findDate(out.text)
    if (t) { date = t; dateFromText = { raw: dateRaw0, iso: t.iso } }
  }
  const curRaw = text(val(f, 'currency'))
  // 币种栏常被读成税码(SR / ZR)而丢失: 先看币种栏和商家名,再看整页转写里的 RM / MYR / S$ 等
  const currency = normCurrency(curRaw) ?? guessCurrency(`${curRaw ?? ''} ${merchant ?? ''}`) ?? (out.text ? guessCurrency(out.text) : null)

  // 金额交给 cleanData 统一解析('RM 1,234.50'、'0.03-'、'(5.00)' 都能读;读不懂的留空,不连累整张)
  const itemStats: { recomputed: number; dropped?: number } = { recomputed: 0 }
  const items = itemsOf(out.items, out.text, itemStats)
  if (itemStats.dropped) reasons.push('items_rows_dropped') // 合计行 / 重复抄的行被当成了商品,已去掉
  if (itemStats.recomputed) reasons.push('items_amount_recomputed') // 有几行的金额是用 数量 × 单价 重新算的(和模型读到的金额不一样)
  let d: ReceiptData = cleanData(
    {
      merchant, date: date?.iso ?? null, currency,
      subtotal: val(f, 'subtotal'), tax: val(f, 'tax_amount'), total: val(f, 'total'),
      discount: val(f, 'discount_amount'), service_charge: val(f, 'service_charge_amount'), rounding: val(f, 'rounding_adjustment'),
      paid: val(f, 'amount_paid'), change: val(f, 'change_given'),
      items,
    },
    true,
  )

  // 总额仲裁: 转写里「总额」和「付款行」两个独立读数一致、而模型读的不一样 → 用前者(见 arbitrateTotal)
  const arb = arbitrateTotal(d, out.text)

  // 实付/找零: 从整页转写里的付款方式行(CASH / VISA / TNG …)和 CHANGE 行取。这是和模型字段独立的另一次读取(转写 + 规则)。
  //   · 模型没读到 → 补上;
  //   · 模型读到了,但「实付 − 找零」和总额对不上,而转写里的付款行和总额对得上 → 用转写里的(模型常把实付抄成总额、或把找零抄成税额)。
  //   标成提示,审核页会说明这两个数是从文字里取的。实付/找零不是关键字段,所以不压低状态。
  const payCorrections: Correction[] = []
  if (out.text.trim()) {
    const pay = paymentFromText(out.text, d.total)
    const net = (p: number | null, c: number | null) => (p === null ? null : p - (c ?? 0))
    const fits = (p: number | null, c: number | null) => d.total !== null && net(p, c) !== null && Math.abs(net(p, c)! - d.total) <= 0.036
    if (d.paid !== null && !fits(d.paid, d.change) && fits(pay.paid, pay.change)) {
      payCorrections.push({ field: 'paid', old: d.paid, new: pay.paid, why: '转写里的付款行(实付 − 找零)和总额对得上,模型读到的对不上,采用转写里的' })
      if (pay.change !== d.change) payCorrections.push({ field: 'change', old: d.change, new: pay.change, why: '同上' })
      d.paid = pay.paid; d.change = pay.change
      reasons.push('paid_from_text')
    } else if (d.paid === null || d.change === null) {
      if (d.paid === null && pay.paid !== null) { d.paid = pay.paid; reasons.push('paid_from_text') }
      if (d.change === null && pay.change !== null && d.paid !== null && pay.change < d.paid) { d.change = pay.change; reasons.push('change_from_text') }
    }
  }

  // 先修正模型常见的两类读错(抄值、小计和总额颠倒),再对账和分流
  const rep = repairAmounts(d, out.text)
  d = rep.d
  const fixes = [...arb.fixes, ...rep.fixes, ...(dateFromText ? ['date'] : [])]
  if (fixes.length) reasons.push(`auto_corrected:${[...new Set(fixes)].join(',')}`)
  if (merchantRaw !== null && tidied !== merchantRaw) reasons.push(merchantFromText ? 'merchant_from_text' : 'merchant_tidied') // 去掉了商家名里的注册号 / 地址
  if (aliased !== null && aliased !== tidied) reasons.push('merchant_alias') // 用了商家记忆表里审核员确认过的名字
  if (rep.cleanups.length) reasons.push(`auto_cleared:${[...new Set(rep.cleanups)].join(',')}`) // 清掉了没有依据的次要字段: 只是提示,不要求逐项确认

  if (!d.items.length) reasons.push('items_not_extracted')
  if (out.failed.length) reasons.push('ocr_bad') // 有的提问没得到可用的结果: 这张只读到一部分,提醒员工全部字段都对照原图

  // 和规则提取不同,这里不会"试着去掉税额/小计让它对上"——模型读到的字段是明确标过名字的,对不上就如实让员工看
  // 行金额归一成「折扣后的净额」: 先去掉重复记录的折扣,对账一次看票上印的是折扣前还是折扣后,必要时把各行减去折扣,再对账
  d = { ...d, items: normaliseLineAmounts(d.items, null) }
  let recon = reconcile({ ...d })
  const lineModel = recon.checks.find((c) => c.id === 'items_vs_subtotal')?.params.model
  // 对账引擎只拿「小计」当参照;小计读错(常见: 读成了总额)时判断不出来。补一道: 参照也用「总额 − 服务费 / 舍入… (− 税)」,
  // 只有「各行金额 − 折扣」对得上、而「各行金额」本身对不上的时候才认定是折扣前(宁可不动,不要猜)。
  if (lineModel === 'LD' || lineModel === 'UD' || printedBeforeDiscount(d)) {
    d = { ...d, items: normaliseLineAmounts(d.items, 'LD') }
    recon = reconcile({ ...d })
  }
  let status = triage(d, recon, date, reasons, textIsDayFirst(`${out.text}\n${merchant ?? ''}`))

  // 交叉验证: 有整页转写才做。任何一项没通过,就不能是"基本可信"
  let cross: Cross | null = null
  if (out.text.trim()) {
    cross = crossCheck(out.text, d, (n) => aliased !== null || !!opts.isKnown?.(n))
    reasons.push(...cross.flags)
    if (cross.flags.length && status === 'AUTO_VERIFIED') status = 'REVIEW'
  }
  // 自动改过的不能是「基本可信」: 最高给「已更正」,让审核员确认更正对不对
  // 例外: 只有总额仲裁改过(没有别的更正),并且改完以后「转写里的总额」「付款行」「模型字段」三方一致 —— 这和没改过就一致的自动通过票证据一样强,不再压低
  const arbOnly = arb.fixes.length > 0 && rep.fixes.length === 0
  if (fixes.length && !arbOnly && status === 'AUTO_VERIFIED') status = 'CORRECTED'

  const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)
  d = { ...d, total: r2(d.total), subtotal: r2(d.subtotal), tax: r2(d.tax), paid: r2(d.paid), change: r2(d.change), rounding: r2(d.rounding), discount: r2(d.discount), service_charge: r2(d.service_charge) }
  return {
    data: d, status, reasons: [...new Set(reasons)], regexTotal: cross?.regexTotal ?? null,
    ocrText: composeText(out), timing: out.timing && Object.keys(out.timing).length ? out.timing : null, verifier: cross?.verifier ?? null,
    corrections: [...arb.corrections, ...payCorrections, ...rep.corrections, ...(dateFromText ? [{ field: 'date', old: dateFromText.raw, new: dateFromText.iso, why: '模型没读到有效的日期,采用整页文字里读到的日期' } as Correction] : []), ...(merchantRaw !== null && tidied !== merchantRaw ? [{ field: 'merchant', old: merchantRaw, new: tidied, why: merchantFromText ? '模型读到的商家全是小写(多半是照片顶部手写的客户名),整页文字开头有带公司后缀的名字,采用它' : '商家名里带了公司注册号、门店代码或地址,已截到公司名' } as Correction] : []), ...(aliased !== null && aliased !== tidied ? [{ field: 'merchant', old: tidied, new: aliased, why: '这个读法以前被审核员确认成了另一个名字,采用确认过的名字(商家记忆表)' } as Correction] : [])],
  }
}
