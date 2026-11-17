/**
 * 通过【已经在运行的门户】扫描一批有标准答案的收据,再把每张的模型原始回答取回来存成评测用的 run 文件。
 * 门户自己已经连着 Kaggle(密钥在门户进程里),所以这里不需要任何密钥。
 *
 *   bun eval/run-via-portal.ts --n 100                 # 默认门户地址 http://127.0.0.1:8080
 *   bun eval/run-via-portal.ts --n 100 --seed 2
 *   bun eval/run-via-portal.ts --resume eval/runs/portal-xxxx.json
 *   bun eval/run-via-portal.ts --include-golden --only eval/runs/files-50.txt --n 50    # 只扫清单里的图(见 eval/pick-reviewed.ts)
 *
 * 注意: 这些收据会真的进到门户里(出现在审核列表、计入数据),和手动点「扫描」一样。
 * 默认跳过已在评测集里的收据;图片内容已经在门户里的(重复)会被门户识别为重复,不会再调模型。
 * 只用门户的公开接口: POST /api/scan、GET /api/receipts/:id。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { labelsFromCsv, outputFromOcrText, type GoldenItem } from '../server/lib/evaluate'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt }
const flag = (name: string) => process.argv.includes(`--${name}`)

const portal = arg('portal', 'http://127.0.0.1:8080').replace(/\/$/, '')
const imagesDir = resolve(arg('images', join(root, 'receipt data', 'Voxel51_scanned_receipts', 'data')))
const labelsPath = resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv')))
const goldenPath = join(root, 'eval', 'golden', 'golden.json')
const n = Number(arg('n', '100'))
const seed = Number(arg('seed', '1'))
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
const outPath = resolve(arg('resume') || join(root, 'eval', 'runs', `portal-${stamp}.json`))
const H = { 'x-portal': '1' }

const info = (await fetch(`${portal}/api/scan/info`).then((r) => r.json()).catch(() => null)) as { enabled?: boolean; provider?: string } | null
if (!info?.enabled) { console.error(`门户 ${portal} 没有开启扫描,或连不上。`); process.exit(1) }
console.log(`门户: ${portal}   识别服务: ${info.provider}`)

const labels = labelsFromCsv(readFileSync(labelsPath, 'utf8'))
type Saved = { createdAt: string; provider: string; seed: number; items: GoldenItem[]; ids: Record<string, number>; errors: { file: string; error: string }[] }
const saved: Saved = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { createdAt: new Date().toISOString(), provider: info.provider ?? '', seed, items: [], ids: {}, errors: [] }
saved.ids ??= {}
const save = () => { mkdirSync(dirname(outPath), { recursive: true }); const t = `${outPath}.tmp`; writeFileSync(t, JSON.stringify(saved, null, 1)); renameSync(t, outPath) }

const inGolden = new Set<string>(!flag('include-golden') && existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenItem[]).map((g) => g.file) : [])
let s = seed >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const only = arg('only') ? new Set(readFileSync(resolve(arg('only')), 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) : null // --only <文件清单.txt>: 只扫清单里的图
const pool = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && labels.has(f) && !inGolden.has(f) && (!only || only.has(f))).sort()
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
const picked = pool.slice(0, n)
const todo = picked.filter((f) => !(f in saved.ids))
console.log(`计划 ${picked.length} 张,已完成 ${picked.length - todo.length} 张,这次要扫 ${todo.length} 张 → ${outPath}`)

const t0 = Date.now()
let done = 0, dup = 0
for (const file of todo) {
  try {
    const bytes = readFileSync(join(imagesDir, file))
    const res = await fetch(`${portal}/api/scan?file=${encodeURIComponent(file)}`, { method: 'POST', headers: H, body: bytes, signal: AbortSignal.timeout(15 * 60_000) })
    if (res.status === 429) { console.error('\n!! 识别服务限流(429),先停下。已完成的都已保存。'); break }
    if (!res.ok) { const msg = (await res.text()).slice(0, 160); saved.errors.push({ file, error: `HTTP ${res.status} ${msg}` }); save(); console.log(`  ${file.padEnd(22)} ✗ HTTP ${res.status}`); if (res.status === 401 || res.status === 403) break; continue }
    const o = (await res.json()) as { id: number | null; duplicate: boolean }
    if (o.id === null) { saved.errors.push({ file, error: 'no id' }); save(); continue }
    if (o.duplicate) dup++
    saved.ids[file] = o.id
    done++
  } catch (e) {
    saved.errors.push({ file, error: e instanceof Error ? e.message.slice(0, 160) : String(e) })
  }
  save()
  const secs = (Date.now() - t0) / 1000
  const left = todo.length - done - saved.errors.filter((x) => todo.includes(x.file)).length
  console.log(`  ${file.padEnd(22)} ${done}/${todo.length}  已用 ${(secs / 60).toFixed(1)} 分钟  预计还要 ${done ? Math.round(((secs / done) * Math.max(0, left)) / 60) : '?'} 分钟`)
}

// 取回每张的模型原始回答(门户存在 ocrText 里),还原成可重放的评测样本
console.log('\n取回模型原始回答……')
const have = new Set(saved.items.map((g) => g.file))
let fetched = 0
for (const [file, id] of Object.entries(saved.ids)) {
  if (have.has(file)) continue
  const d = (await fetch(`${portal}/api/receipts/${id}`, { headers: H }).then((r) => r.json()).catch(() => null)) as { ocrText?: string } | null
  if (!d?.ocrText || !/\[core fields\]/.test(d.ocrText)) { saved.errors.push({ file, error: '门户里没有模型回答(可能是重复收据或识别失败)' }); continue }
  saved.items.push({ file, label: labels.get(file)!, out: outputFromOcrText(d.ocrText) })
  fetched++
}
save()
console.log(`扫描完成 ${done} 张(其中门户判定重复 ${dup} 张)· 取回回答 ${fetched} 张 · 失败 ${saved.errors.length} 张`)
console.log(`下一步: bun eval/report.ts --runs ${outPath} --mismatches`)
