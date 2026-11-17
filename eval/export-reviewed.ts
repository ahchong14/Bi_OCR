/**
 * 把审核员的更正导出成【完整标签】评测集: 每张 = 审核员确认后的全部字段(商家、日期、总额、小计、税额、实付、找零、商品)+ 模型的原始回答。
 *
 *   bun eval/export-reviewed.ts                         # 默认读 data/portal.db,写 eval/golden/reviewed.json
 *   bun eval/report.ts --golden eval/golden/reviewed.json --mismatches     # 用它评测
 *
 * 为什么: SROIE 标准答案只有商家、日期、总额,商品和税额没有标准答案,所以那部分一直没有数字。
 * 审核员逐张看过并通过的收据,最终值就是「人确认过的答案」,拿它当标签,商品、税额、小计、付款才第一次能量化。
 *
 * 只导出「逐张审核通过」(review_mode = single)的收据: 批量通过没有逐张看过,不能当标签;助手(claude-assist)代审核的也不导出,免得助手看错一次变成标准。
 * 只读: 先复制数据库再读,不会碰正在运行的门户。没有模型原始回答的(例如 OCR.space 扫的)不导出。
 * 注意: 审核员没改的字段也算「确认过」(他看过这张票并点了通过),这是合理的但不是绝对的;审核越认真,标签越可靠。
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ASSISTANT_REVIEWERS, ASSISTANT_SQL } from '../server/lib/aliases'
import { outputFromOcrText, type GoldenItem } from '../server/lib/evaluate'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt }

let dbPath = resolve(arg('db', join(root, 'data')))
if (existsSync(dbPath) && statSync(dbPath).isDirectory()) dbPath = join(dbPath, 'portal.db')
const outPath = resolve(arg('out', join(root, 'eval', 'golden', 'reviewed.json')))
if (!existsSync(dbPath)) { console.error(`找不到数据库: ${dbPath}`); process.exit(1) }

const tmp = mkdtempSync(join(tmpdir(), 'eval-reviewed-'))
for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(tmp, 'portal.db' + ext))
const db = new Database(join(tmp, 'portal.db'), { readonly: true })

interface Row { file: string; merchant: string | null; date: string | null; subtotal: number | null; tax: number | null; total: number | null; paid: number | null; change: number | null; items: string; ocr_text: string | null }
const rows = db.query<Row, string[]>(
  `SELECT r.file, r.merchant, r.date, r.subtotal, r.tax, r.total, r.paid, r.change, r.items, b.ocr_text
     FROM receipts r JOIN receipt_blobs b ON b.receipt_id = r.id
    WHERE r.state = 'approved' AND r.review_mode = 'single' AND COALESCE(LOWER(r.reviewer),'') NOT IN ${ASSISTANT_SQL} ORDER BY r.id`,
).all(...ASSISTANT_REVIEWERS)

const out: GoldenItem[] = []
let noAnswers = 0, noTotal = 0
for (const r of rows) {
  if (!r.ocr_text || !/\[core fields\]/.test(r.ocr_text)) { noAnswers++; continue }
  if (r.total === null) { noTotal++; continue }
  let items: { price?: number | null }[] = []
  try { const v = JSON.parse(r.items); if (Array.isArray(v)) items = v } catch { /* 坏了当没有商品 */ }
  const itemsTotal = items.length ? Math.round(items.reduce((a, i) => a + (typeof i.price === 'number' ? i.price : 0), 0) * 100) / 100 : null
  out.push({
    file: r.file,
    label: {
      company: r.merchant, date: r.date, total: r.total,
      extra: { subtotal: r.subtotal, tax: r.tax, paid: r.paid, change: r.change, itemCount: items.length, itemsTotal },
    },
    out: outputFromOcrText(r.ocr_text),
  })
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out, null, 1))
console.log(`逐张审核通过的收据 ${rows.length} 张 → 导出 ${out.length} 张(没有模型回答 ${noAnswers} · 没有总额 ${noTotal})`)
console.log(`→ ${outPath}`)
console.log('评测: bun eval/report.ts --golden eval/golden/reviewed.json --mismatches')
if (out.length < 30) console.log(`\n注意: 只有 ${out.length} 张,样本太少,数字只能参考。多审核几批再导出。`)
