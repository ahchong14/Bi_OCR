import { beforeAll, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { openDb } from '../db'
import type { ListResponse, ReceiptDetail } from '../../shared/types'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const png = (n: number) => { const b = PNG.slice(); b[b.length - 20] = n; return b }
const data = (o: Record<string, unknown>) => ({ merchant: null, date: null, currency: 'MYR', subtotal: null, tax: null, total: null, items: [], ...o })
const SAMPLE = [
  { file: 'a.png', status: 'REVIEW', reasons: ['verifier_disagrees:total'], data: data({ merchant: 'MR. D.I.Y.', date: '2017-12-28', subtotal: 9.9, total: 9.9 }), image: 'images/a.png' },
  { file: 'b.png', status: 'PARTIAL', reasons: [], data: data({ merchant: 'AEON CO. (M) BHD', date: '2018-02-19', subtotal: 17.7, total: 17.7 }), image: 'images/b.png' },
  { file: 'c.png', status: 'AUTO', reasons: [], data: data({ merchant: 'SAMPLE SHOP', date: '2018-03-03', subtotal: 58, total: 58 }), image: 'images/c.png' },
]
const buildZip = () => zipSync({ 'receipts_result.json': strToU8(JSON.stringify(SAMPLE)), ...Object.fromEntries(['a', 'b', 'c'].map((k, i) => [`images/${k}.png`, png(i + 1)])) })

type App = ReturnType<typeof createApp>
let dir = ''
const makeApp = () => {
  dir = mkdtempSync(join(tmpdir(), 'portal-v2-'))
  return createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'no-web') })
}
const call = async (app: App, path: string, init: { json?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'x-portal': '1', ...init.headers }
  let body: string | Uint8Array | undefined
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json) }
  if (init.raw) { headers['content-type'] = 'application/octet-stream'; body = init.raw }
  const res = await app.handle(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers, body }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

describe('v2: 双语提示 / 新字段 / 批量操作 / 重复检测', () => {
  let app: App
  beforeAll(async () => {
    app = makeApp()
    await call(app, '/api/import/zip', { raw: buildZip() })
  })
  const first = async (q: string) => ((await call(app, `/api/receipts?${q}`)).json as ListResponse).rows[0]!

  test('错误提示按 x-lang 返回英文,默认中文,同时带 code', async () => {
    const r = await first('state=pending&q=a.png')
    const body = { action: 'approve', version: r.version, user: ' ', final: {} }
    const zh = await call(app, `/api/receipts/${r.id}/review`, { json: body })
    const en = await call(app, `/api/receipts/${r.id}/review`, { json: body, headers: { 'x-lang': 'en' } })
    expect(zh.json).toMatchObject({ code: 'USER_REQUIRED', error: '请先在右上角填写审核人姓名' })
    expect(en.json).toMatchObject({ code: 'USER_REQUIRED', error: 'Please enter your name in the top-right corner first' })
    const bad = await call(app, `/api/receipts/${r.id}/review`, { json: { action: 'save', version: r.version, user: 'Ann', final: { tip: 'abc' } }, headers: { 'x-lang': 'en' } })
    expect(bad.json.error).toBe('"Tip" is not a valid amount') // 字段名也按语言翻译
    expect((await call(app, '/api/nope', { headers: { 'x-lang': 'en' } })).json.error).toBe('Unknown API endpoint')
  })

  test('新字段(小费/其他费用/实付/找零)保存并回读', async () => {
    const r = await first('state=pending&q=c.png')
    const d = (await call(app, `/api/receipts/${r.id}`)).json as ReceiptDetail
    const res = await call(app, `/api/receipts/${r.id}/review`, { json: { action: 'save', version: d.version, user: 'Ann', final: { ...d.data, tip: '2.00', fees: 'RM 3', paid: '100', change: '37' } } })
    expect(res.json).toMatchObject({ tip: 2, fees: 3, paid: 100, change: 37 })
    expect(res.json.editedFields).toEqual(expect.arrayContaining(['tip', 'fees', 'paid', 'change']))
  })

  test('跨批次重复检测:商家、日期、总额相同', async () => {
    const dup = { ...SAMPLE[2]!, file: 'c-copy.png', image: undefined } // 与 c.png 商家/日期/总额相同,但没有图片
    expect((await call(app, '/api/import/json', { json: [dup] })).json).toMatchObject({ added: 1 })
    const copy = await first('state=pending&q=c-copy')
    const d = (await call(app, `/api/receipts/${copy.id}`)).json as ReceiptDetail
    expect(d.duplicates.map((x) => x.file)).toEqual(['c.png'])
    const orig = await first('state=pending&q=c.png')
    expect(((await call(app, `/api/receipts/${orig.id}`)).json as ReceiptDetail).duplicates.map((x) => x.file)).toEqual(['c-copy.png'])
  })

  test('批量驳回必须写原因;批量重新打开只作用于已处理的', async () => {
    const ids = ((await call(app, '/api/receipts?state=pending&q=a.png')).json as ListResponse).rows.map((x) => x.id)
    expect((await call(app, '/api/bulk', { json: { ids, action: 'reject', user: 'Ann' } })).json.code).toBe('REJECT_NEEDS_NOTE')
    expect((await call(app, '/api/bulk', { json: { ids, action: 'reject', user: 'Ann', note: '重复提交' } })).json).toMatchObject({ done: 1, skipped: 0 })
    expect((await call(app, '/api/bulk', { json: { ids, action: 'reject', user: 'Ann', note: 'x' } })).json).toMatchObject({ done: 0, skipped: 1 }) // 已不是待审核
    expect((await call(app, '/api/bulk', { json: { ids, action: 'reopen', user: 'Ann' } })).json).toMatchObject({ done: 1, skipped: 0 })
    expect((await call(app, '/api/bulk', { json: { ids, action: 'reopen', user: 'Ann' } })).json).toMatchObject({ done: 0, skipped: 1 }) // 已经是待审核
  })

  test('只导出选中的收据(ids),CSV 表头按语言', async () => {
    const a = await first('state=pending&q=a.png')
    const b = await first('state=pending&q=b.png')
    const en = await call(app, `/api/export/receipts.csv?state=all&ids=${a.id},${b.id}&lang=en`)
    expect(en.text).toContain('Merchant')
    expect(en.text).toContain('Tip')
    expect(en.text.trim().split('\r\n').length).toBe(3)
    expect((await call(app, `/api/export/receipts.csv?state=all&ids=${a.id}`)).text).toContain('小费')
    expect((await call(app, '/api/export/receipts.csv?state=all&ids=abc')).text.trim().split('\r\n').length).toBe(1) // 非法 ids → 只有表头
  })

  test('旧版本数据库(v1)升级到 v2 后数据保留', async () => {
    const { Database } = await import('bun:sqlite')
    const d = mkdtempSync(join(tmpdir(), 'portal-mig-'))
    mkdirSync(join(d, 'images'), { recursive: true })
    const old = new Database(join(d, 'portal.db'), { create: true })
    old.exec(`CREATE TABLE receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, img_hash TEXT, image TEXT, batch TEXT, imported_at TEXT NOT NULL,
      pipeline_status TEXT NOT NULL, priority INTEGER NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', machine TEXT NOT NULL, corrections TEXT NOT NULL DEFAULT '[]',
      suggestions TEXT NOT NULL DEFAULT '[]', verifier TEXT, regex_total REAL, suggested_total REAL, ocr_text TEXT, timing TEXT,
      state TEXT NOT NULL DEFAULT 'pending', merchant TEXT, date TEXT, currency TEXT, subtotal REAL, discount REAL, service_charge REAL, tax REAL, rounding REAL, total REAL,
      items TEXT NOT NULL DEFAULT '[]', edited_fields TEXT NOT NULL DEFAULT '[]', reviewer TEXT, reviewed_at TEXT, note TEXT, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE receipt_items (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL, name TEXT NOT NULL, qty REAL, price REAL);
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER, ts TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
      INSERT INTO receipts(file, imported_at, pipeline_status, priority, machine, ocr_text, merchant, total) VALUES ('old.png', '2026-01-01T00:00:00', 'AUTO', 4, '{"total":9.5}', 'OLD OCR TEXT', 'OLD SHOP', 9.5);
      PRAGMA user_version = 1;`)
    old.close()
    const migrated = createApp({ db: openDb(d), dataDir: d, token: '', localOnly: true, webDir: join(d, 'x') })
    const rows = (await call(migrated, '/api/receipts?state=all')).json as ListResponse
    expect(rows.rows[0]).toMatchObject({ file: 'old.png', merchant: 'OLD SHOP', total: 9.5, tip: null, paid: null })
    // v3: 大字段拆到 receipt_blobs 后仍可读
    const detail = (await call(migrated, `/api/receipts/${rows.rows[0]!.id}`)).json as ReceiptDetail
    expect(detail.ocrText).toBe('OLD OCR TEXT')
    expect(detail.machine.total).toBe(9.5)
  })
})
