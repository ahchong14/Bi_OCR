/**
 * 双模型对比: 同一批马来西亚收据,同时让【模型 1 MiniCPM-OCR】和【模型 2(PaddleOCR-VL / GLM-OCR)】各读一遍,
 * 输出每个字段两个模型各自的准确率、两个模型一致时的准确率、「至少一个对」的上限、以及速度。
 * 不碰门户的数据库,只读图片、调识别服务、写一个 JSON 到 eval/runs/(原始回答都存着,之后可以离线重算)。
 *
 * 先在【你自己的终端】设环境变量(密钥只留在你的终端):
 *   $env:MINICPM_URL = "https://xxxx.trycloudflare.com"; $env:MINICPM_KEY = "你的密钥"
 *   $env:MINICPM2_URL = "https://xxxx.trycloudflare.com/m2"; $env:MINICPM2_KIND = "paddle"     # 或 glm
 * 然后(在 receipt-portal 目录下):
 *   bun eval/compare-models.ts --n 100                    # 100 张;优先挑「有人工/助手审核值」的,这样小计 / 税额 / 付款 / 商品行也能量化
 *   bun eval/compare-models.ts --n 100 --seed 3
 *   bun eval/compare-models.ts --resume eval/runs/compare-xxxx.json      # 中断了接着跑
 *   bun eval/compare-models.ts --score eval/runs/compare-xxxx.json       # 不调模型,只重新算成绩
 *
 * 标准答案的来源(必须看清楚):
 *   商家 / 日期 / 总额 = SROIE 标准答案(可靠)
 *   小计 / 税额 / 实付 / 找零 / 商品 = 备份库里「助手(claude-assist)逐张审核后的最终值」(--ref-db),【只是参考,不是人工标准答案】。
 *   助手也会看错,所以这几项的数字只能用来比较两个模型谁更接近,不能当绝对准确率。
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { labelsFromCsv, score, type GoldenItem, type Label, type LabelExtra, type Scored } from '../server/lib/evaluate'
import { envFlag, miniCpmProvider } from '../server/lib/minicpm'
import { prepareImage, type StructuredOutput } from '../server/lib/ocr'
import { limiter } from '../server/lib/scan'
import { fromStructured } from '../server/lib/structured'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt }

interface Pair { file: string; label: Label; out1: StructuredOutput | null; out2: StructuredOutput | null; ms1: number; ms2: number; err?: string }
interface Saved { createdAt: string; kind: string; items: Pair[] }

// ---------------------------------------------------------------- 只算成绩
const scoreOnly = arg('score')
const SOLO = process.argv.includes('--solo') // 只跑 MiniCPM,不需要第二个模型
let saved: Saved
const outPath = resolve(arg('resume') || arg('score') || join(root, 'eval', 'runs', `compare-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.json`))

if (scoreOnly) {
  saved = JSON.parse(readFileSync(resolve(scoreOnly), 'utf8')) as Saved
} else {
  const url = (process.env.MINICPM_URL ?? '').trim()
  const url2 = (process.env.MINICPM2_URL ?? '').trim()
  // --solo: 只跑模型 1(MiniCPM),不需要 MINICPM2_URL(混合读法评测用:之后再让 Qwen 读它的转写)
  if (!url || (!SOLO && !url2)) { console.error(SOLO ? '需要设置 MINICPM_URL。' : '需要同时设置 MINICPM_URL 和 MINICPM2_URL(见本文件开头的说明);只测 MiniCPM 请加 --solo。'); process.exit(1) }
  const kind = (process.env.MINICPM2_KIND ?? 'glm').trim().toLowerCase() === 'paddle' ? 'paddle' : 'glm'
  const provider = miniCpmProvider({
    baseUrl: url, apiKey: process.env.MINICPM_KEY || undefined, fullText: envFlag(process.env.MINICPM_FULLTEXT, true),
    timeoutMs: Number(process.env.MINICPM_TIMEOUT_MS) || undefined, concurrency: Number(arg('concurrency')) || undefined,
    ...(SOLO ? {} : { second: { baseUrl: url2, apiKey: process.env.MINICPM2_KEY || process.env.MINICPM_KEY || undefined, model: process.env.MINICPM2_MODEL || undefined, mode: 'off' as const, kind } }),
  })
  if (!provider.extract || (!SOLO && !provider.readSecond)) { console.error('识别服务没有结构化读取 / 第二个读取模型。'); process.exit(1) }

  const imagesDir = resolve(arg('images', join(root, 'receipt data', 'Voxel51_scanned_receipts', 'data')))
  const labels = labelsFromCsv(readFileSync(resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv'))), 'utf8'))
  const n = Number(arg('n', '100')), seed = Number(arg('seed', '1'))

  // 参考值: 备份库里助手审核过的最终值(小计 / 税额 / 实付 / 找零 / 商品)
  let refDir = arg('ref-db', '')
  if (!refDir) { const b = join(root, 'backups'); refDir = existsSync(b) ? join(b, readdirSync(b).sort().at(-1) ?? '') : '' }
  const refs = new Map<string, LabelExtra>()
  if (refDir && existsSync(join(refDir, 'portal.db'))) {
    const db = new Database(join(refDir, 'portal.db'), { readonly: true })
    for (const r of db.query<{ file: string; subtotal: number | null; tax: number | null; paid: number | null; change: number | null; items: string }, []>(
      "SELECT file, subtotal, tax, paid, change, items FROM receipts WHERE state = 'approved' AND review_mode = 'single'").all()) {
      let it: { price?: number | null }[] = []
      try { const v = JSON.parse(r.items); if (Array.isArray(v)) it = v } catch { /* 当没有商品 */ }
      const total = it.length ? Math.round(it.reduce((a, i) => a + (typeof i.price === 'number' ? i.price : 0), 0) * 100) / 100 : null
      refs.set(r.file, { subtotal: r.subtotal, tax: r.tax, paid: r.paid, change: r.change, itemCount: it.length, itemsTotal: total })
    }
    console.log(`参考值: ${refDir}(${refs.size} 张有审核值)`)
  } else console.log('没有找到备份库,小计 / 税额 / 付款 / 商品行不计分(用 --ref-db 指定)。')

  let s = seed >>> 0
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!] } return a }
  const all = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && labels.has(f)).sort()
  const withRef = shuffle(all.filter((f) => refs.has(f))), without = shuffle(all.filter((f) => !refs.has(f)))
  // --files <清单.txt>: 只跑清单里的图(例如评测集里随机的 100 张,看商家分歧标记在普通收据上的代价);不给就是有审核值的优先
  const only = arg('files') ? new Set(readFileSync(resolve(arg('files')), 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) : null
  const picked = only ? all.filter((f) => only.has(f)).slice(0, n) : [...withRef, ...without].slice(0, n) // 默认: 有审核值的优先,这样明细字段也有样本量

  saved = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, 'utf8')) as Saved) : { createdAt: new Date().toISOString(), kind, items: [] }
  saved.kind = kind
  // --resume: 之前失败的(模型 1 或 2 没读出来)不算完成,丢掉重跑;读成功的保留
  saved.items = saved.items.filter((p) => p.out1 && (SOLO || p.out2)) // --solo 只看模型 1 是否读成功
  const done = new Set(saved.items.map((p) => p.file))
  const todo = picked.filter((f) => !done.has(f))
  console.log(`模型 1: ${provider.name} · 模型 2: ${SOLO ? '不用(--solo)' : kind === 'paddle' ? 'PaddleOCR-VL' : 'GLM-OCR'}\n计划 ${picked.length} 张(其中 ${picked.filter((f) => refs.has(f)).length} 张有审核值),已完成 ${picked.length - todo.length},这次跑 ${todo.length} 张 → ${outPath}`)

  const save = () => { mkdirSync(dirname(outPath), { recursive: true }); const t = `${outPath}.tmp`; writeFileSync(t, JSON.stringify(saved, null, 1)); renameSync(t, outPath) }
  const limit = limiter(Number(arg('concurrency')) || 1)
  const t0 = Date.now()
  let fatal: string | null = null
  await Promise.all(todo.map((file, k) => limit(async () => {
    if (fatal) return
    const base = labels.get(file)!
    const label: Label = { ...base, ...(refs.has(file) ? { extra: refs.get(file)! } : {}) }
    try {
      const img = await prepareImage(new Uint8Array(readFileSync(join(imagesDir, file))), provider.maxBytes)
      // 两个模型同时读(通常在两张不同的卡上),各自计时
      const timed = async <T,>(fn: () => Promise<T>) => { const t = performance.now(); try { return { v: await fn(), ms: Math.round(performance.now() - t) } } catch (e) { return { v: null as T | null, ms: Math.round(performance.now() - t), e } } }
      const [a, b] = await Promise.all([timed(() => provider.extract!(img, file)), SOLO ? Promise.resolve({ v: null as StructuredOutput | null, ms: 0 }) : timed(() => provider.readSecond!(img))])
      const ea = (a as { e?: unknown }).e
      if (ea && /401|403|429/.test(String(ea))) fatal = String(ea)
      saved.items.push({ file, label, out1: a.v, out2: b.v, ms1: a.ms, ms2: b.ms, ...(ea ? { err: String(ea).slice(0, 160) } : {}) })
    } catch (e) { saved.items.push({ file, label, out1: null, out2: null, ms1: 0, ms2: 0, err: String(e).slice(0, 160) }) }
    save()
    const last = saved.items[saved.items.length - 1]!
    console.log(`  ${basename(file).padEnd(18)} ${k + 1}/${todo.length}  已用 ${((Date.now() - t0) / 1000).toFixed(0)}s${last.err ? '  ✗ ' + last.err.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 90) : ''}`)
  })))
  save()
  if (fatal) console.error(`\n!! 提前停止: ${fatal}(已跑完的已保存,用 --resume 接着跑)`)
}

// ---------------------------------------------------------------- 成绩
const toScored = (o: StructuredOutput | null, label: Label, file: string): Scored | null =>
  o ? score(fromStructured(structuredClone(o)), label, file) : null
if (SOLO) { // 只有模型 1: 打印读成功数和速度就结束,成绩由 qwen-extract.ts 算(它同时给出 MiniCPM 原生 / 混合的对比)
  const ok = saved.items.filter((p) => p.out1).length
  const ms = saved.items.map((p) => p.ms1).filter((x) => x > 0).sort((p, q) => p - q)
  console.log(`\n# 仅 MiniCPM · ${ok}/${saved.items.length} 张读成功 · 速度中位数 ${ms[Math.floor(ms.length / 2)] ?? 0} ms/张\n下一步: bun eval/qwen-extract.ts ${outPath} --source minicpm`)
  process.exit(0)
}
const rows = saved.items.map((p) => ({ p, a: toScored(p.out1, p.label, p.file), b: toScored(p.out2, p.label, p.file) })).filter((r) => r.a && r.b)
const name2 = saved.kind === 'paddle' ? 'PaddleOCR-VL' : 'GLM-OCR'
const pct = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%`.padStart(6) : '    — ')

type Pick = (s: Scored) => boolean | null | undefined
const FIELDS: { name: string; get: Pick; ref: boolean }[] = [
  { name: '商家', get: (s) => s.ok.company, ref: false }, { name: '日期', get: (s) => s.ok.date, ref: false }, { name: '总额', get: (s) => s.ok.total, ref: false },
  { name: '小计', get: (s) => s.extra?.subtotal, ref: true }, { name: '税额', get: (s) => s.extra?.tax, ref: true }, { name: '实付', get: (s) => s.extra?.paid, ref: true },
  { name: '找零', get: (s) => s.extra?.change, ref: true }, { name: '商品行', get: (s) => s.extra?.items, ref: true },
]
console.log(`\n# 双模型对比 · ${rows.length} 张读成功(共 ${saved.items.length} 张)· 模型 1 MiniCPM-OCR vs 模型 2 ${name2}\n`)
console.log('字段    样本 | 模型1   模型2 | 两者都对  只模型1对  只模型2对  两者都错 | 至少一个对  一致时的准确率')
for (const f of FIELDS) {
  const m = rows.filter((r) => { const x = f.get(r.a!), y = f.get(r.b!); return x !== null && x !== undefined && y !== null && y !== undefined })
  const A = m.filter((r) => f.get(r.a!)).length, B = m.filter((r) => f.get(r.b!)).length
  const both = m.filter((r) => f.get(r.a!) && f.get(r.b!)).length
  const onlyA = m.filter((r) => f.get(r.a!) && !f.get(r.b!)).length, onlyB = m.filter((r) => !f.get(r.a!) && f.get(r.b!)).length
  const neither = m.length - both - onlyA - onlyB
  const agree = m.filter((r) => f.get(r.a!) === f.get(r.b!)) // 两边「对错」相同,不严格等于「读数相同」,够用来估一致时的可靠度
  console.log(`${f.name.padEnd(6)} ${String(m.length).padStart(4)} | ${pct(A, m.length)} ${pct(B, m.length)} | ${String(both).padStart(6)}  ${String(onlyA).padStart(8)}  ${String(onlyB).padStart(9)}  ${String(neither).padStart(7)} | ${pct(both + onlyA + onlyB, m.length)}      ${pct(both, agree.length)}${f.ref ? '   (参考值)' : ''}`)
}
const med = (xs: number[]) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)]! : 0 }
console.log(`\n速度(每张,毫秒,中位数): 模型 1 ${med(saved.items.map((p) => p.ms1))} · 模型 2 ${med(saved.items.map((p) => p.ms2))}`)
console.log(`失败: 模型 1 ${saved.items.filter((p) => !p.out1).length} 张 · 模型 2 ${saved.items.filter((p) => !p.out2).length} 张`)
console.log('\n注: 「参考值」的字段(小计 / 税额 / 实付 / 找零 / 商品行)标准是助手审核值,不是人工标准答案,只适合比较两个模型谁更接近。')
console.log(`原始回答已保存: ${outPath}(--score 可以不调模型重算)`)
