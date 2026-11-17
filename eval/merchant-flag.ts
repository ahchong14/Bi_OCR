/**
 * 「商家两读者不一样 → 转人工」的代价和收益,用 compare-models.ts 存下来的两个读者的读数离线算(不调模型)。
 *
 *   bun eval/compare-models.ts --n 100 --files eval/runs/files-golden100.txt     # 在 Colab / Kaggle 上读两遍,存到 eval/runs/compare-xxxx.json
 *   bun eval/merchant-flag.ts eval/runs/compare-xxxx.json [更多 compare 文件…]
 *
 * 标记 = 模型 1 的商家和模型 2 的商家(PaddleOCR 整页转写 + 文字规则取首行公司名)相似度低于阈值。
 * 对每个阈值输出:
 *   · 标记的收据里,模型 1 的商家读错的 / 读对的有几张(读对却被标记 = 多出来的人工);
 *   · 把标记的从「基本可信」降成「需检查」之后: 自动通过 / 错放 的变化(用门户同一套规则算)。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { score, type Label } from '../server/lib/evaluate'
import type { StructuredOutput } from '../server/lib/ocr'
import { fromStructured } from '../server/lib/structured'
import { similarity } from '../server/lib/truth'

interface Pair { file: string; label: Label; out1: StructuredOutput | null; out2: StructuredOutput | null }
const files = process.argv.slice(2).filter((a) => a.endsWith('.json'))
if (!files.length) { console.error('用法: bun eval/merchant-flag.ts <compare-xxxx.json> […]'); process.exit(1) }
const seen = new Set<string>()
const pairs: Pair[] = []
for (const f of files) for (const p of (JSON.parse(readFileSync(resolve(f), 'utf8')).items ?? []) as Pair[]) if (p.out1 && p.out2 && !seen.has(p.file)) { seen.add(p.file); pairs.push(p) }
console.log(`共 ${pairs.length} 张(模型 1 和模型 2 都读成功的)\n`)

const rows = pairs.map((p) => {
  const e1 = fromStructured(structuredClone(p.out1!))
  const m2 = fromStructured(structuredClone(p.out2!)).data.merchant
  return { p, e1, m2, sc: score(e1, p.label, p.file) }
}).filter((r) => r.sc.ok.company !== null)
const base = { auto: rows.filter((r) => r.sc.autoPass).length, wrong: rows.filter((r) => r.sc.autoPass && !r.sc.allOk).length, merchantWrong: rows.filter((r) => r.sc.ok.company === false).length }
console.log(`不做标记: 自动通过 ${base.auto}/${rows.length}(${((base.auto / rows.length) * 100).toFixed(1)}%) · 错放 ${base.wrong} · 商家读错 ${base.merchantWrong}\n`)
console.log('阈值  标记:读错/读对 | 自动通过            错放    | 被标记的收据里,原本「基本可信」的:读错/读对')
for (const th of [0.4, 0.5, 0.6, 0.7, 0.8]) {
  let fw = 0, fr = 0, auto = 0, wrong = 0, afw = 0, afr = 0
  for (const r of rows) {
    const flag = !r.m2 || similarity(r.e1.data.merchant, r.m2) < th
    const right = r.sc.ok.company === true
    if (flag) { right ? fr++ : fw++; if (r.sc.autoPass) { right ? afr++ : afw++ } }
    const trusted = r.sc.autoPass && !flag
    if (trusted) { auto++; if (!r.sc.allOk) wrong++ }
  }
  console.log(`${th.toFixed(1)}   ${String(fw).padStart(3)} / ${String(fr).padEnd(3)}     | ${String(auto).padStart(3)}/${rows.length}(${((auto / rows.length) * 100).toFixed(1)}%)  ${String(wrong).padStart(3)}     | ${afw} / ${afr}`)
}
console.log('\n读法: 「被标记的收据里原本基本可信的: 读错/读对」= 这个标记能多拦住几张错放、同时多让人工看几张其实读对的。读错 ≫ 读对,标记才划算。')
