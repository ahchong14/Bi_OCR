/**
 * 用真实的识别服务(Kaggle 上的 MiniCPM-OCR,可选第二个读取模型 GLM-OCR)跑一批有标准答案的收据,
 * 把模型的【原始回答】存下来。之后随时可以离线重放(bun eval/report.ts --runs …),不用再调模型。
 *
 * 先在【你自己的终端】里设好环境变量(和启动门户时一样;密钥只在你的终端里,不要发给任何人):
 *   $env:MINICPM_URL = "https://xxxx.trycloudflare.com"
 *   $env:MINICPM_KEY = "你的密钥"
 *   $env:MINICPM2_URL = "https://xxxx.trycloudflare.com/m2"     # 可选: 第二个读取模型
 * 然后(在 receipt-portal 目录下):
 *   bun eval/run-live.ts --n 50                       # 随机挑 50 张(固定种子,每次挑的一样)
 *   bun eval/run-live.ts --n 200 --seed 2             # 换一批
 *   bun eval/run-live.ts --resume eval/runs/xxx.json  # 中断了接着跑(已经跑完的会跳过)
 *
 * 不会碰门户的数据库,也不会写任何收据进去。只读图片、调识别服务、写一个 JSON 文件到 eval/runs/。
 * 默认跳过已经在评测集(eval/golden/golden.json)里的收据,这样每次跑的都是新的;要包含它们加 --include-golden。
 * 遇到密钥错误或限流就立刻停下(已跑完的都已保存)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { labelsFromCsv, type GoldenItem } from '../server/lib/evaluate'
import { envFlag, miniCpmProvider } from '../server/lib/minicpm'
import { extractWithRetry, isOcrError, prepareImage } from '../server/lib/ocr'
import { limiter } from '../server/lib/scan'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt }
const flag = (name: string) => process.argv.includes(`--${name}`)

const url = (process.env.MINICPM_URL ?? '').trim()
if (!url) {
  console.error('没有设置 MINICPM_URL。请先在你自己的终端里设置 MINICPM_URL / MINICPM_KEY(见本文件开头的说明)。')
  process.exit(1)
}
const url2 = (process.env.MINICPM2_URL ?? '').trim()
const provider = miniCpmProvider({
  baseUrl: url, apiKey: process.env.MINICPM_KEY || undefined, model: process.env.MINICPM_MODEL || undefined,
  fullText: envFlag(process.env.MINICPM_FULLTEXT, true), timeoutMs: Number(process.env.MINICPM_TIMEOUT_MS) || undefined,
  concurrency: Number(arg('concurrency')) || Number(process.env.MINICPM_CONCURRENCY) || undefined,
  second: url2 ? { baseUrl: url2, apiKey: process.env.MINICPM2_KEY || process.env.MINICPM_KEY || undefined, model: process.env.MINICPM2_MODEL || undefined } : undefined,
})
if (!provider.extract) { console.error('这个识别服务没有结构化读取(extract),不能评测。'); process.exit(1) }

const imagesDir = resolve(arg('images', join(root, 'receipt data', 'Voxel51_scanned_receipts', 'data')))
const labelsPath = resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv')))
const goldenPath = join(root, 'eval', 'golden', 'golden.json')
const n = Number(arg('n', '50'))
const seed = Number(arg('seed', '1'))
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
const outPath = resolve(arg('resume') || join(root, 'eval', 'runs', `run-${stamp}.json`))
if (!existsSync(imagesDir)) { console.error(`找不到图片目录: ${imagesDir}(用 --images 指定)`); process.exit(1) }
if (!existsSync(labelsPath)) { console.error(`找不到标准答案: ${labelsPath}(用 --labels 指定)`); process.exit(1) }

const labels = labelsFromCsv(readFileSync(labelsPath, 'utf8'))
const done: GoldenItem[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, 'utf8')) as { items: GoldenItem[] }).items ?? [] : []
const doneSet = new Set(done.map((g) => g.file))
const inGolden = new Set<string>(!flag('include-golden') && existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenItem[]).map((g) => g.file) : [])

// 固定种子的洗牌(mulberry32): 同样的 --seed 每次挑出同一批
let s = seed >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pool = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && labels.has(f) && !inGolden.has(f)).sort()
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
const todo = pool.slice(0, n).filter((f) => !doneSet.has(f))

console.log(`识别服务: ${provider.name}${url2 ? '  + 第二个读取模型' : ''}`)
console.log(`计划 ${Math.min(n, pool.length)} 张(其中已跑完 ${Math.min(n, pool.length) - todo.length} 张),这次要跑 ${todo.length} 张。结果保存到 ${outPath}`)
if (!todo.length) { console.log('没有要跑的了。'); process.exit(0) }

const errors: { file: string; error: string }[] = []
const save = () => {
  mkdirSync(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.tmp`
  writeFileSync(tmp, JSON.stringify({ createdAt: new Date().toISOString(), provider: provider.name, second: !!url2, seed, items: done, errors }, null, 1))
  renameSync(tmp, outPath) // 先写临时文件再改名: 写到一半被打断也不会把已有结果写坏
}

const limit = limiter(provider.concurrency ?? 1)
let fatal: string | null = null
let ok = 0 // 这一次成功的张数
const t0 = Date.now()
await Promise.all(todo.map((file, k) => limit(async () => {
  if (fatal) return
  try {
    const prepared = await prepareImage(new Uint8Array(readFileSync(join(imagesDir, file))), provider.maxBytes)
    const out = await extractWithRetry(provider as typeof provider & { extract: NonNullable<typeof provider.extract> }, prepared, file)
    done.push({ file, label: labels.get(file)!, out })
    ok++
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push({ file, error: msg.slice(0, 200) })
    if (isOcrError(e) && (e.code === 'AUTH' || e.code === 'RATE_LIMIT' || e.code === 'TOO_BIG')) fatal = `${e.code}: ${msg}`
  }
  save()
  const finished = ok
  const secs = (Date.now() - t0) / 1000
  const rate = finished > 0 ? secs / finished : 0
  console.log(`  ${basename(file).padEnd(18)} ${finished + errors.length}/${todo.length}  已用 ${secs.toFixed(0)}s${rate ? `  预计还要 ${Math.max(0, Math.round(rate * (todo.length - finished - errors.length) / 60))} 分钟` : ''}${errors.some((x) => x.file === file) ? '  ✗ 出错' : ''}`)
})))

save()
console.log(fatal ? `\n!! 提前停止: ${fatal}(已跑完的 ${done.length} 张已保存)` : `\n完成: 成功 ${done.length} · 失败 ${errors.length}`)
console.log(`下一步: bun eval/report.ts --runs ${outPath} --mismatches`)
if (fatal) process.exit(2)
