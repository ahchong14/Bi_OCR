/**
 * 评测报告 + 回归检查。
 *
 *   bun eval/report.ts                          # 重放评测集(eval/golden/golden.json),对照基线(eval/baseline.json),变差就退出码 1
 *   bun eval/report.ts --mismatches             # 同时列出读错的收据
 *   bun eval/report.ts --runs eval/runs/xx.json # 评测一次实机运行(run-live.ts 的结果);可以给多个文件
 *   bun eval/report.ts --runs eval/runs/xx.json --promote   # 把这次运行的收据加进评测集(以后每次改规则都用它们检查)
 *   bun eval/report.ts --update-baseline --note "原因"        # 确认当前水平可以接受,把它记成新的基线
 *
 * 重放用的是【当前代码】对【存下来的模型原始回答】的处理,不调模型,几秒钟跑完;同一批输入上指标变化只可能来自代码改动。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compare, dedupeGolden, formatReport, replay, replayWithAliases, score, summarize, type Baseline, type GoldenItem } from '../server/lib/evaluate'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt }
const flag = (name: string) => process.argv.includes(`--${name}`)
const all = (name: string) => process.argv.flatMap((a, i) => (process.argv[i - 1] === `--${name}` && !a.startsWith('--') ? [a] : []))

const goldenPath = resolve(arg('golden', join(root, 'eval', 'golden', 'golden.json')))
const baselinePath = resolve(arg('baseline', join(root, 'eval', 'baseline.json')))
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

const runFiles = all('runs').map((p) => resolve(p))
let items: GoldenItem[]
let title: string
if (runFiles.length) {
  const byFile = new Map<string, GoldenItem>()
  for (const f of runFiles) for (const g of readJson<{ items: GoldenItem[] }>(f).items) byFile.set(g.file, g)
  items = [...byFile.values()]
  title = `实机运行 ${runFiles.map((f) => f.split(/[\\/]/).pop()).join(', ')}`
} else {
  if (!existsSync(goldenPath)) { console.error(`找不到评测集: ${goldenPath}\n先运行  bun eval/export-golden.ts  从门户已扫描的收据导出,或 bun eval/run-live.ts 跑一批新的。`); process.exit(1) }
  items = dedupeGolden(readJson<GoldenItem[]>(goldenPath)) // 同一张票扫了两次只算一张
  title = '评测集重放'
}
if (!items.length) { console.error('没有可评测的收据。'); process.exit(1) }

const scored = items.map((g) => score(replay(g), g.label, g.file))
const summary = summarize(scored)
console.log(formatReport(summary, { title, mismatches: flag('mismatches') ? scored.filter((r) => !r.allOk) : undefined }))

// 学到商家别名之后(留一法: 每张评测时别名表只用别的收据建,不含自己)。这对应「同一家店被审核员确认过一次以后」的效果,第一次见到的店没有好处
{
  const exs = replayWithAliases(items)
  const sc = exs.map((ex, i) => score(ex, items[i]!.label, items[i]!.file))
  const s2 = summarize(sc)
  const pc = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')
  const used = exs.filter((ex) => ex.reasons.includes('merchant_alias')).length
  console.log('\n## 学到商家别名之后(留一法,不含自己)')
  console.log(`- 用到别名的收据: ${used}/${items.length}`)
  console.log(`- 商家读对: ${s2.fields.company.ok}/${s2.fields.company.n}  ${pc(s2.fields.company.ok, s2.fields.company.n)}   (没有别名: ${summary.fields.company.ok}/${summary.fields.company.n})`)
  console.log(`- 自动通过: ${s2.autoPass.n}/${s2.n}  ${pc(s2.autoPass.n, s2.n)}   (没有别名: ${summary.autoPass.n}/${summary.n})`)
  console.log(`- 错放: ${s2.autoPass.wrong}/${s2.autoPass.n}   (没有别名: ${summary.autoPass.wrong}/${summary.autoPass.n})`)
  if (flag('mismatches')) {
    const newWrong = sc.filter((r, i) => r.autoPass && !r.allOk && !scored[i]!.autoPass)
    for (const r of newWrong) console.log(`  ⚠ 别名让这张变成错放: ${r.file}  读到 ${r.machine.merchant}`)
  }
}

if (flag('promote')) {
  if (!runFiles.length) { console.error('--promote 要和 --runs 一起用。'); process.exit(1) }
  const golden = existsSync(goldenPath) ? readJson<GoldenItem[]>(goldenPath) : []
  const byFile = new Map(golden.map((g) => [g.file, g]))
  let added = 0
  for (const g of items) { if (!byFile.has(g.file)) added++; byFile.set(g.file, g) }
  mkdirSync(dirname(goldenPath), { recursive: true })
  writeFileSync(goldenPath, JSON.stringify([...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 1))
  console.log(`\n已加进评测集: 新增 ${added} 张,现在共 ${byFile.size} 张。注意样本数变了,请检查后运行 --update-baseline。`)
  process.exit(0)
}

if (flag('update-baseline')) {
  if (runFiles.length) { console.error('基线只能用评测集生成(不带 --runs)。'); process.exit(1) }
  const b: Baseline = { createdAt: new Date().toISOString(), note: arg('note') || undefined, summary }
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, JSON.stringify(b, null, 1))
  console.log(`\n基线已更新 → ${baselinePath}`)
  process.exit(0)
}

if (!runFiles.length && existsSync(baselinePath)) {
  const base = readJson<Baseline>(baselinePath)
  const c = compare(summary, base.summary)
  console.log(`\n## 对比基线(${base.createdAt.slice(0, 10)}${base.note ? ' · ' + base.note : ''})`)
  for (const x of c.improvements) console.log(`  ✓ 变好: ${x}`)
  for (const x of c.warnings) console.log(`  ! 注意: ${x}`)
  for (const x of c.regressions) console.log(`  ✗ 变差: ${x}`)
  if (!c.regressions.length && !c.improvements.length && !c.warnings.length) console.log('  和基线完全一致。')
  if (c.improvements.length && !c.regressions.length) console.log('  变好了 —— 确认无误后运行  bun eval/report.ts --update-baseline --note "原因"  记下新的水平。')
  if (c.regressions.length) { console.log('\n回归检查失败。'); process.exit(1) }
} else if (!runFiles.length) {
  console.log('\n还没有基线。确认当前水平可以接受后运行:  bun eval/report.ts --update-baseline --note "首次基线"')
}
