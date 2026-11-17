/**
 * 「两个读者」离线实验室: 用已经存下来的 MiniCPM 原生读数 + Qwen 原始回答,不调任何模型,比较不同的合并策略。
 * 数据来源(都存着 Qwen 的原始回答,所以可以反复重算):
 *   · eval/runs/qwen-golden100.json                  评测集随机 100 张
 *   · eval/runs/qwen-2026-11-05-08-29-26.json        难样本 50 张
 *   · 门户数据目录里扫过的收据(--portal-db D:/tmp/portal-items,可以给多个,逗号分隔): 从存下来的原始文字里拆出原生读数和 Qwen 回答
 * 标准答案: SROIE(商家 / 日期 / 总额)。同一张收据出现在多份数据里只算一次(后面的数据不覆盖前面的)。
 *
 *   bun eval/readers-lab.ts --portal-db D:/tmp/portal-items,D:/tmp/portal-hybrid
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { labelsFromCsv, outputFromOcrText, score, type Label, type Scored } from '../server/lib/evaluate'
import { hybridOpts, mergeWithRaw } from '../server/lib/hybrid'
import type { StructuredOutput } from '../server/lib/ocr'
import { fromStructured } from '../server/lib/structured'
import { similarity } from '../server/lib/truth'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d }
const labels = labelsFromCsv(readFileSync(resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv'))), 'utf8'))

interface Row { src: string; file: string; label: Label; native: StructuredOutput; raw: Record<string, unknown> }
const rows: Row[] = []
const seen = new Set<string>()
const push = (r: Row) => { if (!seen.has(r.file)) { seen.add(r.file); rows.push(r) } }

// 1) 已存的 run 文件(out1 = 原生,out5.answers 里的 qwen_raw)
for (const [name, f] of [['golden100', 'eval/runs/qwen-golden100.json'], ['hard50', 'eval/runs/qwen-2026-11-05-08-29-26.json']] as const) {
  const p = resolve(root, f)
  if (!existsSync(p)) continue
  for (const it of JSON.parse(readFileSync(p, 'utf8')).items as { file: string; label: Label; out1: StructuredOutput | null; out5?: StructuredOutput | null }[]) {
    const rawStr = it.out5?.answers?.find((a) => a.name === 'qwen_raw')?.raw
    if (!it.out1 || !rawStr) continue
    try { push({ src: name, file: it.file, label: it.label, native: it.out1, raw: JSON.parse(rawStr) }) } catch { /* 没有原始回答的跳过 */ }
  }
}
// 2) 门户数据目录(扫过的收据): 原始文字里有 [core fields] 等原生回答和 [qwen detail fields] 的 Qwen 回答
for (const dir of arg('portal-db').split(',').filter(Boolean)) {
  if (!existsSync(join(dir, 'portal.db'))) continue
  const tmp = mkdtempSync(join(tmpdir(), 'lab-'))
  for (const e of ['', '-wal', '-shm']) if (existsSync(join(dir, `portal.db${e}`))) copyFileSync(join(dir, `portal.db${e}`), join(tmp, `portal.db${e}`))
  const db = new Database(join(tmp, 'portal.db'), { readonly: true })
  for (const r of db.query<{ file: string; ocr_text: string }, []>('SELECT r.file, b.ocr_text FROM receipts r JOIN receipt_blobs b ON b.receipt_id = r.id').all()) {
    const label = labels.get(r.file)
    const m = /\[qwen detail fields\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(r.ocr_text ?? '')
    if (!label || !m) continue
    try { push({ src: basename(dir), file: r.file, label, native: outputFromOcrText(r.ocr_text), raw: JSON.parse(m[1]!) }) } catch { /* 坏的跳过 */ }
  }
}
function basename(p: string) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p }

console.log(`共 ${rows.length} 张(${[...new Set(rows.map((r) => r.src))].map((s) => `${s} ${rows.filter((r) => r.src === s).length}`).join(' · ')})\n`)

// ---------------------------------------------------------------- 策略
type Result = { sc: Scored; trusted: boolean }
const finish = (ex: ReturnType<typeof fromStructured>, label: Label, file: string, forceReview: boolean): Result => {
  const e = forceReview && (ex.status === 'AUTO_VERIFIED' || ex.status === 'AUTO') ? { ...ex, status: 'REVIEW' as const } : ex
  const sc = score(e, label, file)
  return { sc, trusted: sc.autoPass }
}
const strategies: { name: string; run: (r: Row) => Result }[] = [
  { name: '原生(不混合)', run: (r) => finish(fromStructured(structuredClone(r.native)), r.label, r.file, false) },
  { name: '混合 + 分歧转人工(现在上线的)', run: (r) => { hybridOpts.resolve = false; const h = mergeWithRaw(r.native, r.raw); return finish(fromStructured(structuredClone(h.out)), r.label, r.file, h.disagree.length > 0) } },
  { name: '混合 + 算术/合理性裁判', run: (r) => { hybridOpts.resolve = true; const h = mergeWithRaw(r.native, r.raw); hybridOpts.resolve = false; return finish(fromStructured(structuredClone(h.out)), r.label, r.file, h.disagree.length > 0) } },
  ...[0.5, 0.6, 0.7, 0.8].map((th) => ({
    name: `混合 + 商家两读者不像(<${th})转人工`,
    run: (r: Row) => {
      hybridOpts.resolve = false
      const h = mergeWithRaw(r.native, r.raw)
      const ex = fromStructured(structuredClone(h.out))
      const qm = typeof r.raw.merchant_name === 'string' ? r.raw.merchant_name : null
      const differ = qm !== null && ex.data.merchant !== null && similarity(ex.data.merchant, qm) < th
      return finish(ex, r.label, r.file, h.disagree.length > 0 || differ)
    },
  })),
]
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%`.padStart(6) : '    — ')
for (const grp of ['全部', ...new Set(rows.map((r) => r.src))]) {
  const sub = grp === '全部' ? rows : rows.filter((r) => r.src === grp)
  console.log(`## ${grp}(${sub.length} 张)`)
  console.log('策略'.padEnd(34) + '商家     日期     总额     三项全对 | 自动通过        错放')
  for (const s of strategies) {
    const rs = sub.map((r) => ({ r, x: s.run(r) }))
    const ok = (f: (sc: Scored) => boolean | null) => { const m = rs.filter((q) => f(q.x.sc) !== null); return pct(m.filter((q) => f(q.x.sc)).length, m.length) }
    const auto = rs.filter((q) => q.x.trusted), wrong = auto.filter((q) => !q.x.sc.allOk)
    console.log(`${s.name.padEnd(30)} ${ok((x) => x.ok.company)} ${ok((x) => x.ok.date)} ${ok((x) => x.ok.total)} ${pct(rs.filter((q) => q.x.sc.allOk).length, rs.length)} | ${String(auto.length).padStart(3)}/${rs.length} ${pct(auto.length, rs.length)}  ${wrong.length}`)
  }
  console.log()
}

// ---------------------------------------------------------------- 现在上线的策略里,被自动通过却读错的收据(逐张看原因)
if (process.argv.includes('--wrong')) {
  hybridOpts.resolve = false
  console.log('## 现在上线的混合策略: 错放清单')
  for (const r of rows) {
    const h = mergeWithRaw(r.native, r.raw)
    const ex = fromStructured(structuredClone(h.out))
    const e = h.disagree.length && (ex.status === 'AUTO_VERIFIED' || ex.status === 'AUTO') ? { ...ex, status: 'REVIEW' as const } : ex
    const sc = score(e, r.label, r.file)
    if (sc.autoPass && !sc.allOk) console.log(`  [${r.src}] ${r.file}  商家${sc.ok.company ? '✓' : '✗'} 日期${sc.ok.date ? '✓' : '✗'} 总额${sc.ok.total ? '✓' : '✗'} | 读到: ${ex.data.merchant} | ${ex.data.date} | ${ex.data.total} | 标准: ${r.label.company} | ${r.label.date} | ${r.label.total}`)
  }
}

// ---------------------------------------------------------------- 读对了却被拦的(误报): 哪些提示在拦
if (process.argv.includes('--blocked')) {
  hybridOpts.resolve = false
  const INFO = new Set(['scanned_in_portal', 'auto_cleared', 'merchant_tidied', 'merchant_from_text', 'merchant_alias', 'date_day_first_assumed', 'items_rows_dropped', 'items_amount_recomputed', 'paid_from_text', 'change_from_text', 'items_reextracted', 'items_not_extracted', 'single_ocr_unverified', 'detail_unverified', 'detail_from_qwen'])
  const code = (x: string) => x.split(':')[0]!
  const all = new Map<string, number>(), only = new Map<string, number>()
  let n = 0
  const listed: string[] = []
  for (const r of rows) {
    const h = mergeWithRaw(r.native, r.raw)
    const ex = fromStructured(structuredClone(h.out))
    const sc = score(ex, r.label, r.file)
    const blocked = !sc.autoPass || h.disagree.length > 0
    if (!(sc.allOk && blocked)) continue
    n++
    const why = [...ex.reasons.filter((x) => !INFO.has(code(x))), ...h.disagree.map((d) => `reader_disagree:${d}`)]
    const set = new Set(why.map(code))
    for (const c of set) all.set(c, (all.get(c) ?? 0) + 1)
    if (set.size === 1) only.set([...set][0]!, (only.get([...set][0]!) ?? 0) + 1)
    if (set.size <= 1) listed.push(`  ${r.src} ${r.file}  ${why.join(' | ') || '(只有信息类提示,状态=' + ex.status + ')'}`)
  }
  const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, c]) => `  ${k.padEnd(34)} ${c}`).join('\n')
  console.log(`\n## 读对了却被拦(误报): ${n} 张\n出现过的拦截提示:\n${rank(all)}\n只靠这一条就拦住的:\n${rank(only)}\n单一原因的收据:\n${listed.join('\n')}`)
}

// ---------------------------------------------------------------- 各状态的准确率(混合策略): 看哪个状态可以放宽
if (process.argv.includes('--status')) {
  hybridOpts.resolve = false
  const by = new Map<string, { n: number; ok: number }>()
  const byReason = new Map<string, { n: number; ok: number }>()
  for (const r of rows) {
    const h = mergeWithRaw(r.native, r.raw)
    const ex = fromStructured(structuredClone(h.out))
    const sc = score(ex, r.label, r.file)
    const s = by.get(ex.status) ?? { n: 0, ok: 0 }; s.n++; if (sc.allOk) s.ok++; by.set(ex.status, s)
    if (ex.status === 'CORRECTED' || ex.status === 'REVIEW') for (const c of new Set(ex.reasons.filter((x) => /^auto_corrected|^merchant_legal|^items_sum|^totals_dont/.test(x)).map((x) => x.split(':')[0] + (x.startsWith('auto_corrected') ? ':' + x.split(':')[1] : '')))) { const q = byReason.get(c) ?? { n: 0, ok: 0 }; q.n++; if (sc.allOk) q.ok++; byReason.set(c, q) }
  }
  console.log('\n## 各状态里读对的比例(三项全对)')
  for (const [k, v] of by) console.log(`  ${k.padEnd(14)} ${v.ok}/${v.n}  ${((v.ok / v.n) * 100).toFixed(1)}%`)
  console.log('## 各提示出现时读对的比例')
  for (const [k, v] of [...byReason].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(34)} ${v.ok}/${v.n}  ${((v.ok / v.n) * 100).toFixed(1)}%`)
}
