/**
 * 用 Qwen 从【已经存下来的整页转写】里抽字段,再和文字规则合起来,和模型 1(MiniCPM)原生读数一起对比。
 * 不重新读图,不碰门户数据库;只调用 Kaggle 上的 Qwen(纯文字,很轻)。
 *
 *   $env:MINICPM_URL = "https://xxxx.trycloudflare.com"; $env:MINICPM_KEY = "你的密钥"    (走网关的 /qwen)
 *   bun eval/qwen-extract.ts eval/runs/compare-xxxx.json                       # 用 PaddleOCR 的转写(out2.text)让 Qwen 抽,结果存到 eval/runs/qwen-xxxx.json
 *   bun eval/qwen-extract.ts eval/runs/qwen-xxxx.json --source minicpm         # 再用 MiniCPM 自己的整页转写(out1.text)让 Qwen 抽
 *   bun eval/qwen-extract.ts --score eval/runs/qwen-xxxx.json                  # 不调模型,只重算成绩
 *
 * 硬约束(和第二意见一样): Qwen 给出的金额和日期必须能在转写里找到,否则当作「没有」;不让它凭空编。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { score, type Label, type Scored } from '../server/lib/evaluate'
import { extractFromText } from '../server/lib/extract'
import type { StructuredOutput } from '../server/lib/ocr'
import { fromStructured } from '../server/lib/structured'
import { PRIORITY } from '../shared/types'

interface Pair {
  file: string; label: Label; out1: StructuredOutput | null; out2: StructuredOutput | null; ms1: number; ms2: number
  out3?: StructuredOutput | null; ms3?: number // Qwen 读 Paddle 的转写
  out5?: StructuredOutput | null; ms5?: number // Qwen 读 MiniCPM 的转写
}
interface Saved { createdAt: string; kind: string; items: Pair[] }
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : '' }
const input = arg('score') || process.argv.slice(2).find((a) => a.endsWith('.json'))
if (!input) { console.error('用法: bun eval/qwen-extract.ts <compare-或-qwen-xxxx.json> [--source minicpm] | --score <qwen-xxxx.json>'); process.exit(1) }
const saved = JSON.parse(readFileSync(resolve(input), 'utf8')) as Saved
const outPath = arg('score') ? resolve(arg('score')) : join(dirname(resolve(input)), `qwen-${basename(input).replace(/^(compare|qwen)-/, '')}`)

import { dateInText, guardFields as guard, qwenExtract } from '../server/lib/hybrid'

/** 调 Qwen(走网关的 /qwen,地址和密钥来自环境变量),提示词和输出格式和门户共用同一份(server/lib/hybrid.ts)。 */
async function ask(text: string): Promise<Record<string, unknown> | null> {
  const base = (process.env.MINICPM_URL ?? '').trim().replace(/[/]+$/, '')
  if (!base) throw new Error('没有设置 MINICPM_URL')
  return qwenExtract({ baseUrl: `${base}/qwen`, apiKey: process.env.MINICPM_KEY || undefined }, text, 180_000, true)
}

// 两种转写来源: paddle = 模型 2 的转写(out2.text),minicpm = 模型 1 自己的整页转写(out1.text)。结果分别存在 out3 / out5。
const SRC = {
  paddle: { text: (p: Pair) => p.out2?.text ?? '', get: (p: Pair) => p.out3, set: (p: Pair, o: StructuredOutput | null, ms: number) => { p.out3 = o; p.ms3 = ms } },
  minicpm: { text: (p: Pair) => p.out1?.text ?? '', get: (p: Pair) => p.out5, set: (p: Pair, o: StructuredOutput | null, ms: number) => { p.out5 = o; p.ms5 = ms } },
} as const
type SrcKey = keyof typeof SRC
const source: SrcKey = arg('source') === 'minicpm' ? 'minicpm' : 'paddle'

/** 文字规则(门户的 extractFromText)从一份转写里抽的字段,格式和模型字段一致('###' = 没有)。 */
function rulesFields(text: string): Record<string, unknown> {
  const d = extractFromText(text).data
  const n = (v: number | null) => (v === null ? '###' : v.toFixed(2))
  return {
    merchant_name: d.merchant ?? '###', date: d.date ?? '###', currency: d.currency ?? '###', subtotal: n(d.subtotal), tax_amount: n(d.tax), total: n(d.total),
    discount_amount: n(d.discount), service_charge_amount: n(d.service_charge), rounding_adjustment: n(d.rounding), amount_paid: n(d.paid), change_given: n(d.change),
  }
}

if (!arg('score')) {
  const S = SRC[source]
  // --redo: 改了提示词之后,清掉这个来源已有的 Qwen 结果,全部重新读
  if (process.argv.includes('--redo')) for (const p of saved.items) S.set(p, null, 0)
  let done = 0
  for (const p of saved.items) {
    const text = S.text(p)
    if (S.get(p) || !text) continue // 已经读成功的跳过;失败(null)的下次重试
    const t = performance.now()
    let out: StructuredOutput | null = null
    try {
      const raw = await ask(text)
      if (raw) {
        const items = (Array.isArray(raw.line_items) ? raw.line_items : []).map((i) => {
          const r = i as Record<string, unknown>
          return { description: String(r.description ?? ''), quantity: r.quantity ?? null, amount: r.amount ?? null }
        })
        const fields = guard(raw, text)
        out = { fields, items, text, failed: [], answers: [{ name: 'core', raw: JSON.stringify(fields) }, { name: 'qwen_raw', raw: JSON.stringify(raw) }], ms: 0, provider: `qwen-on-${source}` }
      }
    } catch (e) {
      console.warn(`  ${p.file} 失败: ${e instanceof Error ? e.message : e}`)
      // 鉴权 / 限流 / 隧道不通(530、502…)继续试也没用,立刻停,不要把失败当结果存下来
      if (/HTTP (401|403|429|5\d\d)/.test(String(e))) { console.error('\n!! 服务不可用,先停。检查 Kaggle 笔记本是否还在运行、隧道地址有没有变,再重跑(已读成功的会跳过)。'); break }
    }
    const ms = Math.round(performance.now() - t)
    S.set(p, out, ms)
    done++
    writeFileSync(outPath, JSON.stringify(saved, null, 1))
    console.log(`  ${p.file.padEnd(20)} ${done}  ${ms}ms`)
  }
  writeFileSync(outPath, JSON.stringify(saved, null, 1))
}

// ---------------------------------------------------------------- Qwen + 文字规则
/** 把 Qwen 抽的字段和「文字规则从同一份转写里抽的字段」合起来:
 *  1) Qwen 没读到(### 或被出处检查丢掉)的,用规则的值补上;
 *  2) 两边都有但不一样的,逐个字段试一下换成规则的值,用门户自己的对账 / 分流(fromStructured)来裁判:
 *     换了之后状态更好(更接近「基本可信」)、或状态一样但提示更少,才换;否则保留 Qwen 的。
 *  没有第三个模型参与,所有判断都来自转写本身和算术互相印证。 */
const KEYS = ['total', 'date', 'merchant_name', 'subtotal', 'tax_amount', 'amount_paid', 'change_given'] as const
const rank = (o: StructuredOutput) => { const e = fromStructured(structuredClone(o)); return { pr: PRIORITY[e.status], n: e.reasons.length } }
function combine(qwen: StructuredOutput | null | undefined, text: string): StructuredOutput | null {
  if (!qwen || !text) return null
  const rules = rulesFields(text), fields: Record<string, unknown> = { ...qwen.fields }
  const empty = (v: unknown) => v === undefined || v === null || v === '###' || v === ''
  for (const k of Object.keys(rules)) if (empty(fields[k]) && !empty(rules[k])) fields[k] = rules[k]
  let cur: StructuredOutput = { ...qwen, fields }
  for (const k of KEYS) {
    const a = fields[k], b = rules[k]
    if (empty(a) || empty(b) || String(a) === String(b)) continue
    const alt: StructuredOutput = { ...cur, fields: { ...cur.fields, [k]: b } }
    const x = rank(cur), y = rank(alt)
    if (y.pr > x.pr || (y.pr === x.pr && y.n < x.n)) { cur = alt; fields[k] = b }
  }
  return { ...cur, provider: 'qwen+rules' }
}

// ---------------------------------------------------------------- 混合: 商家 / 日期 / 币种 / 总额取 MiniCPM 原生,明细字段取 Qwen
/** 随机 100 张的结果: 商家名上 Qwen 明显不如原生(94% 对 75%),但明细字段(小计 / 税额 / 实付 / 找零 / 商品行)Qwen 更好。
 *  所以核心字段保留原生读数,只把明细字段换成 Qwen 的(Qwen 没读到的字段退回原生的值),商品行也用 Qwen 的。 */
const CORE_FROM_NATIVE = ['merchant_name', 'date', 'currency', 'total'] as const
const DETAIL_FROM_QWEN = ['subtotal', 'tax_amount', 'discount_amount', 'service_charge_amount', 'rounding_adjustment', 'amount_paid', 'change_given'] as const
function hybrid(p: Pair): StructuredOutput | null {
  if (!p.out1 || !p.out5) return null
  const fields: Record<string, unknown> = { ...p.out1.fields }
  // Qwen 说「没有」('###',或金额在转写里找不到被丢掉)就当作没有,不退回原生的值: 原生常把总额抄进实付、把相邻数字抄进找零(见 structured.ts 的「抄值」),Qwen 更老实
  for (const k of DETAIL_FROM_QWEN) fields[k] = p.out5.fields[k] ?? '###'
  for (const k of CORE_FROM_NATIVE) fields[k] = p.out1.fields[k]
  return { ...p.out1, fields, items: p.out5.items.length ? p.out5.items : p.out1.items, provider: 'native-core+qwen-detail' }
}

/** 在混合的基础上加「两个读者对总额 / 日期不一致 → 转人工」: 原生读 4.51、Qwen 读 4.50(票上 SUBTOTAL 4.51 / TOTAL 4.50)这种差一分钱的错,
 *  两个读者一对照就露馅。做法: 总额或日期两边(经过同一套规整之后)不一样,就把这个字段清空,门户会因为「缺总额 / 缺日期」转人工。商家名不参与(店名写法本来就不统一)。 */
function hybridGuarded(p: Pair): StructuredOutput | null {
  const h = hybrid(p)
  if (!h || !p.out5) return h
  const a = fromStructured(structuredClone(p.out1!)).data, q = fromStructured(structuredClone(p.out5)).data
  const fields = { ...h.fields }
  if (q.total !== null && a.total !== null && Math.abs(q.total - a.total) > 0.005) fields.total = '###'
  if (q.date !== null && a.date !== null && q.date !== a.date) fields.date = '###'
  return { ...h, fields, provider: 'hybrid-guarded' }
}

// 已经存下来的 Qwen 结果也补上日期出处检查(旧版本没有这一步),这样不用重新调 Qwen 就能看到效果
for (const S of Object.values(SRC)) for (const p of saved.items) {
  const o = S.get(p), text = S.text(p)
  if (o && typeof o.fields.date === 'string' && o.fields.date !== '###' && !dateInText(o.fields.date, text)) o.fields.date = '###'
}

// ---------------------------------------------------------------- 成绩
const sc = (o: StructuredOutput | null | undefined, p: Pair): Scored | null => (o ? score(fromStructured(structuredClone(o)), p.label, p.file) : null)
const hasPaddle = saved.items.some((p) => p.out3), hasMini = saved.items.some((p) => p.out5)
const READERS: { name: string; get: (p: Pair) => StructuredOutput | null | undefined }[] = [
  { name: 'MiniCPM原生', get: (p) => p.out1 },
  ...(hasPaddle ? [{ name: 'Paddle+规则', get: (p: Pair) => p.out2 }, { name: 'Paddle+Qwen', get: (p: Pair) => p.out3 }, { name: 'Paddle+Qwen+规则', get: (p: Pair) => combine(p.out3, p.out2?.text ?? '') }] : []),
  ...(hasMini ? [{ name: 'MiniCPM文+Qwen', get: (p: Pair) => p.out5 }, { name: 'MiniCPM文+Qwen+规则', get: (p: Pair) => combine(p.out5, p.out1?.text ?? '') }, { name: '混合(核心原生+明细Qwen)', get: (p: Pair) => hybrid(p) }, { name: '混合+分歧转人工', get: (p: Pair) => hybridGuarded(p) }, { name: '混合+规则', get: (p: Pair) => combine(hybrid(p), p.out1?.text ?? '') }] : []),
]
const rows = saved.items.map((p) => ({ p, s: READERS.map((r) => sc(r.get(p), p)) })).filter((r) => r.s.every(Boolean))
const F: { name: string; get: (s: Scored) => boolean | null | undefined; ref: boolean }[] = [
  { name: '商家', get: (s) => s.ok.company, ref: false }, { name: '日期', get: (s) => s.ok.date, ref: false }, { name: '总额', get: (s) => s.ok.total, ref: false },
  { name: '小计', get: (s) => s.extra?.subtotal, ref: true }, { name: '税额', get: (s) => s.extra?.tax, ref: true }, { name: '实付', get: (s) => s.extra?.paid, ref: true },
  { name: '找零', get: (s) => s.extra?.change, ref: true }, { name: '商品行', get: (s) => s.extra?.items, ref: true },
]
const pct = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const W = 22
console.log(`\n# 读法对比 · ${rows.length} 张\n`)
console.log('字段    样本 | ' + READERS.map((r) => r.name.padEnd(W)).join(' ') + '| 全部至少一个对')
for (const f of F) {
  const m = rows.filter((r) => r.s.every((s) => { const v = f.get(s!); return v !== null && v !== undefined }))
  const cells = READERS.map((_, i) => pct(m.filter((r) => f.get(r.s[i]!)).length, m.length).padEnd(W))
  const any = m.filter((r) => r.s.some((s) => f.get(s!))).length
  console.log(`${f.name.padEnd(6)} ${String(m.length).padStart(4)} | ${cells.join(' ')}| ${pct(any, m.length)}${f.ref ? '  (参考值)' : ''}`)
}
// 门户的分流结果: 每种读法有几张会被自动通过、其中有几张其实读错了(错放)。这才是「准确 + 省人工」的综合指标
console.log('\n分流(用门户同一套规则): 自动通过 / 其中错放 / 三项全对')
READERS.forEach((r, i) => {
  const auto = rows.filter((x) => x.s[i]!.autoPass), wrong = auto.filter((x) => !x.s[i]!.allOk).length
  console.log(`  ${r.name.padEnd(W)} 自动通过 ${String(auto.length).padStart(3)}/${rows.length}(${pct(auto.length, rows.length)}) · 错放 ${wrong} · 三项全对 ${rows.filter((x) => x.s[i]!.allOk).length}/${rows.length}`)
})

// 「读错」和「没读到」要分开看: 没读到会被转人工,没有害处;读错了还被放行才是真正的风险
console.log('\n商家 / 日期 / 总额里「给了错的值」和「没读到」的张数(错值才危险,没读到只是转人工):')
for (const [name, key, get] of [['商家', 'merchant', (s: Scored) => s.ok.company], ['日期', 'date', (s: Scored) => s.ok.date], ['总额', 'total', (s: Scored) => s.ok.total]] as const) {
  const cells = READERS.map((r, i) => {
    const m = rows.filter((x) => get(x.s[i]!) !== null)
    const present = (s: Scored) => s.machine[key] !== null && s.machine[key] !== undefined
    return `${r.name} 错${m.filter((x) => present(x.s[i]!) && !get(x.s[i]!)).length}/漏${m.filter((x) => !present(x.s[i]!)).length}`
  })
  console.log(`  ${name}: ${cells.join(' | ')}`)
}
const med = (xs: number[]) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)]! : 0 }
console.log(`\n速度(中位数,毫秒): MiniCPM ${med(saved.items.map((p) => p.ms1))} · Paddle 转写 ${med(saved.items.map((p) => p.ms2))} · Qwen 抽字段(Paddle 文本) ${med(saved.items.map((p) => p.ms3 ?? 0))} · Qwen 抽字段(MiniCPM 文本) ${med(saved.items.map((p) => p.ms5 ?? 0))}`)
console.log(`注: 「参考值」字段的标准是助手审核值,不是人工标准答案。结果存在 ${outPath}`)
