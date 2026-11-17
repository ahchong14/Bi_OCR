/**
 * 评测: 把「准不准」变成数字,并且能在每次改规则之后自动对比,发现变差。
 *
 * 思路: 模型(Kaggle 上的 MiniCPM / GLM)很慢也不稳定,而门户自己的规则(字段整理、对账、分流、自动更正)是确定性的。
 * 所以把模型对每张收据的【原始回答】存下来(StructuredOutput),以后用当前代码「重放」一遍 —— 不用再调模型,几秒钟就能算出
 *   · 总额 / 日期 / 商家 各读对了多少(对照标准答案);
 *   · 「基本可信」(自动通过)的收据里有多少其实是错的 —— 这是最重要的数字(错放率);
 *   · 读错了的收据里,有多少被拦下来交给人工 —— 拦截率;
 *   · 读对了的收据里,有多少被多余地拦下来 —— 误报(影响自动通过率);
 *   · 每一条提示(原因代码)准不准。
 * 重放是确定的,所以同一批输入上指标的任何变化都来自代码改动。baseline 记下当前水平,变差就让测试失败。
 *
 * 标准答案格式和 truth.ts / Kaggle 脚本一致(SROIE): file, company, date, address, total。
 */
import { fullTextOf, modelItemRows } from '../../shared/items'
import { makeResolver, normName, type AliasEntry, type AliasResolver } from './aliases'
import { findDate } from './extract'
import type { StructuredOutput } from './ocr'
import { CORE_FIELDS, EXTRA_FIELDS, fromStructured, type StructuredExtraction } from './structured'
import { COMPANY_MATCH, parseCsv, similarity, truthAmount } from './truth'

/** 审核员确认过的其余金额和商品(从审核更正导出的收据才有;SROIE 标准答案只有商家、日期、总额)。null = 票上没有这一项。 */
export interface LabelExtra { subtotal: number | null; tax: number | null; paid: number | null; change: number | null; itemCount: number; itemsTotal: number | null }
export interface Label { company: string | null; date: string | null /* YYYY-MM-DD */; total: number | null; extra?: LabelExtra }
/** 一张收据的评测样本: 标准答案 + 模型的原始回答(重放用)。 */
export interface GoldenItem { file: string; label: Label; out: StructuredOutput }

// ---------------------------------------------------------------- 标准答案
export function labelsFromCsv(csv: string): Map<string, Label> {
  const rows = parseCsv(csv)
  const out = new Map<string, Label>()
  if (rows.length < 2) return out
  const head = rows[0]!.map((h) => h.trim().toLowerCase())
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h))
  const iFile = col('file', 'filename', 'image'), iCo = col('company', 'merchant', 'merchant_name'), iDate = col('date'), iTotal = col('total', 'total_amount')
  if (iFile < 0) return out
  for (const r of rows.slice(1)) {
    const file = (r[iFile] ?? '').trim().split(/[\\/]/).pop() ?? ''
    if (!file) continue
    const rawDate = iDate >= 0 ? (r[iDate] ?? '').trim() : ''
    const rawTotal = iTotal >= 0 ? (r[iTotal] ?? '').trim() : ''
    out.set(file, {
      company: iCo >= 0 ? (r[iCo] ?? '').trim() || null : null,
      date: rawDate ? (findDate(rawDate)?.iso ?? null) : null, // 日在前(东南亚小票最常见),和导入标准答案时一样
      total: rawTotal ? truthAmount(rawTotal) : null,
    })
  }
  return out
}

// ---------------------------------------------------------------- 从门户存下来的「原始文字」还原模型的原始回答
const section = (text: string, title: string) => new RegExp(`(?:^|\\n)\\[${title}\\]\\n([\\s\\S]*?)(?=\\n\\n\\[[a-z]|$)`).exec(text)?.[1] ?? ''
function jsonOf(body: string): Record<string, unknown> | null {
  const i = body.indexOf('{'), j = body.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { const v = JSON.parse(body.slice(i, j + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null } catch { return null }
}

/**
 * 门户把每张收据的原始文字存成 `[full text]\n…\n\n[core fields]\n{…}\n\n[extra fields]…\n\n[line items]…`(见 structured.ts 的 composeText)。
 * 这里按同样的规则拆回去,得到 fromStructured 需要的输入,就能用当前的代码重放旧收据。
 * 注意: 原始文字里每段回答最多存了 2000 个字符,超长的明细会被截断(极少数很长的票)。
 */
export function outputFromOcrText(ocrText: string): StructuredOutput {
  const core = jsonOf(section(ocrText, 'core fields')), extra = jsonOf(section(ocrText, 'extra fields'))
  const pick = (o: Record<string, unknown> | null, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o![k]]))
  const failed: string[] = []
  if (!core) failed.push('core')
  if (!extra) failed.push('extra')
  if (!jsonOf(section(ocrText, 'line items'))) failed.push('items')
  const answers: { name: string; raw: string }[] = []
  for (const part of ocrText.split(/\n\n(?=\[[a-z][a-z ()]*\]\n)/)) {
    const m = /^\[([a-z][a-z ()]*)\]\n([\s\S]*)$/.exec(part)
    if (m && m[1] !== 'full text') answers.push({ name: m[1]!, raw: m[2]! })
  }
  return {
    fields: { ...pick(core, CORE_FIELDS), ...pick(extra, EXTRA_FIELDS) },
    items: modelItemRows(ocrText, 'main').rows as unknown as unknown[],
    text: fullTextOf(ocrText),
    failed, answers, ms: 0, provider: 'replay',
  }
}

// ---------------------------------------------------------------- 重放与打分
/** 同一张票扫了两次(文件名只差一个 `(1)`,标准答案完全相同)只算一张,免得重复的票把数字推高。保留文件名排在前面的那张。 */
export function dedupeGolden<T extends { file: string; label: Label }>(items: T[]): T[] {
  const seen = new Set<string>()
  return [...items].sort((a, b) => a.file.localeCompare(b.file)).filter((g) => {
    const k = `${g.file.replace(/\(\d+\)(?=\.[^.]+$)/, '')}|${g.label.company}|${g.label.date}|${g.label.total}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export const replay = (g: GoldenItem, opts: { aliasOf?: AliasResolver; isKnown?: (name: string) => boolean } = {}): StructuredExtraction => fromStructured(structuredClone(g.out), opts) // fromStructured 可能改传入的对象,复制一份保证每次重放结果一样

/** 同一张票的不同扫描(文件名只差 `(1)`)算同一张。 */
const receiptKey = (file: string) => file.replace(/\(\d+\)(?=\.[^.]+$)/, '')

/**
 * 「学到商家别名之后」会怎样: 用【留一法】模拟 —— 评测每一张时,别名表只用【别的收据】的「机器读到的商家 → 标准答案商家」建,不含这张自己(也不含同一张票的另一次扫描)。
 * 这对应真实使用: 同一家店被审核员确认过一次以后,下一张同一家店才会受益。第一次见到的店没有任何好处,所以不会高估。
 */
export function replayWithAliases(items: GoldenItem[]): StructuredExtraction[] {
  const base = items.map((g) => replay(g))
  const learned = items.map((g, i) => ({ key: receiptKey(g.file), alias: base[i]!.data.merchant, canonical: g.label.company }))
    .filter((e): e is { key: string; alias: string; canonical: string } => !!e.alias && !!e.canonical && normName(e.alias) !== normName(e.canonical) && similarity(e.alias, e.canonical) < 0.9)
  return items.map((g) => {
    const mine = receiptKey(g.file)
    const counts = new Map<string, AliasEntry>()
    for (const e of learned) {
      if (e.key === mine) continue
      const k = `${normName(e.alias)}|${e.canonical}`
      const cur = counts.get(k)
      if (cur) cur.hits++; else counts.set(k, { alias: e.alias, canonical: e.canonical, hits: 1 })
    }
    const known = new Set(items.filter((o) => receiptKey(o.file) !== mine && o.label.company).map((o) => normName(o.label.company)))
    return replay(g, { aliasOf: makeResolver([...counts.values()]), isKnown: (n) => known.has(normName(n)) })
  })
}

export interface Scored {
  file: string
  status: string
  reasons: string[]
  /** 每项: true 读对 / false 读错 / null 标准答案里没有这一项,不计入。 */
  ok: { total: boolean | null; date: boolean | null; company: boolean | null }
  /** 完整标签才有: 其余金额和商品读对没有。null = 没有完整标签。不计入 allOk / 错放(那三项的定义不变),单独统计。 */
  extra: Partial<Record<ExtraKey, boolean>> | null
  /** 标准答案里有的项全都读对了。 */
  allOk: boolean
  autoPass: boolean
  machine: { merchant: string | null; date: string | null; total: number | null }
}

export const EXTRA_KEYS = ['subtotal', 'tax', 'paid', 'change', 'items'] as const
export type ExtraKey = (typeof EXTRA_KEYS)[number]
const AUTO = new Set(['AUTO_VERIFIED', 'AUTO'])
/** 金额比较: 两边都「没有」(null 或 0)也算对 —— 模型凭空编出一个税额、服务费,这正是最常见的错。 */
const sameMoney = (a: number | null, b: number | null) => (!a && !b) || (a !== null && b !== null && Math.abs(a - b) <= 0.005)
export function score(ex: StructuredExtraction, label: Label, file = ''): Scored {
  const m = ex.data
  const ok = {
    total: label.total === null ? null : m.total !== null && Math.abs(m.total - label.total) <= 0.005,
    date: label.date === null ? null : m.date === label.date,
    company: !label.company ? null : similarity(m.merchant, label.company) >= COMPANY_MATCH,
  }
  const checked = Object.values(ok).filter((v): v is boolean => v !== null)
  const x = label.extra
  const itemsTotal = m.items.length ? Math.round(m.items.reduce((a, i) => a + (i.price ?? 0), 0) * 100) / 100 : null
  const extra = x ? {
    subtotal: sameMoney(m.subtotal, x.subtotal), tax: sameMoney(m.tax, x.tax), paid: sameMoney(m.paid, x.paid), change: sameMoney(m.change, x.change),
    items: m.items.length === x.itemCount && (x.itemCount === 0 || (itemsTotal !== null && x.itemsTotal !== null && Math.abs(itemsTotal - x.itemsTotal) <= 0.02)),
  } : null
  return { file, status: ex.status, reasons: ex.reasons, ok, extra, allOk: checked.length > 0 && checked.every(Boolean), autoPass: AUTO.has(ex.status), machine: { merchant: m.merchant, date: m.date, total: m.total } }
}

// ---------------------------------------------------------------- 汇总
export interface Summary {
  n: number
  fields: Record<'total' | 'date' | 'company', { n: number; ok: number }>
  /** 标准答案里有的项全读对的收据数。 */
  allOk: number
  status: Record<string, number>
  /** 自动通过(基本可信)的收据数,和其中有错的数量 —— 错放。 */
  autoPass: { n: number; wrong: number }
  /** 读错了(至少一项)的收据数;其中被拦下来(没有自动通过)的数量。 */
  wrong: { n: number; caught: number }
  /** 全对的收据里被多余拦下来(没有自动通过)的数量。 */
  falseAlarms: number
  /** 每条原因代码: 出现过几张、其中真的有错的几张(准确率 = withError / flagged)。 */
  reasons: { reason: string; flagged: number; withError: number }[]
  /** 完整标签的收据: 其余金额和商品各读对了多少。没有完整标签时是 undefined。 */
  extra?: Record<ExtraKey, { n: number; ok: number }>
}

const baseReason = (r: string) => (r.startsWith('verifier_disagrees') ? r : r.split(':')[0]!)
export function summarize(scored: Scored[]): Summary {
  const fields = { total: { n: 0, ok: 0 }, date: { n: 0, ok: 0 }, company: { n: 0, ok: 0 } }
  const status: Record<string, number> = {}
  const reasons = new Map<string, { flagged: number; withError: number }>()
  const s: Summary = { n: scored.length, fields, allOk: 0, status, autoPass: { n: 0, wrong: 0 }, wrong: { n: 0, caught: 0 }, falseAlarms: 0, reasons: [] }
  for (const r of scored) {
    for (const k of ['total', 'date', 'company'] as const) if (r.ok[k] !== null) { fields[k].n++; if (r.ok[k]) fields[k].ok++ }
    status[r.status] = (status[r.status] ?? 0) + 1
    if (r.extra) {
      s.extra ??= { subtotal: { n: 0, ok: 0 }, tax: { n: 0, ok: 0 }, paid: { n: 0, ok: 0 }, change: { n: 0, ok: 0 }, items: { n: 0, ok: 0 } }
      for (const k of EXTRA_KEYS) { s.extra[k].n++; if (r.extra[k]) s.extra[k].ok++ }
    }
    if (r.allOk) s.allOk++
    if (r.autoPass) { s.autoPass.n++; if (!r.allOk) s.autoPass.wrong++ }
    if (!r.allOk) { s.wrong.n++; if (!r.autoPass) s.wrong.caught++ } else if (!r.autoPass) s.falseAlarms++
    for (const code of new Set(r.reasons.map(baseReason))) {
      const e = reasons.get(code) ?? { flagged: 0, withError: 0 }
      e.flagged++
      if (!r.allOk) e.withError++
      reasons.set(code, e)
    }
  }
  s.reasons = [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.flagged - a.flagged)
  return s
}

// ---------------------------------------------------------------- 对比基线
export interface Baseline { createdAt: string; note?: string; summary: Summary }
export interface Comparison {
  /** 变差了的安全指标: 有就应该让测试失败。 */
  regressions: string[]
  /** 变好了的指标: 值得更新基线。 */
  improvements: string[]
  /** 只是提醒(例如自动通过变少了,这是有意的取舍时可以接受)。 */
  warnings: string[]
}

/**
 * 同一批样本上对比两次的汇总。安全指标(读对的数量、错放的数量)只要变差就算回归 —— 重放是确定的,不需要容差。
 * 自动通过的数量变少只作提醒: 把规则收紧时它会变少,那是有意的取舍。
 */
export function compare(cur: Summary, base: Summary): Comparison {
  const c: Comparison = { regressions: [], improvements: [], warnings: [] }
  if (cur.n !== base.n) { c.warnings.push(`样本数变了(${base.n} → ${cur.n}):先确认评测集有意改过,再更新基线`); return c }
  const label = { total: '总额', date: '日期', company: '商家' } as const
  for (const k of ['total', 'date', 'company'] as const) {
    const d = cur.fields[k].ok - base.fields[k].ok
    if (d < 0) c.regressions.push(`${label[k]}读对的数量 ${base.fields[k].ok} → ${cur.fields[k].ok}(少了 ${-d} 张)`)
    else if (d > 0) c.improvements.push(`${label[k]}读对的数量 ${base.fields[k].ok} → ${cur.fields[k].ok}`)
  }
  if (cur.autoPass.wrong > base.autoPass.wrong) c.regressions.push(`错放(自动通过但有错)${base.autoPass.wrong} → ${cur.autoPass.wrong} 张`)
  else if (cur.autoPass.wrong < base.autoPass.wrong) c.improvements.push(`错放 ${base.autoPass.wrong} → ${cur.autoPass.wrong} 张`)
  if (cur.wrong.caught < base.wrong.caught && cur.wrong.n >= base.wrong.n) c.regressions.push(`读错的收据被拦下来的数量 ${base.wrong.caught} → ${cur.wrong.caught}`)
  if (cur.autoPass.n < base.autoPass.n) c.warnings.push(`自动通过的数量 ${base.autoPass.n} → ${cur.autoPass.n}(规则收紧时会变少;确认是有意的就更新基线)`)
  else if (cur.autoPass.n > base.autoPass.n && cur.autoPass.wrong <= base.autoPass.wrong) c.improvements.push(`自动通过 ${base.autoPass.n} → ${cur.autoPass.n}(没有多出错放)`)
  return c
}

// ---------------------------------------------------------------- 文字报告
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')
export function formatReport(s: Summary, opts: { title?: string; mismatches?: Scored[] } = {}): string {
  const L: string[] = []
  L.push(`# ${opts.title ?? '评测报告'}(${s.n} 张)`, '')
  L.push('## 读对了多少(机器原始结果 vs 标准答案)')
  for (const [k, zh] of [['total', '总额'], ['date', '日期'], ['company', '商家']] as const) L.push(`- ${zh}: ${s.fields[k].ok}/${s.fields[k].n}  ${pct(s.fields[k].ok, s.fields[k].n)}`)
  L.push(`- 三项全对: ${s.allOk}/${s.n}  ${pct(s.allOk, s.n)}`)
  if (s.extra) {
    L.push('', '## 其余金额和商品(审核员确认过的完整标签)')
    for (const [k, zh] of [['subtotal', '小计'], ['tax', '税额'], ['paid', '实付'], ['change', '找零'], ['items', '商品(行数和合计)']] as const) L.push(`- ${zh}: ${s.extra[k].ok}/${s.extra[k].n}  ${pct(s.extra[k].ok, s.extra[k].n)}`)
  }
  L.push('')
  L.push('## 分流(门户自己的判断)')
  L.push(`- 状态: ${Object.entries(s.status).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  L.push(`- 自动通过(基本可信): ${s.autoPass.n}/${s.n}  ${pct(s.autoPass.n, s.n)}`)
  L.push(`- **错放**(自动通过但其实有错): ${s.autoPass.wrong}/${s.autoPass.n}  ${pct(s.autoPass.wrong, s.autoPass.n)}   ← 最重要的数字,越低越好`)
  L.push(`- 拦截率(读错的收据被交给人工): ${s.wrong.caught}/${s.wrong.n}  ${pct(s.wrong.caught, s.wrong.n)}`)
  L.push(`- 误报(读对了却被拦): ${s.falseAlarms}/${s.allOk}  ${pct(s.falseAlarms, s.allOk)}   ← 决定了要人工看多少`, '')
  L.push('## 每条提示准不准(出现过 N 张,其中真的有错的几张)')
  for (const r of s.reasons.filter((x) => x.reason !== 'scanned_in_portal').slice(0, 25)) L.push(`- ${r.reason.padEnd(36)} ${String(r.flagged).padStart(3)} 张,有错 ${String(r.withError).padStart(3)}  ${pct(r.withError, r.flagged)}`)
  if (opts.mismatches?.length) {
    L.push('', '## 读错的收据')
    for (const r of opts.mismatches) L.push(`- ${r.file}  [${r.status}]  总额${r.ok.total === false ? '✗' : '✓'} 日期${r.ok.date === false ? '✗' : '✓'} 商家${r.ok.company === false ? '✗' : '✓'}  读到: ${r.machine.merchant ?? '—'} | ${r.machine.date ?? '—'} | ${r.machine.total ?? '—'}${r.autoPass ? '   ⚠ 被自动通过了' : ''}`)
  }
  return L.join('\n')
}
