import type { Database } from 'bun:sqlite'
import {
  type AmountSum, type AuditEntry, type AuditQuery, type AuditResponse, type BulkRequest, type BulkResult, type FieldKey, type ListResponse,
  type BulkPreview, type BulkProblem, type Meta, type PipelineStatus, type ReceiptData, type ReceiptDetail, type ReceiptQuery, type ReceiptRow, type ReviewRequest, type SecondResult, type SecondState, type Stats,
} from '../../shared/types'
import type { StoredDoc } from '../../shared/doc'
import { amountsRequired, isDirection, isDocType } from '../../shared/doctypes'
import { nowLocal } from '../db'
import { reconcile } from '../../shared/reconcile'
import { learnAlias } from './aliases'
import { changedFields, cleanData, emptyData } from './clean'
import { HttpError } from './errors'

export interface DbRow {
  id: number; file: string; img_hash: string | null; image: string | null; batch: string | null; imported_at: string
  pipeline_status: PipelineStatus; priority: number; reasons: string
  regex_total: number | null; suggested_total: number | null
  state: 'pending' | 'approved' | 'rejected'
  merchant: string | null; date: string | null; currency: string | null
  subtotal: number | null; discount: number | null; service_charge: number | null; tax: number | null; tip: number | null; fees: number | null
  rounding: number | null; total: number | null; paid: number | null; change: number | null
  items: string; edited_fields: string; reviewer: string | null; reviewed_at: string | null; note: string | null; version: number
  review_mode: 'single' | 'bulk' | null
  second_state?: SecondState | null
  item_count?: number
  // v10: 单据分类(旧数据都是 NULL / 0)
  document_type?: string | null; direction?: string | null; type_confidence?: number | null; doc_no?: string | null; title?: string | null; doc_edited?: number | null
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback } catch { return fallback }
}

export function toRow(r: DbRow): ReceiptRow {
  return {
    id: r.id, file: r.file, hasImage: !!r.image, batch: r.batch, importedAt: r.imported_at, pipelineStatus: r.pipeline_status,
    reasons: parse<string[]>(r.reasons, []), state: r.state, merchant: r.merchant, date: r.date, currency: r.currency,
    subtotal: r.subtotal, discount: r.discount, serviceCharge: r.service_charge, tax: r.tax, tip: r.tip, fees: r.fees,
    rounding: r.rounding, total: r.total, paid: r.paid, change: r.change,
    itemCount: r.item_count ?? parse<unknown[]>(r.items, []).length, editedFields: parse<FieldKey[]>(r.edited_fields, []),
    reviewer: r.reviewer, reviewedAt: r.reviewed_at, note: r.note, version: r.version, secondState: r.second_state ?? null,
    documentType: isDocType(r.document_type) ? r.document_type : null, direction: isDirection(r.direction) ? r.direction : null,
    typeConfidence: r.type_confidence ?? null, docNo: r.doc_no ?? null, title: r.title ?? null, docEdited: !!r.doc_edited,
  }
}

const rowData = (r: DbRow): ReceiptData => ({
  merchant: r.merchant, date: r.date, currency: r.currency, subtotal: r.subtotal, discount: r.discount,
  service_charge: r.service_charge, tax: r.tax, tip: r.tip, fees: r.fees, rounding: r.rounding, total: r.total,
  paid: r.paid, change: r.change, items: parse(r.items, []),
})

/** 体积大的字段在单独的表里,只有打开详情或需要对比机器原始值时才读。 */
interface Blobs { machine: string; corrections: string; suggestions: string; verifier: string | null; ocr_text: string | null; timing: string | null; boxes: string | null; second: string | null; doc: string | null }
export const getBlobs = (db: Database, id: number): Blobs =>
  db.query<Blobs, [number]>('SELECT machine, corrections, suggestions, verifier, ocr_text, timing, boxes, second, doc FROM receipt_blobs WHERE receipt_id = ?').get(id)
  ?? { machine: '{}', corrections: '[]', suggestions: '[]', verifier: null, ocr_text: null, timing: null, boxes: null, second: null, doc: null }
const machineOf = (db: Database, id: number): ReceiptData => ({ ...emptyData(), ...parse<Partial<ReceiptData>>(getBlobs(db, id).machine, {}) })

export function getRow(db: Database, id: number): DbRow | null {
  return db.query<DbRow, [number]>('SELECT * FROM receipts WHERE id = ?').get(id)
}

/** 把一份数据写进收据的"当前值"列,并同步商品明细表。 */
export function writeData(db: Database, id: number, d: ReceiptData) {
  db.query(
    `UPDATE receipts SET merchant=?, date=?, currency=?, subtotal=?, discount=?, service_charge=?, tax=?, tip=?, fees=?, rounding=?, total=?, paid=?, change=?, items=? WHERE id=?`,
  ).run(d.merchant, d.date, d.currency, d.subtotal, d.discount, d.service_charge, d.tax, d.tip, d.fees, d.rounding, d.total, d.paid, d.change, JSON.stringify(d.items), id)
  db.query('DELETE FROM receipt_items WHERE receipt_id = ?').run(id)
  const ins = db.query('INSERT INTO receipt_items(receipt_id, name, qty, price, uom, discount) VALUES (?,?,?,?,?,?)')
  for (const it of d.items) ins.run(id, it.name, it.qty, it.price, it.uom ?? null, it.discount ?? null)
}

export function logAudit(db: Database, receiptId: number | null, user: string, action: string, detail: Record<string, unknown> = {}) {
  db.query('INSERT INTO audit(receipt_id, ts, user, action, detail) VALUES (?,?,?,?,?)').run(receiptId, nowLocal(), user, action, JSON.stringify(detail))
}

// ---------------------------------------------------------------- 列表(队列和数据表格共用)
const SORTS: Record<string, string> = {
  id: 'id', file: 'file COLLATE NOCASE', merchant: 'merchant COLLATE NOCASE', date: 'date', total: 'total', state: 'state',
  pipelineStatus: 'priority', reviewer: 'reviewer COLLATE NOCASE', reviewedAt: 'reviewed_at', importedAt: 'imported_at',
  itemCount: 'item_count', currency: 'currency', subtotal: 'subtotal', tax: 'tax', tip: 'tip', paid: 'paid',
  documentType: 'document_type', direction: 'direction', title: 'title COLLATE NOCASE', docNo: 'doc_no COLLATE NOCASE',
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

function buildWhere(q: ReceiptQuery): { sql: string; args: (string | number)[] } {
  const w: string[] = []
  const args: (string | number)[] = []
  if (q.state && q.state !== 'all') { w.push('state = ?'); args.push(q.state) }
  if (q.status) { w.push('pipeline_status = ?'); args.push(q.status) }
  if (q.currency) { w.push('currency = ?'); args.push(q.currency) }
  if (q.from) { w.push('date >= ?'); args.push(q.from) }
  if (q.to) { w.push('date <= ?'); args.push(q.to) }
  if (q.reviewer) { w.push('reviewer = ?'); args.push(q.reviewer) }
  if (q.edited === 'yes') w.push("edited_fields != '[]'")
  if (q.edited === 'no') w.push("edited_fields = '[]'")
  // 不认识的类型 / 方向不能当没传(那样会悄悄返回全部数据): 一律匹配不到
  if (q.type === 'none') w.push('document_type IS NULL')
  else if (q.type !== undefined) { if (isDocType(q.type)) { w.push('document_type = ?'); args.push(q.type) } else w.push('1 = 0') }
  if (q.direction !== undefined) { if (isDirection(q.direction)) { w.push('direction = ?'); args.push(q.direction) } else w.push('1 = 0') }
  if (q.ids) {
    const ids = q.ids.split(',').map((x) => Number.parseInt(x, 10)).filter((x) => Number.isInteger(x)).slice(0, 2000)
    w.push(ids.length ? `id IN (${ids.map(() => '?').join(',')})` : '1 = 0')
    args.push(...ids)
  }
  if (q.q?.trim()) {
    const like = `%${likeEscape(q.q.trim())}%`
    w.push("(file LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\' OR reviewer LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR doc_no LIKE ? ESCAPE '\\')")
    args.push(like, like, like, like, like, like)
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', args }
}

export function listReceipts(db: Database, q: ReceiptQuery): ListResponse {
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize ?? 50), 1), 500)
  const page = Math.max(Math.trunc(q.page ?? 1), 1)
  const { sql: where, args } = buildWhere(q)
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC'
  let order: string
  if (q.sort && SORTS[q.sort]) order = `${SORTS[q.sort]} ${dir}, id ${dir}`
  else if (q.state === 'pending') order = 'priority ASC, id ASC'
  else order = 'COALESCE(reviewed_at, imported_at) DESC, id DESC'

  const rows = db
    .query<DbRow, (string | number)[]>(`SELECT *, json_array_length(items) AS item_count FROM receipts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize)
  // 总数和各币种合计一次扫描算完
  const sums = db
    .query<AmountSum, (string | number)[]>(`SELECT currency, COUNT(*) AS count, COALESCE(SUM(total), 0) AS sum FROM receipts ${where} GROUP BY currency ORDER BY sum DESC`)
    .all(...args)
  const total = sums.reduce((a, s) => a + s.count, 0)
  return { rows: rows.map(toRow), total, page, pageSize, sums }
}

/** 按和列表一样的筛选条件取全部行(导出用)。 */
export function selectAll(db: Database, q: ReceiptQuery): DbRow[] {
  const { sql: where, args } = buildWhere(q)
  return db.query<DbRow, (string | number)[]>(`SELECT * FROM receipts ${where} ORDER BY COALESCE(reviewed_at, imported_at), id`).all(...args)
}

/** 跨批次的疑似重复: 商家(不分大小写)、日期、总额都相同的其他收据。 */
export function findDuplicates(db: Database, r: DbRow) {
  if (!r.merchant || !r.date || r.total === null) return []
  return db
    .query<{ id: number; file: string; state: 'pending' | 'approved' | 'rejected' }, [number, string, string, number]>(
      `SELECT id, file, state FROM receipts WHERE id != ? AND lower(trim(merchant)) = lower(trim(?)) AND date = ? AND total = ? ORDER BY id LIMIT 5`,
    )
    .all(r.id, r.merchant, r.date, r.total)
}

export function getDetail(db: Database, id: number): ReceiptDetail {
  const r = getRow(db, id)
  if (!r) throw new HttpError(404, 'RECEIPT_NOT_FOUND')
  const b = getBlobs(db, id)
  const audit = db
    .query<{ id: number; receipt_id: number; ts: string; user: string; action: string; detail: string }, [number]>(
      'SELECT id, receipt_id, ts, user, action, detail FROM audit WHERE receipt_id = ? ORDER BY id DESC',
    )
    .all(id)
    .map((a): AuditEntry => ({ id: a.id, receiptId: a.receipt_id, ts: a.ts, user: a.user, action: a.action, detail: parse(a.detail, {}) }))
  return {
    ...toRow(r), data: rowData(r), machine: { ...emptyData(), ...parse(b.machine, emptyData()) }, corrections: parse(b.corrections, []), suggestions: parse(b.suggestions, []),
    verifier: parse(b.verifier, { saw: null, agree: null }), regexTotal: r.regex_total, suggestedTotal: r.suggested_total,
    ocrText: b.ocr_text ?? '', boxes: parse(b.boxes, []), timing: parse(b.timing, null), second: parse<SecondResult | null>(b.second, null), audit, duplicates: findDuplicates(db, r),
    doc: parse<StoredDoc | null>(b.doc, null),
  }
}

// ---------------------------------------------------------------- 审核
export function reviewReceipt(db: Database, id: number, req: ReviewRequest): ReceiptDetail {
  const user = req.user.trim()
  if (!user) throw new HttpError(400, 'USER_REQUIRED')
  db.transaction(() => {
    const row = getRow(db, id)
    if (!row) throw new HttpError(404, 'RECEIPT_NOT_FOUND')
    if (req.version !== row.version) throw new HttpError(409, 'VERSION_CONFLICT')
    const note = (req.note ?? '').trim()
    const log: Record<string, unknown> = {}

    if (req.action === 'reopen') {
      db.query("UPDATE receipts SET state='pending', reviewer=NULL, reviewed_at=NULL, note=NULL, review_mode=NULL, version=version+1 WHERE id=?").run(id)
    } else {
      if (!req.final) throw new HttpError(400, 'FINAL_MISSING')
      const final = cleanData(req.final)
      if (req.action === 'approve' && (!final.merchant || (final.total === null && amountsRequired(row.document_type)))) throw new HttpError(400, 'APPROVE_NEEDS_FIELDS') // 送货单 / 订单 / 报价单 / other 不要求总额
      if (req.action === 'reject' && !note) throw new HttpError(400, 'REJECT_NEEDS_NOTE')
      const machine = machineOf(db, id)
      const edited = changedFields(machine, final)
      log.changed = edited
      const state = req.action === 'approve' ? 'approved' : req.action === 'reject' ? 'rejected' : 'pending'
      writeData(db, id, final)
      if (req.action === 'approve' && final.merchant) {
        // 商家记忆表: 逐张审核通过,机器读到的商家(以及模型原始读到的、被系统清理前的商家)和最终商家不一样 → 记下来
        learnAlias(db, machine.merchant, final.merchant)
        for (const c of parse<{ field: string; old: unknown }[]>(getBlobs(db, id).corrections, [])) if (c.field === 'merchant' && typeof c.old === 'string') learnAlias(db, c.old, final.merchant)
      }
      db.query('UPDATE receipts SET state=?, edited_fields=?, reviewer=?, reviewed_at=?, note=?, review_mode=?, version=version+1 WHERE id=?').run(
        state, JSON.stringify(edited), state === 'pending' ? null : user, state === 'pending' ? null : nowLocal(), note || null, state === 'pending' ? null : 'single', id,
      )
    }
    if (note) log.note = note
    logAudit(db, id, user, req.action, log)
  })()
  return getDetail(db, id)
}

/**
 * 批量通过前的体检: 这张收据能不能通过(blocked)、通过的话有没有没解决的问题(codes)。
 * 问题代码语言无关,界面翻译: 对账里没通过/有疑点的检查项 id、no_date、system.REVIEW / system.PARTIAL(系统自己都没把握,而且没人改过)。
 */
export function assessApprove(db: Database, r: DbRow): { blocked: string[]; codes: string[] } {
  const blocked: string[] = []
  if (r.state !== 'pending') blocked.push('not_pending')
  if (!r.merchant) blocked.push('missing_merchant')
  if (r.total === null && amountsRequired(r.document_type)) blocked.push('missing_total')
  const codes: string[] = []
  const recon = reconcile({ ...rowData(r) })
  for (const c of recon.checks) if (c.status === 'fail' || c.status === 'warn') codes.push(c.id)
  if (!r.date) codes.push('no_date')
  const touched = parse<string[]>(r.edited_fields, []).length > 0
  if (!touched && (r.pipeline_status === 'REVIEW' || r.pipeline_status === 'PARTIAL')) codes.push(`system.${r.pipeline_status}`)
  return { blocked, codes }
}

const problem = (r: DbRow, codes: string[]): BulkProblem => ({ id: r.id, file: r.file, merchant: r.merchant, total: r.total, codes })
const MAX_LISTED = 200

/** 批量通过的预览: 不改任何数据,告诉界面哪些没问题、哪些有问题、哪些根本不能通过。 */
export function previewBulk(db: Database, ids: number[]): BulkPreview {
  const out: BulkPreview = { clean: 0, flagged: [], blocked: [] }
  for (const id of ids) {
    const r = getRow(db, id)
    if (!r) continue
    const { blocked, codes } = assessApprove(db, r)
    if (blocked.length) { if (out.blocked.length < MAX_LISTED) out.blocked.push(problem(r, blocked)) }
    else if (codes.length) { if (out.flagged.length < MAX_LISTED) out.flagged.push(problem(r, codes)) }
    else out.clean++
  }
  return out
}

/**
 * 批量处理:通过(默认只通过没发现问题的;scope=all 才连有问题的一起通过)、驳回(统一原因)、重新打开。
 * 返回处理了几张、跳过了几张,以及哪些有问题/不能通过,界面据此告诉员工。批量通过的收据记为 review_mode='bulk',不计入"人工确认"统计。
 */
export function bulkAction(db: Database, req: BulkRequest): BulkResult {
  const user = req.user.trim()
  if (!user) throw new HttpError(400, 'USER_REQUIRED')
  const note = (req.note ?? '').trim()
  if (req.action === 'reject' && !note) throw new HttpError(400, 'REJECT_NEEDS_NOTE')
  const scope = req.scope ?? 'clean'
  const res: BulkResult = { done: 0, skipped: 0, flagged: [], blocked: [], approvedFlagged: 0 }
  db.transaction(() => {
    for (const id of req.ids) {
      const r = getRow(db, id)
      if (!r) { res.skipped++; continue }
      if (req.action === 'approve') {
        const { blocked, codes } = assessApprove(db, r)
        if (blocked.length) { res.skipped++; if (res.blocked.length < MAX_LISTED) res.blocked.push(problem(r, blocked)); continue }
        if (codes.length) {
          if (res.flagged.length < MAX_LISTED) res.flagged.push(problem(r, codes))
          if (scope !== 'all') { res.skipped++; continue }
          res.approvedFlagged++
        }
        db.query("UPDATE receipts SET state='approved', edited_fields=?, reviewer=?, reviewed_at=?, review_mode='bulk', version=version+1 WHERE id=?").run(
          JSON.stringify(changedFields(machineOf(db, id), rowData(r))), user, nowLocal(), id)
        logAudit(db, id, user, 'approve', { changed: [], bulk: true, ...(codes.length ? { unresolved: codes } : {}) })
      } else if (req.action === 'reject') {
        if (r.state !== 'pending') { res.skipped++; continue }
        db.query("UPDATE receipts SET state='rejected', reviewer=?, reviewed_at=?, note=?, review_mode='bulk', version=version+1 WHERE id=?").run(user, nowLocal(), note, id)
        logAudit(db, id, user, 'reject', { bulk: true, note })
      } else {
        if (r.state === 'pending') { res.skipped++; continue }
        db.query("UPDATE receipts SET state='pending', reviewer=NULL, reviewed_at=NULL, note=NULL, review_mode=NULL, version=version+1 WHERE id=?").run(id)
        logAudit(db, id, user, 'reopen', { bulk: true })
      }
      res.done++
    }
  })()
  return res
}

// ---------------------------------------------------------------- 统计 / 元数据 / 审计日志
export function getStats(db: Database): Stats {
  const by = db.query<{ state: string; n: number }, []>('SELECT state, COUNT(*) AS n FROM receipts GROUP BY state').all()
  const get = (s: string) => by.find((x) => x.state === s)?.n ?? 0
  const pend = db
    .query<{ pipeline_status: PipelineStatus; n: number }, []>("SELECT pipeline_status, COUNT(*) AS n FROM receipts WHERE state='pending' GROUP BY pipeline_status")
    .all()
  return { pending: get('pending'), approved: get('approved'), rejected: get('rejected'), pendingByStatus: Object.fromEntries(pend.map((p) => [p.pipeline_status, p.n])) }
}

export function getMeta(db: Database): Meta {
  const col = (sql: string) => db.query<{ v: string }, []>(sql).all().map((x) => x.v)
  return {
    currencies: col("SELECT DISTINCT currency AS v FROM receipts WHERE currency IS NOT NULL AND currency != '' ORDER BY v"),
    reviewers: col('SELECT DISTINCT reviewer AS v FROM receipts WHERE reviewer IS NOT NULL ORDER BY v'),
    merchants: col("SELECT merchant AS v FROM receipts WHERE merchant IS NOT NULL AND merchant != '' GROUP BY merchant ORDER BY COUNT(*) DESC LIMIT 200"),
  }
}

export function listAudit(db: Database, q: AuditQuery): AuditResponse {
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize ?? 50), 1), 200)
  const page = Math.max(Math.trunc(q.page ?? 1), 1)
  const w: string[] = []
  const args: (string | number)[] = []
  if (q.user) { w.push('a.user = ?'); args.push(q.user) }
  if (q.action) { w.push('a.action = ?'); args.push(q.action) }
  if (q.q?.trim()) { w.push("(r.file LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')"); const l = `%${likeEscape(q.q.trim())}%`; args.push(l, l) }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
  const rows = db
    .query<{ id: number; receipt_id: number | null; ts: string; user: string; action: string; detail: string; file: string | null }, (string | number)[]>(
      `SELECT a.id, a.receipt_id, a.ts, a.user, a.action, a.detail, r.file FROM audit a LEFT JOIN receipts r ON r.id = a.receipt_id ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  const total = db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM audit a LEFT JOIN receipts r ON r.id = a.receipt_id ${where}`).get(...args)!.n
  const users = db.query<{ v: string }, []>('SELECT DISTINCT user AS v FROM audit ORDER BY v').all().map((x) => x.v)
  return {
    rows: rows.map((a) => ({ id: a.id, receiptId: a.receipt_id, ts: a.ts, user: a.user, action: a.action, detail: parse(a.detail, {}), file: a.file })),
    total, page, pageSize, users,
  }
}
