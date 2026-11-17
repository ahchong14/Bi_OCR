/**
 * 挑一批「从没测过」的新收据,写成图片清单,给 compare-models.ts --files 用(需要读图,所以要开 Kaggle)。
 *
 *   bun eval/make-fresh.ts --n 100 --seed 11            # → eval/runs/files-fresh100.txt
 *   bun eval/compare-models.ts --solo --n 100 --files eval/runs/files-fresh100.txt
 *   bun eval/qwen-extract.ts eval/runs/compare-<新生成的>.json --source minicpm
 *
 * 「用过」= eval/runs 下所有 .json / .txt / .log 里出现过的图片文件名(双模型对比、门户跑分、清单都算)。
 * 数据集 = receipt data 下有标注(labels csv)的图。不会改动任何已有文件。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { labelsFromCsv } from '../server/lib/evaluate'

const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const n = Number(arg('n', '100')), seed = Number(arg('seed', '11'))
const root = resolve(import.meta.dir, '..')
const imagesDir = resolve(arg('images', join(root, 'receipt data', 'Voxel51_scanned_receipts', 'data')))
const labels = labelsFromCsv(readFileSync(resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv'))), 'utf8'))
const all = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && labels.has(f)).sort()

// 用过的: runs 目录里出现过的所有文件名
const runs = join(root, 'eval', 'runs')
const used = new Set<string>()
for (const f of readdirSync(runs).filter((x) => /\.(json|txt|log)$/i.test(x))) {
  const text = readFileSync(join(runs, f), 'utf8')
  for (const m of text.matchAll(/[\w\-. ]+\.(?:jpe?g|png|webp)/gi)) used.add(m[0]!.trim())
}
const pool = all.filter((f) => !used.has(f))

let s = seed >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
const picked = pool.slice(0, n).sort()

const out = join(runs, `files-fresh${n}.txt`)
if (existsSync(out)) { console.error(`${out} 已存在,不覆盖。换 --seed 或先改名。`); process.exit(1) }
writeFileSync(out, picked.join('\n') + '\n')
console.log(`有标注的图 ${all.length} 张,已用过 ${all.length - pool.length} 张,可选 ${pool.length} 张,挑出 ${picked.length} 张 → ${out}`)
