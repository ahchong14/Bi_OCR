/**
 * 从评测集(eval/golden/golden.json,626 张,每张存着 MiniCPM 当时的原始回答和整页转写)里挑一批,
 * 排除已经用过的,生成可以直接喂给 qwen-extract.ts 的文件。不需要读图、不需要 Kaggle,只需要 Qwen 读转写。
 *
 *   bun eval/make-subset.ts --n 100 --seed 5 --exclude eval/runs/qwen-2026-11-05-08-29-26.json
 *   bun eval/qwen-extract.ts eval/runs/qwen-golden100.json --source minicpm
 *
 * 注意: 评测集里的收据,第一轮的文字规则是针对它们调过的,所以 MiniCPM 原生那一列会偏乐观;
 * Qwen 那条路没有针对它们调过。这对 Qwen 方案是偏不利的比较,看到的差距只会低估它。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dedupeGolden, type GoldenItem } from '../server/lib/evaluate'

const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const n = Number(arg('n', '100')), seed = Number(arg('seed', '5'))
const root = resolve(import.meta.dir, '..')
const golden = dedupeGolden(JSON.parse(readFileSync(resolve(root, 'eval/golden/golden.json'), 'utf8')) as GoldenItem[])
const used = new Set<string>()
for (const f of process.argv.slice(2).filter((a) => a.endsWith('.json'))) for (const p of (JSON.parse(readFileSync(resolve(f), 'utf8')).items ?? []) as { file: string }[]) used.add(p.file)
let s = seed >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pool = golden.filter((g) => !used.has(g.file) && (g.out.text ?? '').trim().length > 40)
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
const picked = pool.slice(0, n)
const out = resolve(root, `eval/runs/qwen-golden${n}.json`)
writeFileSync(out, JSON.stringify({ createdAt: new Date().toISOString(), kind: 'golden', items: picked.map((g) => ({ file: g.file, label: g.label, out1: g.out, out2: null, ms1: 0, ms2: 0 })) }, null, 1))
console.log(`评测集 ${golden.length} 张,排除已用 ${used.size} 张,可选 ${pool.length} 张,挑出 ${picked.length} 张 → ${out}`)
