/**
 * 标准答案(ground truth)对照: 导入一份「文件名 → 商家、日期、总额」的 CSV,门户就能算出识别到底准不准。
 *
 * 为什么需要它: 之前判断准确率只能靠「人工有没有改」,但批量通过、审核员没发现的错误都不会算进去。
 * 有标准答案就能直接数「机器读对了几个」「人工改完后对了几个」,换识别服务前后也能公平比较。
 * 格式和 Kaggle 脚本里的 load_labels() 一致(SROIE): 列 file, company, date, address, total。
 */
import type { Database } from 'bun:sqlite'
import { parseAmount } from '../../shared/amount'
import type { AccuracyField, AccuracyReport, AccuracyRow, AccuracySource, TruthImportResult } from '../../shared/types'
import { nowLocal } from '../db'
import { HttpError } from './errors'
import { findDate } from './extract'

// ---------------------------------------------------------------- CSV 解析(带引号、换行、BOM)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim() !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim() !== '')) rows.push(row)
  return rows
}

/** 标准答案里的总额写法五花八门: 'RM8.60'、'$7.60'、'59.54'、'1,234.50'。先走严格解析,不行再取最后一个数。 */
export function truthAmount(raw: string): number | null {
  const r = parseAmount(raw)
  if (r.ok && r.value !== null) return r.value
  const m = raw.match(/\d[\d,]*\.?\d*/g)
  if (!m) return null
  const v = Number(m[m.length - 1]!.replace(/,/g, ''))
  return Number.isFinite(v) ? v : null
}

export function importTruth(db: Database, csv: string): TruthImportResult {
  const rows = parseCsv(csv)
  if (rows.length < 2) throw new HttpError(400, 'TRUTH_BAD_FORMAT')
  const head = rows[0]!.map((h) => h.trim().toLowerCase())
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h))
  const iFile = col('file', 'filename', 'image'), iCo = col('company', 'merchant', 'merchant_name'), iDate = col('date'), iTotal = col('total', 'total_amount'), iAddr = col('address', 'merchant_address')
  if (iFile < 0 || (iTotal < 0 && iDate < 0 && iCo < 0)) throw new HttpError(400, 'TRUTH_BAD_FORMAT')

  const res: TruthImportResult = { added: 0, updated: 0, failed: 0, errors: [] }
  const up = db.query(
    `INSERT INTO ground_truth(file, company, date, address, total, raw_total, raw_date, imported_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(file) DO UPDATE SET company=excluded.company, date=excluded.date, address=excluded.address, total=excluded.total, raw_total=excluded.raw_total, raw_date=excluded.raw_date, imported_at=excluded.imported_at`,
  )
  const exists = db.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM ground_truth WHERE file = ?')
  db.transaction(() => {
    for (const [k, r] of rows.slice(1).entries()) {
      const file = (r[iFile] ?? '').trim().split(/[\\/]/).pop() ?? ''
      if (!file) { res.failed++; if (res.errors.length < 5) res.errors.push(`#${k + 2}: file empty`); continue }
      const rawTotal = iTotal >= 0 ? (r[iTotal] ?? '').trim() : ''
      const rawDate = iDate >= 0 ? (r[iDate] ?? '').trim() : ''
      const date = rawDate ? (findDate(rawDate)?.iso ?? null) : null
      const total = rawTotal ? truthAmount(rawTotal) : null
      const had = exists.get(file)!.n > 0
      up.run(file, iCo >= 0 ? (r[iCo] ?? '').trim() || null : null, date, iAddr >= 0 ? (r[iAddr] ?? '').trim() || null : null, total, rawTotal || null, rawDate || null, nowLocal())
      if (had) res.updated++; else res.added++
    }
  })()
  return res
}

export const truthCount = (db: Database) => db.query<{ n: number }, []>('SELECT COUNT(*) n FROM ground_truth').get()!.n

// ---------------------------------------------------------------- 对照
const norm = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** 编辑距离相似度(0~1)。商家名 OCR 常有一两个字母的差异,所以不要求完全相等。 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = norm(a), y = norm(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length)
}

export const COMPANY_MATCH = 0.9 // 与 Kaggle 脚本 score_against_label 一致
const sameTotal = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.005

interface Row { id: number; file: string; batch: string | null; state: string; merchant: string | null; date: string | null; total: number | null; machine: string | null; t_company: string | null; t_date: string | null; t_total: number | null }

/** 识别来源取自批次名: 门户扫描是 'scan … · 服务名@主机'(主机每次不同,只取 @ 前面);zip / json 是流水线导入。 */
export function sourceOf(batch: string | null): string {
  const m = /·\s*([^@·]+)/.exec(batch ?? '')
  if (m) return m[1]!.trim()
  if (/^zip/i.test(batch ?? '')) return 'zip'
  if (/^json/i.test(batch ?? '')) return 'json'
  return 'unknown'
}

const emptyField = (): AccuracyField => ({ n: 0, machine: 0, final: 0, finalN: 0 })

export function getAccuracy(db: Database): AccuracyReport {
  const labelled = truthCount(db)
  const rows = db
    .query<Row, []>(
      `SELECT r.id, r.file, r.batch, r.state, r.merchant, r.date, r.total, b.machine, t.company t_company, t.date t_date, t.total t_total
         FROM receipts r JOIN ground_truth t ON t.file = r.file LEFT JOIN receipt_blobs b ON b.receipt_id = r.id ORDER BY r.id`,
    )
    .all()
  const sources = new Map<string, AccuracySource>()
  const mismatches: AccuracyRow[] = []
  const get = (name: string) => {
    let s = sources.get(name)
    if (!s) { s = { source: name, receipts: 0, total: emptyField(), date: emptyField(), company: emptyField() }; sources.set(name, s) }
    return s
  }
  for (const r of rows) {
    let machine: { merchant?: string | null; date?: string | null; total?: number | null } = {}
    try { machine = JSON.parse(r.machine ?? '{}') } catch { /* 机器原始结果坏了就当没有 */ }
    const s = get(sourceOf(r.batch))
    s.receipts++
    const final = r.state === 'approved' // 只有审核通过的才有"人工确认后的值"
    const checks: [keyof Pick<AccuracySource, 'total' | 'date' | 'company'>, boolean | null, boolean | null, unknown, unknown][] = [
      ['total', r.t_total === null ? null : sameTotal(machine.total ?? null, r.t_total), r.t_total === null ? null : sameTotal(r.total, r.t_total), machine.total ?? null, r.t_total],
      ['date', r.t_date === null ? null : (machine.date ?? null) === r.t_date, r.t_date === null ? null : r.date === r.t_date, machine.date ?? null, r.t_date],
      ['company', !r.t_company ? null : similarity(machine.merchant, r.t_company) >= COMPANY_MATCH, !r.t_company ? null : similarity(r.merchant, r.t_company) >= COMPANY_MATCH, machine.merchant ?? null, r.t_company],
    ]
    for (const [f, m, fin, got, want] of checks) {
      if (m === null) continue // 标准答案里没有这一项,不计入
      const acc = s[f]
      acc.n++
      if (m) acc.machine++
      else if (mismatches.length < 200) mismatches.push({ id: r.id, file: r.file, source: s.source, field: f, machine: got === null ? null : String(got), truth: want === null ? null : String(want), finalOk: final ? !!fin : null })
      if (final && fin !== null) { acc.finalN++; if (fin) acc.final++ }
    }
  }
  const list = [...sources.values()].sort((a, b) => b.receipts - a.receipts)
  return { labelled, matched: rows.length, sources: list, mismatches }
}
