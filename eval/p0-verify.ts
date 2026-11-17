/**
 * P0 —— 在真实 Anthropic 接口上验证(IMPLEMENTATION-PLAN 第 4.1 节)。
 *
 * 为什么要做: 到现在为止,识别器的请求参数、结构化输出、长条形收据的读取质量,**都只用假客户端测过,从来没有在真实接口上跑过**。
 * 这个脚本把这些一次问清楚,输出一份报告,我根据它定 P2 的提示词和输出格式。
 *
 * 会花钱: 默认只是「演习」(只列出会做什么、估算费用);加 --run 才真的调用。图片会发送到 Anthropic。
 * 密钥: 只从环境变量 ANTHROPIC_API_KEY 读取,脚本不打印、不保存密钥。
 *
 *   # 演习(不调用接口,不花钱)
 *   bun eval/p0-verify.ts
 *   # 真跑(默认用 SROIE 的 6 张零售小票)
 *   bun eval/p0-verify.ts --run
 *   # 加上你自己的发票 / 订单等(子文件夹名 = 类型名,见下),每类最多 3 张
 *   bun eval/p0-verify.ts --run --docs D:\my-docs
 *
 * --docs 文件夹的结构(子文件夹名必须是这些之一,放几张就行,没有的类型可以不建):
 *   receipt  sales_invoice  purchase_invoice  sales_order  quotation  delivery_order  credit_note  other
 *
 * 参数: --run  --images N(默认 6)  --receipts-dir <目录>  --docs <目录>  --docs-per-type N(默认 3)  --model <名字>
 *       --max-cost <美元,默认 1>  --only 1,2,3(只跑某几项:1 参数 2 结构化输出 3 长收据)  --seed N  --out <文件>
 *
 * 第一轮真实结果(2026-11-17)的教训已经写进来了: 结构化输出的 Schema 不能有太多「可空」类型(API 拒绝了 48 个),
 * 所以现在的 Schema 用空字符串表示「没印」;结构化被拒时脚本会完整打印 API 的原因,并退回「仅提示词」继续做分类测试。
 */
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { DOC_TYPES, isDocType, type DocType } from '../shared/doctypes'
import { DOC_PROMPT_VERSION, DOC_SYSTEM, MODEL_DOC_SCHEMA, docPrompt } from '../server/lib/docPrompt'
import { TEXT_PROMPT } from '../server/lib/claude'
import { validate } from '../server/tests/helpers/jsonschema'

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const arg = (n: string, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d }
const root = resolve(import.meta.dir, '..')
const RUN = has('run')
const MODEL = arg('model', 'claude-haiku-5-5')
const N_IMAGES = Math.max(1, Number(arg('images', '6')) || 6)
const RECEIPTS_DIR = resolve(arg('receipts-dir', 'D:\\ai-video-generation-model\\receipt-portal\\receipt data\\Voxel51_scanned_receipts\\data'))
const DOCS_DIR = arg('docs', '') ? resolve(arg('docs')) : ''
const PER_TYPE = Math.max(1, Number(arg('docs-per-type', '3')) || 3)
const MAX_COST = Number(arg('max-cost', '1')) || 1
const SEED = Number(arg('seed', '7')) || 7
const ONLY = new Set((arg('only', '1,2,3')).split(',').map((x) => x.trim()))
const MAX_EDGE = 1568
const PRICE_IN = 0.1 / 1e6 // Haiku 5.5: $0.10 / 百万输入 token(提示 ≤ 10 万 token),$0.50 / 百万输出 token —— 只用来估算,以账单为准
const PRICE_OUT = 0.5 / 1e6

if (has('help')) { console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0]); process.exit(0) }

// ---------------------------------------------------------------- 收集图片
interface Img { path: string; name: string; truth: DocType; source: 'receipts' | 'docs' }
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const lcg = (s: number) => () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const shuffle = <T,>(a: T[], rnd: () => number) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!] } return b }

const images: Img[] = []
const warnings: string[] = []
if (existsSync(RECEIPTS_DIR)) {
  const files = readdirSync(RECEIPTS_DIR).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort()
  for (const f of shuffle(files, lcg(SEED)).slice(0, N_IMAGES)) images.push({ path: join(RECEIPTS_DIR, f), name: f, truth: 'receipt', source: 'receipts' })
} else warnings.push(`找不到零售小票文件夹: ${RECEIPTS_DIR}(用 --receipts-dir 指定,或只用 --docs)`)
if (DOCS_DIR) {
  if (!existsSync(DOCS_DIR)) warnings.push(`找不到 --docs 文件夹: ${DOCS_DIR}`)
  else for (const sub of readdirSync(DOCS_DIR, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue
    if (!isDocType(sub.name)) { warnings.push(`--docs 里的子文件夹 "${sub.name}" 不是类型名,已跳过(类型名: ${DOC_TYPES.join(', ')})`); continue }
    const files = readdirSync(join(DOCS_DIR, sub.name)).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort()
    for (const f of shuffle(files, lcg(SEED)).slice(0, PER_TYPE)) images.push({ path: join(DOCS_DIR, sub.name, f), name: `${sub.name}/${f}`, truth: sub.name, source: 'docs' })
  }
}

// ---------------------------------------------------------------- 演习
const plannedCalls = (ONLY.has('1') ? 4 : 0) + (ONLY.has('2') ? images.length + Math.min(4, images.length) : 0) + (ONLY.has('3') ? 9 : 0)
const estimate = plannedCalls * (2600 * PRICE_IN + 2500 * PRICE_OUT)
console.log(`\n# P0 真实接口验证  ·  模型 ${MODEL}  ·  提示词版本 ${DOC_PROMPT_VERSION}`)
console.log(`图片: ${images.length} 张(零售小票 ${images.filter((i) => i.source === 'receipts').length},你的单据 ${images.filter((i) => i.source === 'docs').length})`)
for (const t of DOC_TYPES) { const n = images.filter((i) => i.truth === t).length; if (n) console.log(`  · ${t}: ${n}`) }
for (const w of warnings) console.log(`注意: ${w}`)
console.log(`计划: 最多约 ${plannedCalls} 次调用,粗估 $${estimate.toFixed(3)}(上限保护 $${MAX_COST})`)
if (!RUN) {
  console.log('\n这是演习,没有调用接口,没有花钱。确认没问题后加 --run 真正运行。')
  if (images.some((i) => i.source === 'docs')) console.log('提醒: 你的单据图片会发送到 Anthropic。')
  process.exit(0)
}
const keyEnv = (process.env.ANTHROPIC_API_KEY ?? '').trim()
if (!keyEnv) { console.error('\n没有设置 ANTHROPIC_API_KEY。请在这个窗口里设好再运行(脚本不会显示它)。'); process.exit(1) }
console.log(`密钥: 已设置(${keyEnv.startsWith('sk-ant-') ? '格式看起来对' : '注意: 不是以 sk-ant- 开头,可能设错了'},不显示)`)
if (!images.length) { console.error('没有可用的图片。'); process.exit(1) }

// ---------------------------------------------------------------- 调用
const client = new Anthropic({ maxRetries: 0, timeout: 120_000 }) // 不自动重试: 要看到接口的原始反应
let spent = 0
interface Rec { id: string; label: string; ok: boolean; status?: number; error?: string; ms: number; inTok: number; outTok: number; stop?: string | null; text?: string }
const records: Rec[] = []

async function call(id: string, label: string, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Rec> {
  if (spent > MAX_COST) throw new Error(`费用上限 $${MAX_COST} 已到,停止(已花约 $${spent.toFixed(3)})`)
  const t = performance.now()
  let rec: Rec
  try {
    const r = await client.messages.create(params)
    const text = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim()
    rec = { id, label, ok: true, ms: Math.round(performance.now() - t), inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, stop: r.stop_reason, text }
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined
    // 错误信息可能回显请求头,统一把疑似密钥的片段抹掉再记录
    const msg = String(e instanceof Error ? e.message : e).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***').slice(0, 900)
    rec = { id, label, ok: false, status, error: msg, ms: Math.round(performance.now() - t), inTok: 0, outTok: 0 }
  }
  spent += rec.inTok * PRICE_IN + rec.outTok * PRICE_OUT
  records.push(rec)
  return rec
}

// ---------------------------------------------------------------- 图片处理
const b64 = (buf: Buffer) => buf.toString('base64')
async function prep(path: string, buf?: Buffer): Promise<{ data: string; w: number; h: number; ow: number; oh: number }> {
  const src = buf ?? readFileSync(path)
  const meta = await sharp(src, { failOn: 'none' }).metadata()
  const swap = (meta.orientation ?? 1) >= 5
  const [ow, oh] = swap ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0]
  const out = await sharp(src, { failOn: 'none' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
  return { data: b64(out.data), w: out.info.width, h: out.info.height, ow, oh }
}
async function half(path: string, which: 'top' | 'bottom'): Promise<string> {
  const rotated = await sharp(readFileSync(path), { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true })
  const { width, height } = rotated.info
  const part = Math.round(height * 0.58) // 两半各占 58%,中间重叠,免得一行字正好被切在中间
  const top = which === 'top' ? 0 : height - part
  const cropped = await sharp(rotated.data).extract({ left: 0, top, width, height: part }).toBuffer()
  return (await prep(path, cropped)).data
}
const content = (data: string, text: string): Anthropic.ContentBlockParam[] => [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text }]
const med = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)]! : 0 }
const tryJson = (s: string | undefined): Record<string, any> | null => {
  if (!s) return null
  const t = s.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '')
  const i = t.indexOf('{'), j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

const verdicts: { id: string; ok: boolean | null; text: string }[] = []
const verdict = (id: string, ok: boolean | null, text: string) => { verdicts.push({ id, ok, text }); console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'} ${id}  ${text}`) }
const result: Record<string, unknown> = { model: MODEL, promptVersion: DOC_PROMPT_VERSION, startedAt: new Date().toISOString() }
const prepared = new Map<string, Awaited<ReturnType<typeof prep>>>()
for (const im of images) prepared.set(im.path, await prep(im.path))
let structuredOk = false

try {
  // ============================================================ 0.1 请求参数
  if (ONLY.has('1')) {
    console.log('\n## 0.1 当前请求参数能不能被接受(每个变体 1 次小调用)')
    const first = prepared.get(images[0]!.path)!
    const variants: { id: string; label: string; extra: Record<string, unknown>; expectFail?: boolean }[] = [
      { id: '0.1a', label: '线上现在用的: thinking 关 + effort low', extra: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } } },
      { id: '0.1b', label: '不传 thinking(默认自适应)+ effort low', extra: { output_config: { effort: 'low' } } },
      { id: '0.1c', label: 'thinking 关,不传 effort', extra: { thinking: { type: 'disabled' } } },
      { id: '0.1d', label: '带 temperature 0.2(文档说 Haiku 5.5 会 400)', extra: { thinking: { type: 'disabled' }, temperature: 0.2 }, expectFail: true },
    ]
    for (const v of variants) {
      const r = await call(v.id, v.label, { model: MODEL, max_tokens: 200, system: DOC_SYSTEM, messages: [{ role: 'user', content: content(first.data, 'Reply with just the name of the business printed at the top of this document.') }], ...(v.extra as object) } as Anthropic.MessageCreateParamsNonStreaming)
      if (v.expectFail) verdict(v.id, !r.ok && r.status === 400, r.ok ? `没有被拒绝(和文档不符): ${r.text?.slice(0, 60)}` : `被拒绝 HTTP ${r.status},和文档一致: ${r.error?.slice(0, 120)}`)
      else verdict(v.id, r.ok, r.ok ? `接受,${r.ms} ms,输入 ${r.inTok} / 输出 ${r.outTok} token,回答: ${r.text?.slice(0, 50)}` : `HTTP ${r.status}: ${r.error}`)
    }
    result.params = records.filter((r) => r.id.startsWith('0.1')).map(({ text: _t, ...rest }) => rest)
  }

  // ============================================================ 0.2 结构化输出 + 0.5 分类烟雾测试
  const smoke: { img: Img; parsed: Record<string, any> | null; violations: string[]; rec: Rec }[] = []
  if (ONLY.has('2')) {
    console.log('\n## 0.2 结构化输出(JSON Schema)是否可用  +  0.5 分类烟雾测试')
    const mk = (img: Img, structured: boolean): Anthropic.MessageCreateParamsNonStreaming => ({
      model: MODEL, max_tokens: 6000, system: DOC_SYSTEM, thinking: { type: 'disabled' },
      output_config: structured ? { effort: 'low', format: { type: 'json_schema', schema: MODEL_DOC_SCHEMA as unknown as Record<string, unknown> } } : { effort: 'low' },
      messages: [{ role: 'user', content: content(prepared.get(img.path)!.data, docPrompt({ structured })) }],
    })
    // 先试结构化输出。被 API 拒绝时把完整原因打出来(第一轮就是因为「可空类型太多」被拒绝的),然后退回「仅提示词」继续做分类测试
    const probe = images[0]!
    const first = await call('0.2-s-probe', '结构化输出(Schema 里没有可空类型)', mk(probe, true))
    structuredOk = first.ok
    if (!first.ok) {
      verdict('0.2-S', false, `Schema 被 API 拒绝 HTTP ${first.status}。完整原因: ${first.error}`)
      console.log('    (这是「这份 Schema 不合要求」,不等于「结构化输出这个功能不可用」。请把上面的原因贴给我,我据此再改 Schema。下面改用「仅提示词」继续做分类测试。)')
    }
    const mode = structuredOk ? 's' : 'p'
    for (const img of images) {
      const rec = structuredOk && img === probe ? first : await call(`0.2-${mode}-${basename(img.name)}`, `${structuredOk ? '结构化' : '仅提示词'}: ${img.name}`, mk(img, structuredOk))
      const parsed = rec.ok && rec.stop !== 'max_tokens' ? tryJson(rec.text) : null
      smoke.push({ img, parsed, rec, violations: parsed ? validate(MODEL_DOC_SCHEMA as never, parsed) : [rec.ok ? (rec.stop === 'max_tokens' ? '输出被 max_tokens 截断' : '回答不是 JSON') : `HTTP ${rec.status}: ${rec.error?.slice(0, 160)}`] })
    }
    const parseOk = smoke.filter((x) => x.parsed).length
    const clean = smoke.filter((x) => x.parsed && x.violations.length === 0).length
    const viol = [...new Set(smoke.flatMap((x) => x.violations))].slice(0, 3).join('; ')
    if (structuredOk) {
      verdict('0.2', parseOk === smoke.length && clean === smoke.length, `结构化输出可用: ${parseOk}/${smoke.length} 张解析成功,${clean}/${smoke.length} 张完全符合 Schema${clean < smoke.length ? `(违规: ${viol})` : ''}`)
      // 对照: 同样的图,不用结构化输出,只靠提示词
      const cmp = images.slice(0, Math.min(4, images.length))
      let cmpOk = 0
      const cmpWhy: string[] = []
      for (const img of cmp) {
        const rec = await call(`0.2-p-${basename(img.name)}`, `仅提示词: ${img.name}`, mk(img, false))
        const p = rec.ok ? tryJson(rec.text) : null
        const bad = !rec.ok ? [`HTTP ${rec.status}`] : !p ? [rec.stop === 'max_tokens' ? '输出被截断' : `解析不出 JSON(开头: ${JSON.stringify((rec.text ?? '').slice(0, 60))})`] : validate(MODEL_DOC_SCHEMA as never, p)
        if (bad.length === 0) cmpOk++
        else cmpWhy.push(...bad.slice(0, 2))
      }
      // 第二轮真实运行里这一项是 0/4,但只知道结果不知道原因 —— 现在把原因打出来(最常见的怀疑: 模型在没有强制 Schema 时返回了 null 或数字,而不是空字符串 / 字符串)
      verdict('0.2b', null, `对照(仅提示词、不用结构化输出): ${cmpOk}/${cmp.length} 张解析成功且符合 Schema${cmpWhy.length ? `  问题: ${[...new Set(cmpWhy)].slice(0, 5).join('; ')}` : ''}`)
    } else {
      verdict('0.2p', null, `仅提示词: ${parseOk}/${smoke.length} 张解析成功,${clean}/${smoke.length} 张符合 Schema${clean < smoke.length ? `(问题: ${viol})` : ''}`)
    }
    result.structured = { structuredOk, rows: smoke.map((x) => ({ image: x.img.name, truth: x.img.truth, ok: !!x.parsed, violations: x.violations, ms: x.rec.ms, inTok: x.rec.inTok, outTok: x.rec.outTok, parsed: x.parsed })) }

    // ---------------- 0.5 分类烟雾测试
    const scored = smoke.filter((x) => x.parsed)
    if (scored.length) {
      const hit = scored.filter((x) => x.parsed!.document_type === x.img.truth)
      const labelled = images.some((i) => i.source === 'docs')
      verdict('0.5', labelled ? hit.length / scored.length >= 0.8 : null, `分类: ${hit.length}/${scored.length} 张和标签一致${labelled ? '' : '(只有零售小票,只能看有没有把收据认成别的)'}`)
      const types = DOC_TYPES.filter((t) => scored.some((x) => x.img.truth === t || x.parsed!.document_type === t))
      console.log('\n    混淆矩阵(行 = 标签,列 = 模型判断):')
      const short = (t: string) => t.replace('_invoice', '_inv').replace('delivery_order', 'delivery').replace('credit_note', 'credit').slice(0, 9).padEnd(9)
      console.log('    ' + ''.padEnd(10) + types.map(short).join(' '))
      for (const tr of types) console.log('    ' + tr.slice(0, 9).padEnd(10) + types.map((pr) => String(scored.filter((x) => x.img.truth === tr && x.parsed!.document_type === pr).length).padEnd(9)).join(' '))
      const right = scored.filter((x) => x.parsed!.document_type === x.img.truth).map((x) => Number(x.parsed!.confidence))
      const wrong = scored.filter((x) => x.parsed!.document_type !== x.img.truth).map((x) => Number(x.parsed!.confidence))
      console.log(`\n    把握度: 判对的平均 ${right.length ? (right.reduce((a, b) => a + b, 0) / right.length).toFixed(2) : '—'},判错的平均 ${wrong.length ? (wrong.reduce((a, b) => a + b, 0) / wrong.length).toFixed(2) : '—'}(判错的明显更低才说明把握度可信)`)
      console.log('\n    逐张(请对照原图看证据 / 标题 / 关键词是否合理;没印出来的是空):')
      const show = (v: unknown) => (v === '' || v === undefined || v === null ? '—' : String(v))
      for (const x of scored) {
        const p = x.parsed!
        console.log(`    - ${x.img.name}\n        判断 ${p.document_type} (${Number(p.confidence).toFixed(2)})${p.document_type === x.img.truth ? '' : `  ← 标签是 ${x.img.truth}`}  语言 ${p.language}  开单方 ${show(p.issuer?.name)}  对方 ${show(p.counterparty?.name)}\n        证据 ${JSON.stringify(p.evidence)}  印的标题 ${JSON.stringify(p.title_printed)}\n        标题 ${JSON.stringify(p.title)}\n        关键词 ${JSON.stringify(p.keywords)}\n        总额 ${show(p.total)}  税 ${show(p.tax_amount)}  实付 ${show(p.amount_paid)}  行数 ${p.line_items?.length ?? 0}  单号 ${show(p.doc_no)}  日期 ${show(p.doc_date)}  税号 ${show(p.issuer?.tax_id)}  注册号 ${show(p.issuer?.reg_no)}`)
      }
    }
  }

  // ============================================================ 0.3 长条形收据
  if (ONLY.has('3')) {
    console.log('\n## 0.3 长条形收据: 缩到 1568 像素后,一整张读 vs 上下两半分别读(金额 + 长数字)')
    const metas = await Promise.all(images.map(async (im) => ({ im, p: prepared.get(im.path)! })))
    // 先在已选的图里找最长的;不够 3 张再去零售小票文件夹里多扫一些找长的
    const pool = metas.map((m) => ({ path: m.im.path, name: m.im.name, ratio: m.p.oh / Math.max(1, m.p.ow), ow: m.p.ow, oh: m.p.oh }))
    if (pool.filter((x) => x.ratio >= 2.2).length < 3 && existsSync(RECEIPTS_DIR)) {
      for (const f of readdirSync(RECEIPTS_DIR).filter((x) => IMG_EXT.has(extname(x).toLowerCase())).slice(0, 150)) {
        const path = join(RECEIPTS_DIR, f)
        if (pool.some((x) => x.path === path)) continue
        const m = await sharp(path, { failOn: 'none' }).metadata()
        const swap = (m.orientation ?? 1) >= 5
        const [ow, oh] = swap ? [m.height ?? 0, m.width ?? 0] : [m.width ?? 0, m.height ?? 0]
        pool.push({ path, name: f, ratio: oh / Math.max(1, ow), ow, oh })
      }
    }
    const longs = pool.filter((x) => x.ratio >= 2.2).sort((a, b) => b.ratio - a.ratio).slice(0, 3)
    if (!longs.length) verdict('0.3', null, `没有找到高宽比 ≥ 2.2 的长条形图片(最长 ${Math.max(...pool.map((x) => x.ratio)).toFixed(1)}),这一项跳过。如果你的真实单据有很长的,请用 --docs 放几张进来`)
    const numsOf = (s: string) => new Set((s.match(/\d{1,6}[.,]\d{2}\b/g) ?? []).map((x) => x.replace(',', '.')))
    const idsOf = (s: string) => new Set(s.match(/\d{9,}/g) ?? []) // 税号 / 注册号 / 单据号这类长数字
    const lineTail = (s: string) => s.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 160)
    const rows03: Record<string, unknown>[] = []
    const t03 = (id: string, label: string, data: string) => call(id, label, { model: MODEL, max_tokens: 4096, system: DOC_SYSTEM, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, messages: [{ role: 'user', content: content(data, TEXT_PROMPT) }] })
    for (const l of longs) {
      const p = prepared.get(l.path) ?? (await prep(l.path))
      const full = await t03(`0.3-full-${l.name}`, `整张: ${l.name}`, p.data)
      const top = await t03(`0.3-top-${l.name}`, `上半: ${l.name}`, await half(l.path, 'top'))
      const bot = await t03(`0.3-bottom-${l.name}`, `下半: ${l.name}`, await half(l.path, 'bottom'))
      const nf = numsOf(full.text ?? '')
      const nh = new Set([...numsOf(top.text ?? ''), ...numsOf(bot.text ?? '')])
      const onlyHalves = [...nh].filter((x) => !nf.has(x))
      const onlyFull = [...nf].filter((x) => !nh.has(x))
      const idf = idsOf(full.text ?? '')
      const idh = new Set([...idsOf(top.text ?? ''), ...idsOf(bot.text ?? '')])
      const idOnlyFull = [...idf].filter((x) => !idh.has(x))
      const idOnlyHalves = [...idh].filter((x) => !idf.has(x))
      console.log(`\n    ${l.name}  原图 ${l.ow}×${l.oh}(高宽比 ${l.ratio.toFixed(1)}),发给模型时 ${p.w}×${p.h}`)
      console.log(`      金额数字: 整张读到 ${nf.size} 个,上下两半合起来 ${nh.size} 个;只有分开读才读到 ${onlyHalves.length} 个 ${JSON.stringify(onlyHalves.slice(0, 8))},只有整张读到 ${onlyFull.length} 个`)
      console.log(`      长数字(≥ 9 位): 整张 ${JSON.stringify([...idf])}  |  分开 ${JSON.stringify([...idh])}${idOnlyFull.length || idOnlyHalves.length ? '   ← 同一串数字两次读得不一样!' : ''}`)
      console.log(`      整张读的最后几行: ${lineTail(full.text ?? '')}`)
      console.log(`      下半读的最后几行: ${lineTail(bot.text ?? '')}`)
      rows03.push({ image: l.name, ratio: l.ratio, full: nf.size, halves: nh.size, onlyHalves: onlyHalves.length, onlyFull: onlyFull.length, idMismatch: idOnlyFull.length + idOnlyHalves.length })
    }
    if (longs.length) {
      const gain = rows03.reduce((a, r) => a + Number(r.onlyHalves), 0)
      verdict('0.3', gain === 0, gain === 0 ? '金额: 分开读没有多读到数字 → 暂时不需要把长票切成两段' : `金额: 分开读多读到 ${gain} 个数字 → 建议长条形单据切成上下两段分别读(P2 加一个按高宽比触发的切分)`)
      const idBad = rows03.reduce((a, r) => a + Number(r.idMismatch), 0)
      verdict('0.3b', idBad === 0, idBad === 0 ? '长数字(税号 / 注册号 / 单据号): 两次读取一致' : `长数字: ${idBad} 处两次读取不一致 → 税号 / 注册号 / 单据号不能只信一次读取,P2 要对这类字段做二次核对或标记「需检查」`)
    }
    result.longReceipts = rows03
  }
} catch (e) {
  console.error(`\n中途停止: ${e instanceof Error ? e.message : e}`)
}

// ============================================================ 0.4 耗时与 token / 0.6 费用
console.log('\n## 0.4 耗时与 token  /  0.6 费用')
const okRecs = records.filter((r) => r.ok)
const classRecs = okRecs.filter((r) => /^0\.2-s-/.test(r.id)).length ? okRecs.filter((r) => /^0\.2-s-/.test(r.id)) : okRecs.filter((r) => /^0\.2-p-/.test(r.id))
const classLabel = structuredOk ? '分类 + 读字段(结构化)' : '分类 + 读字段(仅提示词)'
const transcriptRecs = okRecs.filter((r) => r.id.startsWith('0.3-full'))
const line = (name: string, rs: Rec[]) => rs.length && console.log(`  ${name.padEnd(26)} ${String(rs.length).padStart(3)} 次  耗时中位数 ${String(med(rs.map((r) => r.ms))).padStart(6)} ms  输入中位数 ${String(med(rs.map((r) => r.inTok))).padStart(5)}  输出中位数 ${String(med(rs.map((r) => r.outTok))).padStart(5)} token`)
line(classLabel, classRecs)
line('整页转写', transcriptRecs)
const perDoc = med(classRecs.map((r) => r.inTok * PRICE_IN + r.outTok * PRICE_OUT))
const perTranscript = med(transcriptRecs.map((r) => r.inTok * PRICE_IN + r.outTok * PRICE_OUT))
if (classRecs.length) verdict('0.6', null, `每张的费用(估算): 分类 + 字段 ≈ $${perDoc.toFixed(5)}${transcriptRecs.length ? `,加一次转写 ≈ $${(perDoc + perTranscript).toFixed(5)}` : ''}  ·  每 1000 张 ≈ $${((perDoc + (transcriptRecs.length ? perTranscript : 0)) * 1000).toFixed(2)}`)
else if (transcriptRecs.length) verdict('0.6', null, `一次整页转写 ≈ $${perTranscript.toFixed(5)}(分类这一步这次没有成功的调用,没法估)`)
const failed = records.filter((r) => !r.ok && !r.id.startsWith('0.1d'))
console.log(`  本次共 ${records.length} 次调用,失败 ${failed.length} 次(0.1d 是故意被拒绝的,不算),估算已花 $${spent.toFixed(4)}(以 Anthropic 账单为准)`)

// ---------------------------------------------------------------- 结论与保存
console.log('\n## 结论(给 P2 的决定)')
const v = (id: string) => verdicts.find((x) => x.id === id)
if (v('0.1a')) console.log(v('0.1a')!.ok ? '  · 线上现在的请求参数可用,保持不变。' : '  · 线上现在的请求参数被拒绝!先看上面 0.1a 的错误信息,这是现在就存在的问题。')
if (v('0.2')) console.log(v('0.2')!.ok ? '  · 采用结构化输出。' : '  · 结构化输出可用,但有违规 / 解析失败,看上面说明再定是否采用。')
else if (v('0.2-S')) console.log('  · 结构化输出的 Schema 被 API 拒绝(完整原因在 0.2 一节)。请把原因贴给我,我据此再改 Schema;在那之前 P2 可以用「提示词 + 解析器」兜底。')
if (v('0.3')?.ok === false) console.log('  · 长条形单据需要切分读取,P2 加进去。')
if (v('0.3b')?.ok === false) console.log('  · 长数字(税号 / 注册号 / 单据号)读取不稳定,P2 对它们加二次核对或转人工。')

mkdirSync(join(root, 'eval', 'runs'), { recursive: true })
const out = resolve(arg('out', join(root, 'eval', 'runs', `p0-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.json`)))
writeFileSync(out, JSON.stringify({ ...result, finishedAt: new Date().toISOString(), spentEstimateUsd: Math.round(spent * 10000) / 10000, verdicts, calls: records.map(({ text: _t, ...r }) => r) }, null, 1))
const underRuns = out.startsWith(join(root, 'eval', 'runs'))
console.log(`\n完整结果已保存: ${out}(不含密钥,不含图片;含模型读到的内容${underRuns ? ',在 eval/runs 里,已被 .gitignore 忽略' : ',注意不要提交到 git'})`)
console.log('请把上面「## 0.1」到「结论」这一整段输出贴给我(里面没有密钥)。')
