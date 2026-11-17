import type { Database } from 'bun:sqlite'
import { unzipSync } from 'fflate'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { PIPELINE_STATUSES, PRIORITY, type ImportResult, type OcrBox, type PipelineStatus } from '../../shared/types'
import { nowLocal } from '../db'
import { cleanData, emptyData } from './clean'
import { cleanDoc } from './doc'
import { HttpError } from './errors'
import { maskPan } from './pan'
import { logAudit, writeData } from './receipts'

const WEB_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
export const MAX_IMG = 30 * 1024 * 1024

/** 图片按内容哈希命名保存,重复导入同一张图不会占两份空间。 */
export function saveImage(dataDir: string, bytes: Uint8Array, name: string): { file: string; hash: string } {
  const ext = extname(name).toLowerCase()
  if (!WEB_EXT.has(ext)) throw new HttpError(400, 'IMAGE_UNSUPPORTED', { name })
  if (bytes.length > MAX_IMG) throw new HttpError(400, 'IMAGE_TOO_BIG', { name })
  const hash = new Bun.CryptoHasher('sha1').update(bytes).digest('hex')
  const file = hash + ext
  const path = join(dataDir, 'images', file)
  if (!existsSync(path)) writeFileSync(path, bytes)
  return { file, hash }
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const objs = (v: unknown) => arr(v).filter((x) => x && typeof x === 'object')
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 导入的文字框: 只收形状和范围都合理的(比例 0..1),数量封顶,其余丢弃。 */
export function cleanBoxes(v: unknown): OcrBox[] {
  const out: OcrBox[] = []
  for (const b of arr(v)) {
    const o = b as Record<string, unknown> | null
    if (!o || typeof o.t !== 'string' || !o.t.trim()) continue
    const [x, y, w, h] = [o.x, o.y, o.w, o.h].map((n) => (typeof n === 'number' ? n : NaN))
    if (![x, y, w, h].every((n) => Number.isFinite(n)) || w! <= 0 || h! <= 0 || x! < 0 || y! < 0 || x! + w! > 1.02 || y! + h! > 1.02) continue
    out.push({ t: o.t.trim().slice(0, 60), x: x!, y: y!, w: w!, h: h! })
    if (out.length >= 1500) break
  }
  return out
}

type GetImage = (r: Record<string, unknown>) => Uint8Array | null

export function ingest(db: Database, dataDir: string, results: unknown[], getImage: GetImage, batch: string): ImportResult & { errors: string[] } {
  const res = { added: 0, duplicates: 0, withoutImage: 0, failed: 0, errors: [] as string[] }
  db.transaction(() => {
    for (const raw of results) {
      try {
        if (!raw || typeof raw !== 'object') { res.failed++; continue }
        const r = raw as Record<string, unknown>
        if (typeof r.file !== 'string' || !r.file) { res.failed++; continue }

        let image: string | null = null
        let hash: string | null = null
        const bytes = getImage(r)
        if (bytes) {
          const s = saveImage(dataDir, bytes, r.file)
          image = s.file
          hash = s.hash
          if (db.query('SELECT 1 FROM receipts WHERE img_hash = ?').get(hash)) { res.duplicates++; continue }
        } else res.withoutImage++

        let data = emptyData()
        try { data = cleanData(r.data, true) } catch { /* 机器结果格式异常时当作空白,留给人工填写 */ }
        // 银行卡号一律在入库前掩码(只留后 4 位),原始卡号不落盘
        let pans = 0
        const mask = (s: string) => { const m = maskPan(s); pans += m.masked; return m.text }
        if (data.merchant) data.merchant = mask(data.merchant)
        for (const it of data.items) it.name = mask(it.name)
        const ocrText = typeof r.ocr_text === 'string' ? mask(r.ocr_text.slice(0, 20000)) : ''
        const boxes = cleanBoxes(r.boxes).map((b) => ({ ...b, t: mask(b.t) }))
        // 文档信息(分类、标题、关键词、对方 …): 只认约定的键,字符串里的卡号同样掩码;没有或格式不对就是 null(= 没分类过)
        const doc = cleanDoc(r.doc, mask)
        const reasons = arr(r.reasons).map(String)
        if (pans) reasons.push('card_number_masked')
        const status = (PIPELINE_STATUSES as string[]).includes(r.status as string) ? (r.status as PipelineStatus) : 'REVIEW'
        const saw = r.verifier_saw && typeof r.verifier_saw === 'object' ? r.verifier_saw : null
        const agree = r.verifier_agree && typeof r.verifier_agree === 'object' ? r.verifier_agree : null
        // Jev 打分: 只收约定好的三个字段(分数、判定、当时的阈值),其余一律丢弃
        const vj = r.verifier_jev && typeof r.verifier_jev === 'object' ? (r.verifier_jev as Record<string, unknown>) : null
        const jev = vj && typeof vj.verdict === 'string' && typeof vj.threshold === 'number' && Number.isFinite(vj.threshold)
          ? { score: typeof vj.score === 'number' && Number.isFinite(vj.score) ? vj.score : null, verdict: vj.verdict.slice(0, 40), threshold: vj.threshold }
          : null

        const info = db
          .query(
            `INSERT INTO receipts(file, img_hash, image, batch, imported_at, pipeline_status, priority, reasons, regex_total, suggested_total, document_type, direction, type_confidence, doc_no, title) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            r.file, hash, image, batch, nowLocal(), status, PRIORITY[status], JSON.stringify(reasons), numOrNull(r.regex_total), numOrNull(r.suggested_total),
            doc?.classification.document_type ?? null, doc ? doc.direction : null, doc?.classification.confidence ?? null, doc?.header.doc_no ?? null, doc?.title ?? null,
          )
        const id = Number(info.lastInsertRowid)
        db.query('INSERT INTO receipt_blobs(receipt_id, machine, corrections, suggestions, verifier, ocr_text, timing, boxes, doc) VALUES (?,?,?,?,?,?,?,?,?)').run(
          id, JSON.stringify(data), JSON.stringify(objs(r.corrections)), JSON.stringify(objs(r.suggestions)), JSON.stringify(jev ? { saw, agree, jev } : { saw, agree }), ocrText,
          r.timing && typeof r.timing === 'object' ? JSON.stringify(r.timing) : null, boxes.length ? JSON.stringify(boxes) : null, doc ? JSON.stringify(doc) : null,
        )
        writeData(db, id, data)
        logAudit(db, id, 'system', 'imported', { batch, pipeline_status: status })
        res.added++
      } catch (e) {
        res.failed++
        if (res.errors.length < 5) res.errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  })()
  return res
}

/** 导入流水线导出的 portal_package.zip: receipts_result.json + images/。 */
export function importZip(db: Database, dataDir: string, bytes: Uint8Array) {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (f) => /receipts_result\.json$/.test(f.name) || WEB_EXT.has(extname(f.name).toLowerCase()) })
  } catch {
    throw new HttpError(400, 'ZIP_INVALID')
  }
  const jsonName = Object.keys(files).find((n) => n.endsWith('receipts_result.json'))
  if (!jsonName) throw new HttpError(400, 'ZIP_NO_RESULTS')
  let results: unknown
  try { results = JSON.parse(new TextDecoder().decode(files[jsonName]!)) } catch { throw new HttpError(400, 'RESULTS_JSON_INVALID') }
  if (!Array.isArray(results)) throw new HttpError(400, 'RESULTS_BAD_FORMAT')
  const byBase = new Map(Object.entries(files).filter(([n]) => n !== jsonName).map(([n, b]) => [basename(n), b]))
  return ingest(db, dataDir, results, (r) => (typeof r.image === 'string' && files[r.image]) || byBase.get(String(r.file)) || null, `zip ${nowLocal()}`)
}

/** 先导入了 JSON、图片后补: 按文件名把图片挂到还没有图片的记录上。 */
export function attachImage(db: Database, dataDir: string, file: string, bytes: Uint8Array): number {
  if (!file) throw new HttpError(400, 'FILENAME_MISSING')
  const s = saveImage(dataDir, bytes, file)
  return db.query('UPDATE receipts SET image = ?, img_hash = ? WHERE file = ? AND image IS NULL').run(s.file, s.hash, file).changes
}
