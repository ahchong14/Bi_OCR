/**
 * 第二意见(按需升级): 第一轮(MiniCPM-OCR)出结果、过完确定性校验之后,只有「不是基本可信」的收据才交给第二个读取模型(GLM-OCR),
 * 再由验证器(Jev)给两份转写打分、文字模型(Qwen3.5-4B)对两边不一致的字段做仲裁。
 *
 * 安全原则(和 Kaggle 脚本里的 build_agg_messages / parse_agg 一一对应):
 *  1. 影子模式是默认: 第二意见只【存储和显示】,不改字段、不改状态。SECOND_UPGRADE=1 才允许自动升级。
 *  2. Qwen 选的值必须能在整页转写里逐字找到(数字按分比较,文字去符号后包含),找不到就降级成「都不是」,所以它判断错了也写不进一个凭空的数。
 *  3. 自动升级还要同时满足: 争议字段全部有依据地解决 + 用采纳后的值重新走一遍完整校验仍是「基本可信」。任何一条不满足都留给人工。
 *  4. 第二意见任何一步失败(超时、服务没开)都不影响这张收据,它照旧按第一轮的结果进人工队列。
 */
import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PRIORITY, type Correction, type ReceiptData, type SecondResult } from '../../shared/types'
import { nowLocal } from '../db'
import { outputFromOcrText } from './evaluate'
import { logAudit, writeData } from './receipts'
import { OcrError, type OcrProvider, type StructuredOutput } from './ocr'
import { ANSWER_TITLES, fromStructured, type StructuredExtraction } from './structured'

// ---------------------------------------------------------------- 配置
export type SecondMode = 'off' | 'flagged' | 'all'
export interface QwenOptions { baseUrl: string; apiKey?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
/** demoteOn: 第二个读取模型和第一个读得不一样的字段里,只要有一个在这个清单里,就把「基本可信」的收据降成「需检查」(只会多一次人工核对,不会多放行)。默认空 = 只显示不改状态。 */
export const secondOpts: { mode: SecondMode; upgrade: boolean; qwen: QwenOptions | null; concurrency: number; demoteOn: string[] } = { mode: 'off', upgrade: false, qwen: null, concurrency: 1, demoteOn: [] }

// ---------------------------------------------------------------- 候选字段
export const AGG_FIELDS = ['merchant', 'date', 'total', 'subtotal', 'tax', 'paid', 'change'] as const
export type AggField = (typeof AGG_FIELDS)[number]
/** 聚合字段 → 模型原始输出里的键(structured.ts 的 CORE_FIELDS / EXTRA_FIELDS)。 */
export const RAW_KEY: Record<AggField, string> = { merchant: 'merchant_name', date: 'date', total: 'total', subtotal: 'subtotal', tax: 'tax_amount', paid: 'amount_paid', change: 'change_given' }

export type Candidate = Partial<Record<AggField, string | number | null>>
const candidateOf = (d: ReceiptData): Candidate => ({ merchant: d.merchant, date: d.date, total: d.total, subtotal: d.subtotal, tax: d.tax, paid: d.paid, change: d.change })

const same = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.005
  return String(a).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b).trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** 逐字段比较两份读数: 一致 / 不一致 / 两边都没有(null)。 */
export function compareCandidates(a: Candidate, b: Candidate): { agree: Partial<Record<AggField, boolean>>; disputed: AggField[] } {
  const agree: Partial<Record<AggField, boolean>> = {}
  const disputed: AggField[] = []
  for (const k of AGG_FIELDS) {
    if ((a[k] ?? null) === null && (b[k] ?? null) === null) continue
    agree[k] = same(a[k], b[k])
    if (!agree[k]) disputed.push(k)
  }
  return { agree, disputed }
}

// ---------------------------------------------------------------- Qwen 聚合
export const AGG_SCHEMA = {
  type: 'object',
  properties: { fields: { type: 'array', items: { type: 'object', properties: { field: { enum: [...AGG_FIELDS] }, pick: { enum: ['A', 'B', 'neither'] }, value: { type: ['string', 'number', 'null'] }, evidence: { type: 'string' } }, required: ['field', 'pick', 'value', 'evidence'] } } },
  required: ['fields'],
} as const

export const AGG_SYSTEM =
  '你是收据字段的仲裁员。你只看到两个识别模型读出的候选值(A 和 B)和整页文字转写,没有图片。对每个给出的字段:选 A、选 B,或都不是(neither)。规则:\n' +
  '1. 你选的值必须能在转写里逐字找到,并且在 evidence 里引用那一行原文;找不到就选 neither、value 写 null。\n' +
  '2. 总额是最终应付额(含税、含舍入后),不是小计、不是实付、不是税基汇总。\n' +
  '3. 商家是公司或店名,不是客户名、手写字、商品名。\n' +
  '4. 拿不准就选 neither,不要猜。只输出 JSON。'

export function buildAggMessages(transcript: string, a: Candidate, b: Candidate, rules: string[] = []): { messages: { role: string; content: string }[]; diff: AggField[] } {
  const diff = compareCandidates(a, b).disputed
  const pickOf = (c: Candidate) => Object.fromEntries(diff.map((k) => [k, c[k] ?? null]))
  const user = JSON.stringify({ fields_to_decide: diff, A: pickOf(a), B: pickOf(b), rule_flags: rules, transcript: (transcript ?? '').slice(0, 6000) })
  return { messages: [{ role: 'system', content: AGG_SYSTEM }, { role: 'user', content: user }], diff }
}

export type AggPick = { pick: 'A' | 'B' | 'neither'; value: string | number | null; evidence: string }
/** 解析聚合员的 JSON,并做硬约束: pick 是 A / B 时,value 必须能在转写里找到,否则降级成 neither。 */
export function parseAgg(raw: string, transcript: string): Partial<Record<AggField, AggPick>> {
  let j: unknown
  try { j = JSON.parse(raw) } catch {
    const i = raw?.indexOf('{') ?? -1, k = raw?.lastIndexOf('}') ?? -1
    try { j = i >= 0 && k > i ? JSON.parse(raw.slice(i, k + 1)) : null } catch { return {} }
  }
  const flat = (transcript ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const amounts = [...(transcript ?? '').matchAll(/\d[\d,]*\.\d{1,2}/g)].map((m) => Math.round(Math.abs(Number(m[0].replace(/,/g, ''))) * 100))
  const out: Partial<Record<AggField, AggPick>> = {}
  const list = (j as { fields?: unknown } | null)?.fields
  for (const it of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    const f = it.field as AggField, pick = it.pick as AggPick['pick']
    if (!AGG_FIELDS.includes(f) || !['A', 'B', 'neither'].includes(pick)) continue
    let value = (it.value ?? null) as AggPick['value']
    let p = pick
    if (p !== 'neither') {
      let ok = false
      if (value !== null) {
        if (typeof value === 'number' || /^-?\d+(?:[.,]\d+)?$/.test(String(value).trim())) {
          const want = Math.round(Math.abs(Number(String(value).replace(',', '.'))) * 100)
          ok = Number.isFinite(want) && amounts.includes(want)
        } else {
          const key = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
          ok = key.length > 0 && flat.includes(key)
        }
      }
      if (!ok) { p = 'neither'; value = null }
    }
    out[f] = { pick: p, value: p === 'neither' ? null : value, evidence: String(it.evidence ?? '').slice(0, 200) }
  }
  return out
}

/** 调 Qwen(OpenAI 兼容接口,门户设 QWEN_URL 指向 <隧道地址>/qwen)。失败一律返回 null。 */
export async function askQwen(q: QwenOptions, messages: { role: string; content: string }[]): Promise<string | null> {
  const f = q.fetchImpl ?? fetch
  const endpoint = `${q.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
  try {
    const res = await f(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(q.apiKey ? { authorization: `Bearer ${q.apiKey}` } : {}) },
      body: JSON.stringify({ model: q.model || 'qwen', messages, temperature: 0, max_tokens: 600, response_format: { type: 'json_schema', json_schema: { name: 'agg', schema: AGG_SCHEMA } } }),
      signal: AbortSignal.timeout(q.timeoutMs ?? 120_000),
    })
    if (!res.ok) { console.warn(`[qwen] HTTP ${res.status}`); return null }
    const j = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const c = j?.choices?.[0]?.message?.content
    return typeof c === 'string' ? c : null
  } catch (e) {
    console.warn(`[qwen] 调用失败: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

// ---------------------------------------------------------------- 整条流程
export interface SecondDeps {
  provider: OcrProvider & { readSecond?: (image: Uint8Array) => Promise<StructuredOutput | null> }
  qwen?: QwenOptions | null
}

/** 用采纳后的值重新走一遍完整校验: 把争议字段在第一轮原始输出里替换成第二个模型的原始值,再跑 fromStructured。 */
export function rebuildWith(out1: StructuredOutput, out2: StructuredOutput, fields: AggField[]): StructuredExtraction {
  const clone = structuredClone(out1)
  for (const f of fields) clone.fields[RAW_KEY[f]] = out2.fields[RAW_KEY[f]]
  return fromStructured(clone)
}

/** 自动升级的判断(影子模式下也算出来存着,用来评测「如果打开会怎样」,但不执行)。 */
export function decideUpgrade(first: StructuredExtraction, out1: StructuredOutput, out2: StructuredOutput | null, res: Pick<SecondResult, 'disputed' | 'qwen'>): SecondResult['decision'] {
  if (!out2) return { upgrade: false, why: 'no_second_reading', fields: [] }
  if (first.status === 'AUTO_VERIFIED' || first.status === 'AUTO') return { upgrade: false, why: 'already_trusted', fields: [] }
  if (!res.disputed.length) return { upgrade: false, why: 'no_disputes', fields: [] }
  const picks = res.qwen ?? {}
  const adopt: AggField[] = []
  for (const f of res.disputed) {
    const p = picks[f]
    if (!p || p.pick === 'neither') return { upgrade: false, why: `unresolved:${f}`, fields: [] } // 有争议字段没有依据地解决 → 留给人工
    if (p.pick === 'B') adopt.push(f as AggField)
  }
  if (!adopt.length) return { upgrade: false, why: 'picked_first_only', fields: [] }          // 全选 A: 等于第一轮,没有新信息
  const rebuilt = rebuildWith(out1, out2, adopt)
  if (rebuilt.status !== 'AUTO_VERIFIED') return { upgrade: false, why: `revalidation:${rebuilt.status}`, fields: adopt }
  return { upgrade: true, why: 'resolved_and_revalidated', fields: adopt }
}

export async function secondOpinion(deps: SecondDeps, image: Uint8Array, out1: StructuredOutput, first: StructuredExtraction, qwenOverride?: QwenOptions | null): Promise<{ result: SecondResult; out2: StructuredOutput | null }> {
  const t0 = performance.now()
  const result: SecondResult = { at: nowLocal(), model2: null, agree: {}, disputed: [], jev: null, qwen: null, decision: { upgrade: false, why: 'no_second_reading', fields: [] }, ms: 0 }
  if (!deps.provider.readSecond) return { result: { ...result, ms: Math.round(performance.now() - t0) }, out2: null }
  let out2: StructuredOutput | null = null
  try { out2 = await deps.provider.readSecond(image) } catch (e) {
    console.warn(`[second] 第二个读取模型失败: ${e instanceof Error ? e.message : e}`)
  }
  if (!out2) return { result: { ...result, ms: Math.round(performance.now() - t0) }, out2: null }
  const ex2 = fromStructured(structuredClone(out2))
  result.model2 = { candidate: candidateOf(ex2.data), status: ex2.status, reasons: ex2.reasons.filter((r) => r !== 'scanned_in_portal').slice(0, 12), text: out2.text.slice(0, 4000), ms: out2.ms }
  const cmp = compareCandidates(candidateOf(first.data), candidateOf(ex2.data))
  result.agree = cmp.agree
  result.disputed = cmp.disputed

  // Jev: 给两份转写各打一个「和图片吻合程度」的分(可选;失败不影响)
  if (deps.provider.verify) {
    const [a, b] = await Promise.all([
      out1.text.trim() ? deps.provider.verify(image, out1.text).catch(() => null) : null,
      out2.text.trim() ? deps.provider.verify(image, out2.text).catch(() => null) : null,
    ])
    if (a || b) result.jev = { first: a?.score ?? null, second: b?.score ?? null }
  }

  // Qwen: 只对不一致的字段仲裁,只看文字
  const q = qwenOverride === undefined ? deps.qwen : qwenOverride
  if (q && cmp.disputed.length) {
    const { messages } = buildAggMessages(out1.text || out2.text, candidateOf(first.data), candidateOf(ex2.data), first.reasons.filter((r) => r !== 'scanned_in_portal'))
    const raw = await askQwen(q, messages)
    if (raw) result.qwen = parseAgg(raw, [out1.text, out2.text].join('\n'))
  }
  result.decision = decideUpgrade(first, out1, out2, result)
  result.ms = Math.round(performance.now() - t0)
  return { result, out2 }
}

// ---------------------------------------------------------------- 队列
interface Job { id: number }
const state: { db: Database | null; dataDir: string; deps: SecondDeps | null; queue: Job[]; running: number; queued: Set<number> } = { db: null, dataDir: '', deps: null, queue: [], running: 0, queued: new Set() }

const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback } catch { return fallback } }

/** 启动时调用: 记下数据库和识别服务,并把上次没做完的(排队中、进行中)重新入队。 */
export function initSecond(db: Database, dataDir: string, provider: SecondDeps['provider']): number {
  state.db = db; state.dataDir = dataDir; state.deps = { provider, qwen: secondOpts.qwen }
  state.queue = []; state.running = 0; state.queued = new Set()
  if (secondOpts.mode === 'off') return 0
  const rows = db.query<{ id: number }, []>("SELECT id FROM receipts WHERE second_state IN ('pending','running') ORDER BY id").all()
  for (const r of rows) enqueueSecond(r.id, true)
  return rows.length
}

export const secondEnabled = () => !!state.db && !!state.deps && secondOpts.mode !== 'off' && typeof state.deps.provider.readSecond === 'function'

/** 把一张收据放进第二意见队列(已经在队列里就忽略)。返回有没有入队。 */
export function enqueueSecond(id: number, resumed = false): boolean {
  if (!secondEnabled() || state.queued.has(id)) return false
  state.queued.add(id)
  if (!resumed) state.db!.query("UPDATE receipts SET second_state = 'pending' WHERE id = ?").run(id)
  state.queue.push({ id })
  void pump()
  return true
}

async function pump(): Promise<void> {
  while (state.running < secondOpts.concurrency && state.queue.length) {
    const job = state.queue.shift()!
    state.running++
    void runJob(job.id).finally(() => { state.running--; state.queued.delete(job.id); void pump() })
  }
}

/** 做完一张: 读第二个模型 → 比较、打分、仲裁 → 存起来(影子模式不改字段和状态);SECOND_UPGRADE=1 且判断可以升级才改。 */
export async function runJob(id: number): Promise<void> {
  const db = state.db!, deps = state.deps!
  try {
    const row = db.query<{ image: string | null; pipeline_status: string; state: string }, [number]>('SELECT image, pipeline_status, state FROM receipts WHERE id = ?').get(id)
    const blob = db.query<{ ocr_text: string | null }, [number]>('SELECT ocr_text FROM receipt_blobs WHERE receipt_id = ?').get(id)
    if (!row || !blob?.ocr_text || !row.image) { db.query("UPDATE receipts SET second_state = 'failed' WHERE id = ?").run(id); return }
    const path = join(state.dataDir, 'images', basename(row.image))
    if (!existsSync(path)) { db.query("UPDATE receipts SET second_state = 'failed' WHERE id = ?").run(id); return }
    db.query("UPDATE receipts SET second_state = 'running' WHERE id = ?").run(id)
    const out1 = outputFromOcrText(blob.ocr_text)
    const first = fromStructured(structuredClone(out1))
    const { result: res, out2 } = await secondOpinion(deps, new Uint8Array(readFileSync(path)), out1, first)
    let applied = false
    if (secondOpts.upgrade && res.decision.upgrade && row.state === 'pending') applied = applyUpgrade(db, id, out1, out2, res)
    res.applied = applied
    // 降级: 两个读者对这些字段读得不一样,收据又是「基本可信」且还没人审核 → 降成需检查
    const demote = !applied && !!res.model2 && row.state === 'pending' && (row.pipeline_status === 'AUTO_VERIFIED' || row.pipeline_status === 'AUTO') && res.disputed.some((f) => secondOpts.demoteOn.includes(f))
    const reasonCode = !res.model2 ? null : res.disputed.length ? `second_disagrees:${res.disputed.join(',')}` : 'second_agrees'
    db.transaction(() => {
      db.query('UPDATE receipt_blobs SET second = ? WHERE receipt_id = ?').run(JSON.stringify(res), id)
      // 模型 2 的原始回答追加进「识别出的原始文字」: 审核页现有的「模型 2」标签页直接就能显示
      if (out2?.answers?.length && !blob.ocr_text!.includes('\n\n[second core fields]')) {
        const extra = out2.answers.map((a) => `[${ANSWER_TITLES[a.name] ?? a.name}]\n${a.raw}`).join('\n\n')
        db.query('UPDATE receipt_blobs SET ocr_text = ? WHERE receipt_id = ?').run(`${blob.ocr_text}\n\n${extra}`, id)
      }
      // 原因代码(提示,不影响状态): 两个模型一致 / 哪些字段不一致
      if (reasonCode) {
        const cur = parse<string[]>(db.query<{ reasons: string }, [number]>('SELECT reasons FROM receipts WHERE id = ?').get(id)?.reasons, [])
        db.query('UPDATE receipts SET reasons = ? WHERE id = ?').run(JSON.stringify([...new Set([...cur.filter((r) => !r.startsWith('second_agrees') && !r.startsWith('second_disagrees')), reasonCode])]), id)
      }
      if (demote) db.query("UPDATE receipts SET pipeline_status = 'REVIEW', priority = ? WHERE id = ?").run(PRIORITY.REVIEW, id)
      db.query("UPDATE receipts SET second_state = ? WHERE id = ?").run(res.model2 ? 'done' : 'failed', id)
      logAudit(db, id, 'system', 'second_opinion', { note: res.model2 ? `disputed=${res.disputed.join(',') || '-'} decision=${res.decision.why}${applied ? ' applied' : ''}${demote ? ' demoted' : ''}` : 'second reading unavailable' })
    })()
  } catch (e) {
    console.warn(`[second] #${id} 失败: ${e instanceof Error ? e.message : e}`)
    try { db.query("UPDATE receipts SET second_state = 'failed' WHERE id = ?").run(id) } catch { /* 数据库问题不要再抛 */ }
  }
}

/** 真正升级: 用采纳后的值重新校验,仍是「基本可信」才写库。字段、状态、更正记录、原因代码都留痕,审核页能一键恢复。 */
export function applyUpgrade(db: Database, id: number, out1: StructuredOutput, out2: StructuredOutput | null, res: SecondResult): boolean {
  if (!out2) return false
  const fields = res.decision.fields as AggField[]
  const rebuilt = rebuildWith(out1, out2, fields)
  if (rebuilt.status !== 'AUTO_VERIFIED') return false
  const before = db.query<{ merchant: string | null; date: string | null; total: number | null; subtotal: number | null; tax: number | null; paid: number | null; change: number | null }, [number]>('SELECT merchant, date, total, subtotal, tax, paid, change FROM receipts WHERE id = ?').get(id)!
  const corrections: Correction[] = fields.map((f) => ({ field: f, old: (before as Record<string, unknown>)[f] ?? null, new: (rebuilt.data as unknown as Record<string, unknown>)[f] ?? null, why: '第二个读取模型 + 文字仲裁采纳,并用采纳后的值重新校验仍是基本可信' }))
  db.transaction(() => {
    writeData(db, id, rebuilt.data)
    const cur = db.query<{ corrections: string }, [number]>('SELECT corrections FROM receipt_blobs WHERE receipt_id = ?').get(id)
    db.query('UPDATE receipt_blobs SET corrections = ? WHERE receipt_id = ?').run(JSON.stringify([...parse<Correction[]>(cur?.corrections, []), ...corrections]), id)
    const reasons = parse<string[]>(db.query<{ reasons: string }, [number]>('SELECT reasons FROM receipts WHERE id = ?').get(id)?.reasons, [])
    db.query("UPDATE receipts SET pipeline_status = 'AUTO_VERIFIED', priority = ?, reasons = ? WHERE id = ?").run(PRIORITY.AUTO_VERIFIED, JSON.stringify([...new Set([...reasons, `second_resolved:${fields.join(',')}`])]), id)
  })()
  return true
}

/** 给 scan.ts 用: 第一轮入库后,按模式决定要不要入队。 */
export function maybeEnqueue(id: number | null | undefined, status: string): boolean {
  if (!id || !secondEnabled()) return false
  if (secondOpts.mode === 'flagged' && (status === 'AUTO_VERIFIED' || status === 'AUTO')) return false
  return enqueueSecond(id)
}

export { OcrError }
