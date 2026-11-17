/**
 * CORD(印尼小票)测试的成绩: 拿门户里每张收据的最终读数,对照 cord_extra.json 里的标准答案(总额 / 小计 / 税额 / 商品行)。
 * CORD 的标签里没有商家名和日期,所以这里只核对金额和商品行。只读门户的 GET /api/receipts 和 GET /api/receipts/:id。
 *
 *   bun eval/run-via-portal.ts --portal http://127.0.0.1:8082 --n 50 --seed 21 --include-golden --images "receipt data/cord_test/data" --labels "receipt data/cord_test/cord_labels.csv"
 *   bun eval/cord-score.ts --portal http://127.0.0.1:8082
 *
 * 口径: 金额误差 ≤ 1(印尼盾没有小数);商品行金额用「折扣后的净额」(门户的口径),CORD 的 price 是这一行票上印的金额,
 * 折扣如果是单独一行,在 CORD 里是负数的商品行,所以两边的合计应该对得上。商品行对比按「金额」配对(商品名 OCR 差异太大,不比名字)。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ListResponse, ReceiptDetail } from '../shared/types'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const portal = arg('portal', 'http://127.0.0.1:8082').replace(/\/$/, '')
interface Gold { subtotal: number | null; tax: number | null; discount: number | null; paid: number | null; change: number | null; items: { name: string | null; qty: number | null; price: number | null }[] }
const extra = JSON.parse(readFileSync(resolve(arg('extra', join(root, 'receipt data', 'cord_test', 'cord_extra.json'))), 'utf8')) as Record<string, Gold>
const labelsCsv = readFileSync(resolve(arg('labels', join(root, 'receipt data', 'cord_test', 'cord_labels.csv'))), 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
const totals = new Map<string, number | null>(labelsCsv.map((l) => { const c = l.replace(/^﻿/, '').split(','); return [c[0]!, c[4] ? Number(c[4]) : null] }))

const H = { 'x-portal': '1' }
const rows: { id: number; file: string }[] = []
for (let page = 1; ; page++) {
  const r = (await fetch(`${portal}/api/receipts?state=all&page=${page}&pageSize=200`, { headers: H }).then((x) => x.json())) as ListResponse
  rows.push(...r.rows.map((x) => ({ id: x.id, file: x.file })))
  if (rows.length >= r.total || !r.rows.length) break
}
const near = (a: number | null | undefined, b: number | null | undefined, tol = 1) => (a === null || a === undefined) ? (b === null || b === undefined) : (b !== null && b !== undefined && Math.abs(a - b) <= tol)

interface Stat { name: string; n: number; ok: number }
const S: Record<string, Stat> = Object.fromEntries(['总额', '小计', '税额', '商品行数量', '商品行合计', '商品行金额逐行配对'].map((k) => [k, { name: k, n: 0, ok: 0 }]))
let lineMatched = 0, lineGold = 0, lineGot = 0, receipts = 0, auto = 0, autoWrongTotal = 0
const bad: string[] = []
for (const r of rows) {
  const g = extra[r.file]
  if (!g) continue
  const d = (await fetch(`${portal}/api/receipts/${r.id}`, { headers: H }).then((x) => x.json())) as ReceiptDetail
  receipts++
  const data = d.data
  const trusted = d.pipelineStatus === 'AUTO_VERIFIED' || d.pipelineStatus === 'AUTO'
  const tot = totals.get(r.file) ?? null
  const note: string[] = []
  const chk = (key: string, ok: boolean, applicable: boolean, msg: string) => { if (!applicable) return; S[key]!.n++; if (ok) S[key]!.ok++; else note.push(msg) }
  const totalOk = near(data.total, tot)
  chk('总额', totalOk, tot !== null, `总额 ${data.total} ≠ ${tot}`)
  chk('小计', near(data.subtotal, g.subtotal), g.subtotal !== null, `小计 ${data.subtotal} ≠ ${g.subtotal}`)
  chk('税额', near(data.tax, g.tax), g.tax !== null, `税额 ${data.tax} ≠ ${g.tax}`)
  const goldPrices = g.items.map((i) => i.price).filter((p): p is number => p !== null)
  const gotPrices = data.items.map((i) => i.price).filter((p): p is number => p !== null)
  chk('商品行数量', data.items.length === g.items.length, g.items.length > 0, `商品行 ${data.items.length} ≠ ${g.items.length}`)
  const gs = goldPrices.reduce((a, b) => a + b, 0), ps = gotPrices.reduce((a, b) => a + b, 0)
  chk('商品行合计', Math.abs(gs - ps) <= 1, goldPrices.length > 0, `行合计 ${ps} ≠ ${gs}`)
  // 逐行按金额配对(每个标准金额最多配一次)
  const pool = [...gotPrices]
  let m = 0
  for (const p of goldPrices) { const k = pool.findIndex((q) => Math.abs(q - p) <= 1); if (k >= 0) { m++; pool.splice(k, 1) } }
  lineMatched += m; lineGold += goldPrices.length; lineGot += gotPrices.length
  if (goldPrices.length) { S['商品行金额逐行配对']!.n++; if (m === goldPrices.length && gotPrices.length === goldPrices.length) S['商品行金额逐行配对']!.ok++ }
  if (trusted) { auto++; if (tot !== null && !totalOk) autoWrongTotal++ }
  if (note.length) bad.push(`${r.file}  [${d.pipelineStatus}]  ${note.join(' | ')}`)
}
const p = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
console.log(`\n# CORD 测试 · 门户 ${portal} · ${receipts} 张\n`)
for (const s of Object.values(S)) console.log(`${s.name.padEnd(10)} ${String(s.ok).padStart(3)}/${String(s.n).padEnd(3)} ${p(s.ok, s.n)}`)
console.log(`\n商品行: 标准 ${lineGold} 行,门户读出 ${lineGot} 行,按金额配上 ${lineMatched} 行(召回 ${p(lineMatched, lineGold)} · 精确 ${p(lineMatched, lineGot)})`)
console.log(`自动通过(基本可信): ${auto}/${receipts}(${p(auto, receipts)}) · 其中总额错的 ${autoWrongTotal}`)
if (bad.length) { console.log('\n不一致的(最多 25 条):'); for (const b of bad.slice(0, 25)) console.log('  ' + b) }
console.log('\n注: CORD 是印尼小票,金额用点或逗号分隔千位,没有商家名和日期的标准答案,所以只核对金额和商品行。')
