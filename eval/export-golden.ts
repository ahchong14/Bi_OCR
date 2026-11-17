/**
 * 把门户里已经扫描过的收据导出成评测集(golden): 每张 = 标准答案 + 模型的原始回答。
 *
 *   bun eval/export-golden.ts                      # 默认读 data/portal.db,标准答案用 ../receipt data/Voxel51_labels.csv
 *   bun eval/export-golden.ts --db data-sample     # 也可以指定别的数据目录或 .db 文件
 *   bun eval/export-golden.ts --labels my_labels.csv --out eval/golden/golden.json
 *
 * 只读: 先把数据库复制到临时目录再读,不会碰正在运行的门户。已经在评测集里的收据(同文件名)会被这次的结果替换,别的保留。
 * 没有标准答案的收据不会导出(没法评分)。原始文字里没有模型回答的(例如 OCR.space 扫的)也不导出。
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { labelsFromCsv, outputFromOcrText, type GoldenItem } from '../server/lib/evaluate'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt }

let dbPath = resolve(arg('db', join(root, 'data')))
if (existsSync(dbPath) && statSync(dbPath).isDirectory()) dbPath = join(dbPath, 'portal.db')
const labelsPath = resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv')))
const outPath = resolve(arg('out', join(root, 'eval', 'golden', 'golden.json')))
if (!existsSync(dbPath)) { console.error(`找不到数据库: ${dbPath}`); process.exit(1) }
if (!existsSync(labelsPath)) { console.error(`找不到标准答案: ${labelsPath}(用 --labels 指定)`); process.exit(1) }

// 复制一份再读(含 -wal / -shm,保证读到最新的)
const tmp = mkdtempSync(join(tmpdir(), 'eval-export-'))
for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(tmp, 'portal.db' + ext))
const db = new Database(join(tmp, 'portal.db'), { readonly: true })

const labels = labelsFromCsv(readFileSync(labelsPath, 'utf8'))
const rows = db.query<{ file: string; ocr_text: string | null }, []>('SELECT r.file, b.ocr_text FROM receipts r JOIN receipt_blobs b ON b.receipt_id = r.id ORDER BY r.id').all()

const existing: GoldenItem[] = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : []
const byFile = new Map(existing.map((g) => [g.file, g]))
let added = 0, replaced = 0, noLabel = 0, noAnswers = 0
for (const r of rows) {
  const label = labels.get(r.file)
  if (!label) { noLabel++; continue }
  if (!r.ocr_text || !/\[core fields\]/.test(r.ocr_text)) { noAnswers++; continue }
  if (byFile.has(r.file)) replaced++; else added++
  byFile.set(r.file, { file: r.file, label, out: outputFromOcrText(r.ocr_text) })
}
const all = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(all, null, 1))
console.log(`读到 ${rows.length} 张收据 → 新增 ${added} · 更新 ${replaced} · 没有标准答案 ${noLabel} · 没有模型回答 ${noAnswers}`)
console.log(`评测集现在共 ${all.length} 张 → ${outPath}`)
