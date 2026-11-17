import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, openDb } from '../db'
import { getDetail, listReceipts } from '../lib/receipts'

/** 造一个「刚好在 v9」的旧库,里面放一张旧收据,再用 openDb 升级到 v10。 */
function legacyV9(): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-mig10-'))
  mkdirSync(join(dir, 'images'), { recursive: true })
  const db = new Database(join(dir, 'portal.db'), { create: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  expect(MIGRATIONS.length).toBe(10)
  for (let i = 0; i < 9; i++) db.exec(MIGRATIONS[i]!)
  db.exec('PRAGMA user_version = 9')
  db.query("INSERT INTO receipts(file, imported_at, pipeline_status, priority, reasons, merchant, date, currency, total, items) VALUES ('old.jpg','2026-01-01T00:00:00','AUTO',4,'[]','OLD SHOP','2026-01-01','MYR',12.5,'[]')").run()
  db.query("INSERT INTO receipt_blobs(receipt_id, machine) VALUES (1, '{}')").run()
  db.close()
  return dir
}

const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[])

describe('迁移 v9 → v10(单据分类)', () => {
  test('从 v9 库升级: 版本变成 10,旧收据完好,新列都是空 / 默认值', () => {
    const dir = legacyV9()
    const db = openDb(dir)
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10)
    const d = getDetail(db, 1)
    expect(d).toMatchObject({ file: 'old.jpg', merchant: 'OLD SHOP', total: 12.5, currency: 'MYR', pipelineStatus: 'AUTO' })
    expect(d).toMatchObject({ documentType: null, direction: null, typeConfidence: null, docNo: null, title: null, docEdited: false, doc: null })
    expect(listReceipts(db, { state: 'all' }).total).toBe(1)
    expect(listReceipts(db, { state: 'all', type: 'none' }).total).toBe(1)
  })

  test('新增的列和索引都在;doc_edited 不允许为空且默认 0', () => {
    const db = openDb(legacyV9())
    const r = columns(db, 'receipts').map((c) => c.name)
    for (const c of ['document_type', 'direction', 'type_confidence', 'doc_no', 'title', 'doc_edited']) expect(r).toContain(c)
    expect(columns(db, 'receipt_blobs').map((c) => c.name)).toContain('doc')
    const edited = columns(db, 'receipts').find((c) => c.name === 'doc_edited')!
    expect([edited.notnull, edited.dflt_value]).toEqual([1, '0'])
    const idx = (db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name)
    expect(idx).toContain('idx_receipts_type')
    expect(idx).toContain('idx_receipts_docno')
  })

  test('升级是幂等的: 再打开一次不会重复迁移,数据不变', () => {
    const dir = legacyV9()
    openDb(dir).close()
    const db = openDb(dir)
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10)
    expect(listReceipts(db, { state: 'all' }).total).toBe(1)
  })

  test('全新的库也直接到 v10', () => {
    const db = openDb(mkdtempSync(join(tmpdir(), 'portal-mig10-new-')))
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10)
    expect(columns(db, 'receipts').map((c) => c.name)).toContain('document_type')
  })

  test('v10 之前的迁移文本没有被改动(只追加了一条)', () => {
    expect(MIGRATIONS[8]).toContain('second_state') // v9
    expect(MIGRATIONS[9]).toContain('document_type') // v10
    expect(MIGRATIONS[9]).not.toMatch(/DROP|DELETE|UPDATE\s/i) // 只加列加索引,不动旧数据
  })
})
