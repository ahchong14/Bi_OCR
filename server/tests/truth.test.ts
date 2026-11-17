import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { openDb } from '../db'
import { parseCsv, similarity, sourceOf, truthAmount } from '../lib/truth'
import type { AccuracyReport, ReceiptDetail, TruthImportResult } from '../../shared/types'

describe('标准答案: 解析', () => {
  test('CSV: 引号、逗号、换行、BOM、空行', () => {
    const rows = parseCsv('﻿file,company,total\r\na.jpg,"SHOP, THE ""BEST""",12.50\n\nb.jpg,"two\nlines",$7.60\n')
    expect(rows).toEqual([['file', 'company', 'total'], ['a.jpg', 'SHOP, THE "BEST"', '12.50'], ['b.jpg', 'two\nlines', '$7.60']])
  })
  test('总额写法: RM8.60 / $7.60 / 1,234.50 / 59.54', () => {
    expect(truthAmount('RM8.60')).toBe(8.6)
    expect(truthAmount('$7.60')).toBe(7.6)
    expect(truthAmount('1,234.50')).toBe(1234.5)
    expect(truthAmount('59.54')).toBe(59.54)
    expect(truthAmount('')).toBeNull()
    expect(truthAmount('n/a')).toBeNull()
  })
  test('商家名相似度: 一两个字母的 OCR 差异算同一个,不同商家不算', () => {
    expect(similarity('LIAN HING STATIONERY SDN BHD', 'LAN HING STATIONERY SDN BHD')).toBeGreaterThanOrEqual(0.9)
    expect(similarity("Nando's Chickenland Malaysia Sdn Bhd", "NANDO'S CHICKENLAND MALAYSIA SDN BHD")).toBe(1)
    expect(similarity('FRwOnL', 'SYARIKAT PERNIAGAAN GIN KEE')).toBeLessThan(0.5)
  })
  test('识别来源取自批次名', () => {
    expect(sourceOf('scan 2026-11-02 12:00:00 · minicpm-ocr@abc.trycloudflare.com')).toBe('minicpm-ocr')
    expect(sourceOf('scan 2026-11-02 12:00:00 · ocr.space')).toBe('ocr.space')
    expect(sourceOf('zip 2026-11-02T12:00:00')).toBe('zip')
    expect(sourceOf(null)).toBe('unknown')
  })
})

describe('标准答案: 导入与准确率对照', () => {
  const makeApp = () => { const dir = mkdtempSync(join(tmpdir(), 'portal-truth-')); return createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x') }) }
  const call = async (app: ReturnType<typeof makeApp>, path: string, init: { json?: unknown; text?: string } = {}) => {
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.text
    const res = await app.handle(new Request('http://localhost' + path, { method: body !== undefined ? 'POST' : 'GET', headers: { 'x-portal': '1', 'content-type': init.json !== undefined ? 'application/json' : 'text/csv', 'x-lang': 'en' }, body }))
    return { status: res.status, json: (await res.json()) as any }
  }
  const r = (file: string, merchant: string, date: string, total: number, extra: Record<string, unknown> = {}) =>
    ({ file, status: 'REVIEW', reasons: [], data: { merchant, date, currency: 'MYR', total, subtotal: total, items: [] }, ...extra })
  const CSV = [
    'file,company,date,address,total',
    'a.jpg,GARDENIA BAKERIES (KL) SDN BHD,12/10/2017,"LOT 3, JALAN PELABUR",59.54',
    'b.jpg,UNIHAKKA INTERNATIONAL SDN BHD,05 MAY 2018,,$11.20',
    'c.jpg,KEDAI PAPAN YEW CHUAN,03/05/2018,,178.08',
    'd.jpg,NOT IMPORTED SHOP,01/01/2018,,1.00',
  ].join('\n')

  test('导入: 新增、更新、坏格式的提示', async () => {
    const app = makeApp()
    expect((await call(app, '/api/truth/import', { text: CSV })).json).toMatchObject({ added: 4, updated: 0, failed: 0 })
    expect((await call(app, '/api/truth/import', { text: CSV })).json).toMatchObject({ added: 0, updated: 4 })
    expect(((await call(app, '/api/truth/info')).json as { count: number }).count).toBe(4)
    const bad = await call(app, '/api/truth/import', { text: 'hello' })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('TRUTH_BAD_FORMAT')
    const noFile = await call(app, '/api/truth/import', { text: 'x,y\n1,2' })
    expect(noFile.status).toBe(400)
  })

  test('准确率: 机器读对几个、人工改完后对几个,按来源分开,列出读错的', async () => {
    const app = makeApp()
    // a: 机器全对;b: 机器总额读错(8.2 ≠ 11.20)、商家少一个字母仍算对;c: 日期读错(2018-03-05 ≠ 2018-05-03)
    await call(app, '/api/import/json', {
      json: [r('a.jpg', 'GARDENIA BAKERIES (KL) SDN BHD', '2017-10-12', 59.54), r('b.jpg', 'UNIHAKKA INTERNATIONAL SDN BH', '2018-05-05', 8.2), r('c.jpg', 'KEDAI PAPAN YEW CHUAN', '2018-03-05', 178.08), r('e.jpg', 'NO LABEL SHOP', '2018-01-01', 5)],
    })
    await call(app, '/api/truth/import', { text: CSV })
    // 人工把 b 的总额改成 11.20 并通过 → 「人工改完后」对了,机器原始结果仍然是错的
    const b = (await call(app, '/api/receipts?state=all&q=b.jpg')).json.rows[0]
    const d = (await call(app, `/api/receipts/${b.id}`)).json as ReceiptDetail
    await call(app, `/api/receipts/${b.id}/review`, { json: { action: 'approve', version: d.version, user: 'Ann', final: { ...d.data, total: '11.20' } } })

    const rep = (await call(app, '/api/accuracy')).json as AccuracyReport
    expect(rep).toMatchObject({ labelled: 4, matched: 3 }) // e.jpg 没有标准答案,d.jpg 没导入收据
    expect(rep.sources).toHaveLength(1)
    const s = rep.sources[0]!
    expect(s.source).toBe('json')
    expect(s.total).toEqual({ n: 3, machine: 2, final: 1, finalN: 1 }) // 机器 a、c 对;b 错 → 2/3;已审核的只有 b,改对了 → 1/1
    expect(s.date).toMatchObject({ n: 3, machine: 2 }) // c 错
    expect(s.company).toMatchObject({ n: 3, machine: 3 }) // b 少一个字母(相似度 ≥0.9)
    const miss = rep.mismatches.map((m) => `${m.file}:${m.field}`).sort()
    expect(miss).toEqual(['b.jpg:total', 'c.jpg:date'])
    expect(rep.mismatches.find((m) => m.file === 'b.jpg')).toMatchObject({ machine: '8.2', truth: '11.2', finalOk: true })
  })

  test('没有导入标准答案时返回空报告,不报错', async () => {
    const app = makeApp()
    expect((await call(app, '/api/accuracy')).json).toEqual({ labelled: 0, matched: 0, sources: [], mismatches: [] })
  })
})
