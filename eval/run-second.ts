/**
 * 第二意见(GLM-OCR 重读 + Jev 打分 + Qwen 仲裁)的离线评估: 只读门户,不改任何数据。
 *
 * 用法(先让门户在影子模式下把一批有标准答案的收据扫一遍,门户要设好 MINICPM2_URL / QWEN_URL):
 *   bun eval/run-via-portal.ts --n 100            # 产生 eval/runs/portal-xxxx.json(里面有 ids: 文件名 → 门户里的收据 id)
 *   bun eval/run-second.ts eval/runs/portal-xxxx.json [--portal http://127.0.0.1:8080] [--labels <Voxel51_labels.csv>]
 *
 * 等第二意见队列处理完(审核页「第二意见」不再显示「等待」)再跑,没处理完的会单独计数。
 * 输出要回答三个问题(对每个字段 商家 / 日期 / 总额):
 *   1. 两个模型不一致时,谁对?(模型 1 / 模型 2 / 都错)  —— 第二个模型有没有价值
 *   2. Qwen 的仲裁对不对?(选对 / 选错 / 都不是)           —— 仲裁员有没有价值,选错的有多少
 *   3. 两个模型【一致但都错】的有多少?                     —— 第二意见的盲区,这部分只能靠人工 / 规则
 * 最后给出「如果打开 SECOND_UPGRADE=1」会升级多少张、其中有多少张升级后的值和标准答案不符(这个数必须是 0 才建议打开)。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { labelsFromCsv, type Label } from '../server/lib/evaluate'
import type { ReceiptDetail } from '../shared/types'

const root = resolve(import.meta.dir, '..')
const arg = (name: string, dflt = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt }
const runPath = process.argv.slice(2).find((a) => !a.startsWith('--') && a.endsWith('.json'))
if (!runPath) { console.error('用法: bun eval/run-second.ts <eval/runs/portal-xxxx.json> [--portal URL] [--labels CSV]'); process.exit(1) }
const portal = arg('portal', 'http://127.0.0.1:8080').replace(/\/$/, '')
const labels = labelsFromCsv(readFileSync(resolve(arg('labels', join(root, 'receipt data', 'Voxel51_labels.csv'))), 'utf8'))
const run = JSON.parse(readFileSync(resolve(runPath), 'utf8')) as { ids: Record<string, number> }

type F = 'merchant' | 'date' | 'total'
const FIELDS: F[] = ['merchant', 'date', 'total']
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** 一个读数和标准答案是否相符(商家按字母数字比,日期按 YYYY-MM-DD,金额差 ≤0.005)。没有标准答案的字段返回 null(不计分)。 */
function right(f: F, v: unknown, label: Label): boolean | null {
  if (f === 'merchant') return label.company ? norm(v) === norm(label.company) : null
  if (f === 'date') return label.date ? String(v ?? '').slice(0, 10) === label.date : null
  return label.total !== null ? Number.isFinite(Number(v)) && Math.abs(Number(v) - label.total) <= 0.005 : null
}

const stat = Object.fromEntries(FIELDS.map((f) => [f, { disputed: 0, m1: 0, m2: 0, both: 0, qRight: 0, qWrong: 0, qNeither: 0, qNone: 0, agreeWrong: 0, agreeTotal: 0 }])) as Record<F, { disputed: number; m1: number; m2: number; both: number; qRight: number; qWrong: number; qNeither: number; qNone: number; agreeWrong: number; agreeTotal: number }>
let total = 0, withSecond = 0, waiting = 0, failed = 0, wouldUpgrade = 0, upgradeWrong = 0
const wrongList: string[] = []

for (const [file, id] of Object.entries(run.ids ?? {})) {
  const label = labels.get(file)
  if (!label) continue
  total++
  const d = (await fetch(`${portal}/api/receipts/${id}`, { headers: { 'x-portal': '1' } }).then((r) => r.json()).catch(() => null)) as ReceiptDetail | null
  if (!d) continue
  if (d.secondState === 'pending' || d.secondState === 'running') { waiting++; continue }
  if (d.secondState === 'failed') { failed++; continue }
  const s = d.second
  if (!s?.model2) continue // 第一轮已基本可信,没有进第二意见队列
  withSecond++
  const m1 = d.machine as unknown as Record<F, unknown>
  for (const f of FIELDS) {
    const st = stat[f]
    const a = right(f, m1[f], label), b = right(f, s.model2.candidate[f], label)
    if (a === null) continue
    if (s.disputed.includes(f)) {
      st.disputed++
      if (a && !b) st.m1++; else if (!a && b) st.m2++; else if (!a && !b) st.both++
      const q = s.qwen?.[f]
      if (!q) st.qNone++
      else if (q.pick === 'neither') st.qNeither++
      else if (right(f, q.pick === 'A' ? m1[f] : q.value ?? s.model2.candidate[f], label)) st.qRight++
      else { st.qWrong++; wrongList.push(`${file} ${f}: 选 ${q.pick} 值=${q.value} 标准=${f === 'merchant' ? label.company : f === 'date' ? label.date : label.total}`) }
    } else {
      st.agreeTotal++
      if (!a) st.agreeWrong++
    }
  }
  if (s.decision.upgrade) {
    wouldUpgrade++
    // 升级后的值 = 仲裁采纳的字段取 Qwen 的值,其余保持模型 1;任何一个字段和标准答案不符就算错放
    const bad = s.decision.fields.some((f) => FIELDS.includes(f as F) && right(f as F, s.qwen?.[f]?.value ?? s.model2!.candidate[f], label) === false)
    if (bad) { upgradeWrong++; wrongList.push(`${file} 升级后有字段和标准答案不符: ${s.decision.fields.join(',')}`) }
  }
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
console.log(`\n收据 ${total} 张 · 有第二意见 ${withSecond} 张 · 等待中 ${waiting} · 失败 ${failed}\n`)
console.log('字段      不一致  模型1对  模型2对  都错 | Qwen选对  选错  都不是  没仲裁 | 一致且都错 / 一致总数')
for (const f of FIELDS) {
  const s = stat[f]
  console.log(`${f.padEnd(9)} ${String(s.disputed).padStart(5)}  ${String(s.m1).padStart(6)}  ${String(s.m2).padStart(7)}  ${String(s.both).padStart(4)} | ${String(s.qRight).padStart(7)}  ${String(s.qWrong).padStart(4)}  ${String(s.qNeither).padStart(5)}  ${String(s.qNone).padStart(5)} | ${s.agreeWrong} / ${s.agreeTotal} (${pct(s.agreeWrong, s.agreeTotal)})`)
}
console.log(`\n如果打开 SECOND_UPGRADE=1: 会升级 ${wouldUpgrade} 张,其中升级后和标准答案不符 ${upgradeWrong} 张${upgradeWrong === 0 ? '(可以考虑打开)' : '(不要打开,先看下面的清单)'}`)
if (wrongList.length) console.log('\n需要看的:\n' + wrongList.map((x) => '  ' + x).join('\n'))
console.log('\n注: 商家名按字母数字比较,SROIE 标准答案里品牌名 / 公司法定名不统一(见 LABEL_AMBIGUOUS),商家「都错」里有一部分是标注问题,以人工核对为准。')
