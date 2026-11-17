/**
 * 「总额有付款佐证就放行明细对不上的收据」这条规则的 A/B 对比(只读):同一批收据,规则关 / 开各算一遍。
 *   bun eval/compare-relax.ts                      # 评测集(去重后)
 *   bun eval/compare-relax.ts eval/runs/xx.json    # 再加一次实机运行
 * 看四个数: 自动通过率 / 错放(商家·日期·总额有错却被放行)/ 新放行的收据里小计·税额·商品行读错几张(规则的真实代价)/ 清单。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dedupeGolden, replay, score, type GoldenItem } from '../server/lib/evaluate'
import { triageOpts } from '../server/lib/extract'

const root = resolve(import.meta.dir, '..')
let items = dedupeGolden(JSON.parse(readFileSync(resolve(root, 'eval/golden/golden.json'), 'utf8')) as GoldenItem[])
for (const p of process.argv.slice(2).filter((a) => a.endsWith('.json'))) items = dedupeGolden([...items, ...(JSON.parse(readFileSync(resolve(p), 'utf8')).items as GoldenItem[])])
const run = (relax: boolean) => { triageOpts.relaxDetail = relax; return items.map((g) => score(replay(g), g.label, g.file)) }
const off = run(false), on = run(true)
triageOpts.relaxDetail = true
const n = items.length
const stat = (r: typeof off) => ({ auto: r.filter((x) => x.autoPass).length, wrong: r.filter((x) => x.autoPass && !x.allOk).length })
const a = stat(off), b = stat(on)
const pct = (x: number, d: number) => `${((x / d) * 100).toFixed(1)}%`
console.log(`收据 ${n} 张`)
console.log(`规则关: 自动通过 ${a.auto} (${pct(a.auto, n)}) · 错放 ${a.wrong}`)
console.log(`规则开: 自动通过 ${b.auto} (${pct(b.auto, n)}) · 错放 ${b.wrong}`)
const added = on.map((x, i) => ({ x, i })).filter(({ x, i }) => x.autoPass && !off[i]!.autoPass)
const bad = added.filter(({ x }) => !x.allOk)
const detailBad = added.filter(({ x }) => x.extra && (x.extra.subtotal === false || x.extra.tax === false || x.extra.items === false))
const withExtra = added.filter(({ x }) => x.extra)
console.log(`\n新放行 ${added.length} 张: 商家/日期/总额读错 ${bad.length} 张;有完整标签的 ${withExtra.length} 张里,小计/税额/商品行有错 ${detailBad.length} 张`)
for (const { x } of bad) console.log(`  ✗ 核心字段错 ${x.file}  商家${x.ok.company ? '✓' : '✗'} 日期${x.ok.date ? '✓' : '✗'} 总额${x.ok.total ? '✓' : '✗'}`)
for (const { x } of detailBad) console.log(`  △ 明细有错 ${x.file}  ${JSON.stringify(x.extra)}`)
