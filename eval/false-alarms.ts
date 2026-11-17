/**
 * 列出「读对了却被拦」的误报收据,并按拦截原因分组(哪几条规则在多拦人工)。只读,不改任何数据。
 *   bun eval/false-alarms.ts eval/runs/portal-xxxx.json
 * 「读对」= 商家 / 日期 / 总额(标准答案里有的项)全对;「被拦」= 状态不是 AUTO / AUTO_VERIFIED。
 * 输出同时写到 eval/false-alarms.txt 方便打开看。
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { replay, score, type GoldenItem } from '../server/lib/evaluate'

const p = process.argv.find((a) => a.endsWith('.json'))
if (!p) { console.error('用法: bun eval/false-alarms.ts <eval/runs/portal-xxxx.json>'); process.exit(1) }
const items = (JSON.parse(readFileSync(resolve(p), 'utf8')) as { items: GoldenItem[] }).items
// 信息类提示(只是告知,不要求人工核对)不算「拦截原因」
const INFO = new Set(['auto_cleared', 'merchant_tidied', 'merchant_from_text', 'merchant_alias', 'date_day_first_assumed', 'items_rows_dropped', 'items_amount_recomputed', 'paid_from_text', 'change_from_text', 'items_reextracted', 'items_not_extracted', 'scanned_in_portal', 'single_ocr_unverified'])
const code = (r: string) => r.split(':')[0]!
const rows = items.map((g) => { const ex = replay(g); return { g, ex, s: score(ex, g.label, g.file) } })
const alarms = rows.filter((r) => r.s.allOk && !r.s.autoPass)
const count = new Map<string, number>()
const only = new Map<string, number>() // 只有这一条「要核对」的提示就拦住了它:放宽它就能多放一批
const lines: string[] = [`误报 ${alarms.length} 张(读对了却被拦),共 ${rows.length} 张\n`]
for (const r of alarms) {
  const block = r.ex.reasons.filter((x) => !INFO.has(code(x)))
  for (const c of new Set(block.map(code))) count.set(c, (count.get(c) ?? 0) + 1)
  if (new Set(block.map(code)).size === 1) only.set(code(block[0]!), (only.get(code(block[0]!)) ?? 0) + 1)
  lines.push(`${r.g.file}  [${r.ex.status}]  拦截提示: ${block.join(' | ') || '(无,只有信息类提示)'}`)
}
const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k.padEnd(34)} ${n}`).join('\n')
lines.push('\n## 哪些提示拦住了读对的收据(一张可能有多条)\n' + rank(count))
lines.push('\n## 只靠这一条提示就拦住的(放宽它,这些就能直接通过)\n' + rank(only))
const out = lines.join('\n')
console.log(out)
writeFileSync(resolve(import.meta.dir, 'false-alarms.txt'), out)
