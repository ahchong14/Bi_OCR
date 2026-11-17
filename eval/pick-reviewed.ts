/**
 * 挑一批「有审核值」又「最近没测过」的收据,生成文件清单(给 run-via-portal.ts --only 用)。
 * 审核值来自备份库里助手逐张审核后的最终值(小计 / 税额 / 实付 / 找零 / 商品行),只是参考,不是人工标准答案;商家 / 日期 / 总额用 SROIE 标准答案。
 *
 *   bun eval/pick-reviewed.ts --n 50 --seed 7 [--ref-db backups/<备份目录>] [--exclude eval/runs/a.json,eval/runs/b.json]
 *   → eval/runs/files-50.txt
 * 默认排除最近几轮测试用过的图(compare / qwen-golden100 / portal-2026-11-06-*.json)。
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const n = Number(arg('n', '50')), seed = Number(arg('seed', '7'))
let refDir = arg('ref-db')
if (!refDir) { const b = join(root, 'backups'); refDir = existsSync(b) ? join(b, readdirSync(b).sort().at(-1) ?? '') : '' }
if (!refDir || !existsSync(join(refDir, 'portal.db'))) { console.error('找不到备份库,用 --ref-db 指定'); process.exit(1) }
const runs = join(root, 'eval', 'runs')
const excludeFiles = arg('exclude') ? arg('exclude').split(',') : readdirSync(runs).filter((f) => /^(compare-|qwen-|portal-2026-11-0[5-9])/.test(f) && f.endsWith('.json')).map((f) => join(runs, f))
const used = new Set<string>()
for (const f of excludeFiles) {
  try { const j = JSON.parse(readFileSync(resolve(f), 'utf8')); for (const it of (j.items ?? []) as { file: string }[]) used.add(it.file); for (const k of Object.keys(j.ids ?? {})) used.add(k) } catch { /* 读不了就跳过 */ }
}
const db = new Database(join(refDir, 'portal.db'), { readonly: true })
const ref = db.query<{ file: string }, []>("SELECT file FROM receipts WHERE state = 'approved' AND review_mode = 'single' AND items IS NOT NULL AND items != '[]'").all().map((r) => r.file)
let s = seed >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pool = ref.filter((f) => !used.has(f))
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
const picked = pool.slice(0, n)
const out = join(runs, `files-${n}.txt`)
writeFileSync(out, picked.join('\n') + '\n')
console.log(`有审核值(带商品行)的 ${ref.length} 张,排除最近测过的 ${used.size} 张后剩 ${pool.length} 张,挑出 ${picked.length} 张 → ${out}`)
