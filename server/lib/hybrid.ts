/**
 * 混合读法(可选,默认关): 商家 / 日期 / 币种 / 总额沿用 MiniCPM-OCR 原生读数,
 * 小计 / 税额 / 折扣 / 服务费 / 舍入 / 实付 / 找零 / 商品行 改用 Qwen 从 MiniCPM 自己的整页转写里抽的值,
 * 再加一道「两个读者对总额 / 日期不一致 → 转人工」。
 *
 * 为什么这样分工(评测集 100 张随机 + 50 张难样本的结论,见 eval/qwen-extract.ts):
 *   · 商家名: 原生 94%,Qwen 75%(Qwen 会选客户名、门店名、去掉公司后缀;标准答案又不统一),所以商家不用 Qwen 的;
 *   · 日期 / 总额: 两边打平,谁都不比谁强,所以沿用原生,Qwen 只用来对照;
 *   · 明细(小计 70% 对 40%、税额 94% 对 66%、实付 / 找零 / 商品行都更好): 原生常把总额抄进实付、把相邻数字抄进找零,Qwen 更老实 → 用 Qwen 的;
 *   · 总额 / 日期不一致(例: 票上 SUBTOTAL 4.51 / TOTAL 4.50,原生读 4.51、Qwen 读 4.50)两个读者一对照就露馅 → 转人工。
 * 结果: 自动通过 66% → 75%,错放没有增加(4 → 4)。
 *
 * 硬约束(Qwen 不能凭空编): 它给出的金额必须能在转写里原样找到,日期必须在转写里有对应的「日 月 年」,否则当作「没有」。
 * 任何失败(没配 Qwen、超时、返回乱码)都原样返回原生读数,扫描照常继续。
 */
import type { QwenOptions } from './second'
import type { StructuredOutput } from './ocr'
import { PRIORITY } from '../../shared/types'
import { fromStructured } from './structured'

export const hybridOpts: { enabled: boolean; timeoutMs: number; resolve: boolean } = { enabled: false, timeoutMs: 30_000, resolve: false }

// ---------------------------------------------------------------- 提示词与输出格式
const nullable = (t: string) => ({ type: [t, 'null'] })
export const DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    merchant_name: nullable('string'), date: nullable('string'), currency: nullable('string'),
    subtotal: nullable('number'), tax_amount: nullable('number'), total: nullable('number'),
    discount_amount: nullable('number'), service_charge_amount: nullable('number'), rounding_adjustment: nullable('number'),
    amount_paid: nullable('number'), change_given: nullable('number'),
    line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: nullable('number'), amount: nullable('number') }, required: ['description', 'quantity', 'amount'] } },
  },
  required: ['merchant_name', 'date', 'currency', 'subtotal', 'tax_amount', 'total', 'discount_amount', 'service_charge_amount', 'rounding_adjustment', 'amount_paid', 'change_given', 'line_items'],
}
export const DETAIL_SYSTEM = `You extract fields from the OCR transcript of ONE receipt (mostly Malaysian, amounts in RM). Use ONLY the transcript; never invent a value.
- merchant_name: the SELLER, i.e. the business that issued this receipt: the name printed in the header at the top of the receipt, exactly as printed (trading name or shop name), without registration number, branch code or address. It is NOT the customer: ignore any name that follows 'Bill To', 'Sold To', 'Customer', 'Deliver To', 'Ship To', 'Attn', 'Kepada'. If the header shows a shop/brand name and a separate registered company line, use the header shop/brand name.
- date: YYYY-MM-DD. Malaysian receipts are day-first (28-01-18 = 2018-01-28). If the transcript has no date, return null.
- total: the final amount to pay (after rounding / GST), NOT the cash tendered, NOT a pre-rounding subtotal.
- subtotal / tax_amount / discount_amount / service_charge_amount / rounding_adjustment: only if printed; otherwise null.
- amount_paid: the amount tendered (cash / card). change_given: the change. Otherwise null.
- line_items: one entry per purchased product (description, quantity, line amount). Do NOT include totals, tax, GST summary, payment or rounding lines.
Every number you return must appear in the transcript. Return JSON only.`

// ---------------------------------------------------------------- 出处检查(硬约束)
/** 日期必须有出处: 转写里要有一个「日 月 年」三个数字齐全的日期(顺序不限,年份 2 位或 4 位都行,只有年份才补 20xx)。 */
export function dateInText(iso: string, text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const Y = Number(m[1]), M = Number(m[2]), D = Number(m[3])
  for (const t of text.matchAll(/(\d{1,4})[-/.\s](\d{1,2})[-/.\s](\d{1,4})/g)) {
    const g = [Number(t[1]), Number(t[2]), Number(t[3])]
    for (let i = 0; i < 3; i++) {
      const year = g[i]! < 100 ? 2000 + g[i]! : g[i]!
      if (year !== Y) continue
      const rest = g.filter((_, j) => j !== i)
      if ((rest[0] === D && rest[1] === M) || (rest[0] === M && rest[1] === D)) return true
    }
  }
  return false
}

const strip = (s: string) => s.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '')
/** 把 Qwen 的回答规整成「模型字段」的格式('###' = 没有),金额和日期过出处检查。 */
export function guardFields(raw: Record<string, unknown>, text: string): Record<string, unknown> {
  const nums = new Set((text.match(/\d[\d.,]*[.,]\d{2}(?!\d)/g) ?? []).map(strip))
  const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && nums.has(strip(v.toFixed(2))) ? v.toFixed(2) : '###')
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '###')
  const date = (v: unknown) => (typeof v === 'string' && dateInText(v, text) ? v : '###')
  return {
    merchant_name: str(raw.merchant_name), date: date(raw.date), currency: str(raw.currency),
    subtotal: money(raw.subtotal), tax_amount: money(raw.tax_amount), total: money(raw.total),
    discount_amount: money(raw.discount_amount), service_charge_amount: money(raw.service_charge_amount), rounding_adjustment: money(raw.rounding_adjustment),
    amount_paid: money(raw.amount_paid), change_given: money(raw.change_given),
  }
}

// ---------------------------------------------------------------- 调用 Qwen
/** strict = true(评测脚本用): HTTP 错误和网络错误直接抛出(让脚本能区分「隧道断了」和「Qwen 没返回内容」);默认吞掉返回 null(门户用,绝不影响扫描)。 */
export async function qwenExtract(q: QwenOptions, text: string, timeoutMs = hybridOpts.timeoutMs, strict = false): Promise<Record<string, unknown> | null> {
  const f = q.fetchImpl ?? fetch
  try {
    const res = await f(`${q.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(q.apiKey ? { authorization: `Bearer ${q.apiKey}` } : {}) },
      body: JSON.stringify({
        model: q.model || 'qwen', temperature: 0, max_tokens: 1800,
        messages: [{ role: 'system', content: DETAIL_SYSTEM }, { role: 'user', content: `Transcript:\n${text.slice(0, 6000)}` }],
        response_format: { type: 'json_schema', json_schema: { name: 'receipt', schema: DETAIL_SCHEMA } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) { if (strict) throw new Error(`HTTP ${res.status}`); console.warn(`[hybrid] Qwen HTTP ${res.status}`); return null }
    const c = ((await res.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
    if (typeof c !== 'string') return null
    const j = JSON.parse(c)
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch (e) {
    if (strict) throw e
    console.warn(`[hybrid] Qwen 调用失败: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

// ---------------------------------------------------------------- 合并
/** 这几个字段用 Qwen 的值;Qwen 说「没有」就当作没有(原生常把总额抄进实付,不退回原生的值)。 */
export const DETAIL_FROM_QWEN = ['subtotal', 'tax_amount', 'discount_amount', 'service_charge_amount', 'rounding_adjustment', 'amount_paid', 'change_given'] as const

export interface HybridResult {
  out: StructuredOutput
  /** true = 用了 Qwen 的明细字段;false = Qwen 不可用,原样返回原生读数。 */
  used: boolean
  /** 两个读者读得不一样、而且没能裁判出来的核心字段('total' / 'date'),非空就该转人工。 */
  disagree: string[]
  /** 两个读者不一样,算术 / 合理性裁判后采用了 Qwen 读数的字段(hybridOpts.resolve 打开时才会有)。 */
  adopted: string[]
}

export async function hybridMerge(o: StructuredOutput, q: QwenOptions | null | undefined): Promise<HybridResult> {
  const none: HybridResult = { out: o, used: false, disagree: [], adopted: [] }
  if (!q || !o.text?.trim()) return none
  const raw = await qwenExtract(q, o.text)
  if (!raw) return none
  return mergeWithRaw(o, raw)
}

/** 状态高低 + 提示条数: 越大越好。两个候选读数让门户自己的对账 / 分流来打分。 */
const gradeOf = (o: StructuredOutput): [number, number] => { const e = fromStructured(structuredClone(o)); return [PRIORITY[e.status], -e.reasons.length] }
const better = (x: [number, number], y: [number, number]) => x[0] > y[0] || (x[0] === y[0] && x[1] > y[1])

/**
 * 已经有了 Qwen 的原始回答,做合并(不调网络,所以评测可以离线重算)。
 * 明细字段取 Qwen 的;总额 / 日期两个读者不一样时:
 *   · hybridOpts.resolve = false(默认): 只标出来,转人工;
 *   · hybridOpts.resolve = true: 先让算术裁判 —— 把两个候选各放进去过一遍门户的对账 / 分流,Qwen 的候选更好(状态更高,或状态一样提示更少)就采用它,
 *     否则保留原生的并标分歧。日期没有算术可对,只处理一种情况: 原生的日期不可能(date_implausible / 缺日期)而 Qwen 的日期有出处且可能 → 采用 Qwen 的。
 */
export function mergeWithRaw(o: StructuredOutput, raw: Record<string, unknown>): HybridResult {
  const qf = guardFields(raw, o.text)
  const fields: Record<string, unknown> = { ...o.fields }
  for (const k of DETAIL_FROM_QWEN) fields[k] = qf[k] ?? '###'
  const items = (Array.isArray(raw.line_items) ? raw.line_items : []).map((i) => {
    const r = i as Record<string, unknown>
    return { description: String(r.description ?? ''), quantity: r.quantity ?? null, amount: r.amount ?? null }
  })
  let out: StructuredOutput = {
    ...o, fields, items: items.length ? items : o.items,
    answers: [...(o.answers ?? []), { name: 'qwen_detail', raw: JSON.stringify(raw).slice(0, 2000) }],
  }
  // 两个读者对总额 / 日期各读一遍(都过同一套规整),不一样就找出来
  const a = fromStructured(structuredClone(o)).data
  const b = fromStructured(structuredClone({ ...o, fields: { ...o.fields, ...pickCore(qf) } })).data
  const disagree: string[] = []
  const adopted: string[] = []
  if (a.total !== null && b.total !== null && qf.total !== '###' && Math.abs(a.total - b.total) > 0.005) {
    const alt: StructuredOutput = { ...out, fields: { ...out.fields, total: qf.total } }
    if (hybridOpts.resolve && better(gradeOf(alt), gradeOf(out))) { out = alt; adopted.push('total') } else disagree.push('total')
  }
  if (b.date !== null && qf.date !== '###' && (a.date === null || a.date !== b.date)) {
    const nat = fromStructured(structuredClone(out))
    const nativeBad = a.date === null || nat.reasons.some((r) => r === 'date_implausible' || r === 'missing_date')
    if (hybridOpts.resolve && nativeBad) {
      const alt: StructuredOutput = { ...out, fields: { ...out.fields, date: qf.date } }
      const altE = fromStructured(structuredClone(alt))
      if (!altE.reasons.includes('date_implausible') && !altE.reasons.includes('missing_date')) { out = alt; adopted.push('date') } else if (a.date !== null) disagree.push('date')
    } else if (a.date !== null) disagree.push('date')
  }
  return { out, used: true, disagree, adopted }
}
const pickCore = (qf: Record<string, unknown>) => ({ total: qf.total, date: qf.date })
