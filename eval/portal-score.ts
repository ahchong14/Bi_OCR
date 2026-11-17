/**
 * 直接拿【正在运行的门户】里每张收据的最终读数和状态,对照标准答案算成绩 —— 这才是混合读法(HYBRID_DETAIL)真正的效果。
 * (eval/report.ts 是拿门户存下来的「原始回答」用原生规则重放,不包含 Qwen 明细和分歧检查,所以看不出混合读法。)
 *
 *   bun eval/portal-score.ts --portal http://127.0.0.1:8082 [--labels <csv>] [--base http://127.0.0.1:8083]
 *   --base: 可选,再给一个「没开混合读法」的门户地址,并排对比(两边扫的要是同一批图)
 *
 * 只读门户的公开接口 GET /api/receipts。商家 / 日期 / 总额对 SROIE 标准答案;状态用门户自己的 pipelineStatus。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { labelsFromCsv } from '../server/lib/evaluate'
import { COMPANY_MATCH, similarity } from '../server/lib/truth'
import type { ListResponse, ReceiptRow } from '../shared/types'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const labels = labelsFromCsv(readFileSync(resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv'))), 'utf8'))

async function load(portal: string): Promise<ReceiptRow[]> {
  const rows: ReceiptRow[] = []
  for (let page = 1; ; page++) {
    const r = (await fetch(`${portal.replace(/\/$/, '')}/api/receipts?state=all&page=${page}&pageSize=200`, { headers: { 'x-portal': '1' } }).then((x) => x.json())) as ListResponse
    rows.push(...r.rows)
    if (rows.length >= r.total || !r.rows.length) break
  }
  return rows
}

const TRUSTED = new Set(['AUTO_VERIFIED', 'AUTO'])
function summarize(name: string, rows: ReceiptRow[]) {
  let n = 0, auto = 0, wrong = 0, allOk = 0, dq = 0, hy = 0, dis = 0
  const bad: string[] = []
  for (const r of rows) {
    const l = labels.get(r.file)
    if (!l) continue
    n++
    const okC = !l.company || similarity(r.merchant, l.company) >= COMPANY_MATCH
    const okD = !l.date || r.date === l.date
    const okT = l.total === null || (r.total !== null && Math.abs(r.total - l.total) <= 0.005)
    const ok = okC && okD && okT
    if (ok) allOk++
    const trusted = TRUSTED.has(r.pipelineStatus)
    if (trusted) { auto++; if (!ok) { wrong++; bad.push(`${r.file}  商家${okC ? '✓' : '✗'} 日期${okD ? '✓' : '✗'} 总额${okT ? '✓' : '✗'}  读到: ${r.merchant} | ${r.date} | ${r.total}  标准: ${l.company} | ${l.date} | ${l.total}`) } }
    if (r.reasons.includes('detail_from_qwen')) hy++
    if (r.reasons.some((x) => x.startsWith('reader_disagree'))) dis++
    void dq
  }
  const p = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
  console.log(`\n## ${name}(${n} 张有标准答案)`)
  console.log(`- 三项全对: ${allOk}/${n}  ${p(allOk, n)}`)
  console.log(`- 自动通过(基本可信): ${auto}/${n}  ${p(auto, n)}`)
  console.log(`- **错放**(自动通过但商家/日期/总额有错): ${wrong}/${auto}`)
  console.log(`- 带 detail_from_qwen 的: ${hy} 张 · 带 reader_disagree 的: ${dis} 张`)
  for (const b of bad) console.log(`    ⚠ ${b}`)
}

const main = arg('portal', 'http://127.0.0.1:8082')
summarize(`门户 ${main}`, await load(main))
const base = arg('base')
if (base) summarize(`对照门户 ${base}`, await load(base))
console.log('\n注: 只核对商家 / 日期 / 总额(SROIE 标准答案);小计 / 税额 / 实付 / 找零 / 商品行要人工抽查,见对话里的步骤。')

// ---------------------------------------------------------------- 明细字段(可选): --ref-db <备份目录>
// 对照备份库里助手逐张审核后的最终值: 小计 / 税额 / 实付 / 找零 / 商品行数量 / 商品行金额合计。【只是参考,不是人工标准答案】
const refDir = arg('ref-db')
if (refDir) {
  const { Database } = await import('bun:sqlite')
  const db = new Database(join(resolve(refDir), 'portal.db'), { readonly: true })
  type Ref = { file: string; subtotal: number | null; tax: number | null; paid: number | null; change: number | null; items: string }
  const refs = new Map(db.query<Ref, []>("SELECT file, subtotal, tax, paid, change, items FROM receipts WHERE state = 'approved' AND review_mode = 'single'").all().map((r) => [r.file, r]))
  const rows = await load(main)
  const near = (a: number | null | undefined, b: number | null | undefined, tol = 0.011) => ((a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && Math.abs(a! - b!) <= tol)
  const stat: Record<string, { n: number; ok: number }> = {}
  const add = (k: string, ok: boolean) => { const s = (stat[k] ??= { n: 0, ok: 0 }); s.n++; if (ok) s.ok++ }
  const diffs: string[] = []
  for (const r of rows) {
    const ref = refs.get(r.file)
    if (!ref) continue
    const d = (await fetch(`${main.replace(/\/$/, '')}/api/receipts/${r.id}`, { headers: { 'x-portal': '1' } }).then((x) => x.json())) as import('../shared/types').ReceiptDetail
    let refItems: { price?: number | null }[] = []
    try { const v = JSON.parse(ref.items); if (Array.isArray(v)) refItems = v } catch { /* 当没有商品 */ }
    const sum = (xs: { price?: number | null }[]) => Math.round(xs.reduce((a, i) => a + (typeof i.price === 'number' ? i.price : 0), 0) * 100) / 100
    const checks: [string, boolean, string][] = [
      ['小计', near(d.data.subtotal, ref.subtotal), `小计 ${d.data.subtotal} ≠ ${ref.subtotal}`],
      ['税额', near(d.data.tax, ref.tax), `税额 ${d.data.tax} ≠ ${ref.tax}`],
      ['实付', near(d.data.paid, ref.paid), `实付 ${d.data.paid} ≠ ${ref.paid}`],
      ['找零', near(d.data.change, ref.change), `找零 ${d.data.change} ≠ ${ref.change}`],
      ['商品行数量', d.data.items.length === refItems.length, `行数 ${d.data.items.length} ≠ ${refItems.length}`],
      ['商品行金额合计', near(sum(d.data.items), sum(refItems), 0.05), `行合计 ${sum(d.data.items)} ≠ ${sum(refItems)}`],
    ]
    const bad = checks.filter((c) => !c[1])
    for (const c of checks) add(c[0], c[1])
    if (bad.length) diffs.push(`${r.file}  [${d.pipelineStatus}]  ${bad.map((c) => c[2]).join(' | ')}`)
  }
  console.log('\n## 明细字段(对照助手审核值,仅供参考)')
  for (const [k, v] of Object.entries(stat)) console.log(`- ${k.padEnd(8)} ${v.ok}/${v.n}  ${((v.ok / v.n) * 100).toFixed(1)}%`)
  console.log('\n不一致的(最多 20 条,逐张对照原图判断是门户错还是审核值错):')
  for (const x of diffs.slice(0, 20)) console.log('  ' + x)
}
