import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AMOUNT_MAX, parseAmount } from '../../shared/amount'
import { createApp } from '../app'
import { openDb } from '../db'
import { toAmount } from '../lib/clean'
import type { Analytics, ListResponse, ReceiptDetail } from '../../shared/types'

const ok = (v: unknown) => { const r = parseAmount(v); if (!r.ok) throw new Error(`rejected: ${String(v)} (${r.error})`); return r.value }
const err = (v: unknown) => { const r = parseAmount(v); return r.ok ? null : r.error }

describe('金额解析: 宁可拒绝,不能悄悄改成别的数', () => {
  test('常见合法写法', () => {
    expect(ok('12.50')).toBe(12.5)
    expect(ok('RM 1,234.56')).toBe(1234.56)
    expect(ok('1.234,56')).toBe(1234.56)
    expect(ok('1,234,567.89')).toBe(1234567.89)
    expect(ok('28,73')).toBe(28.73)
    expect(ok('(5.00)')).toBe(-5)
    expect(ok('-5')).toBe(-5)
    expect(ok('5-')).toBe(-5)
    expect(ok('$ 9')).toBe(9)
    expect(ok('30元')).toBe(30)
    expect(ok('12.50 MYR')).toBe(12.5)
    expect(ok('1,234')).toBe(1234)
    expect(ok('1 234,50')).toBe(1234.5)
    expect(ok('')).toBeNull()
    expect(ok('   ')).toBeNull()
    expect(ok(null)).toBeNull()
    expect(ok(12.345)).toBe(12.35)
  })

  test('字母 O 代替 0、夹杂字母、多个小数点一律拒绝(以前会被悄悄改成别的数)', () => {
    for (const bad of ['1O.50', '12abc.5.5', 'l2.50', '12.5.5', '1,2,3', 'abc', '12..5', '12.', '.5', '12-5', 'RM', '1e5', '१२']) expect(err(bad)).toBe('format')
    expect(() => toAmount('1O.50')).toThrow()
  })

  test('有歧义的 1.234(欧洲千分位还是写错的小数)不猜,让员工写清楚', () => {
    expect(err('1.234')).toBe('ambiguous')
    expect(err('12.500')).toBe('ambiguous')
    expect(ok('1.234,5')).toBe(1234.5)
  })

  test('大得不合理的金额拒绝,不再静默失去精度', () => {
    expect(err('99999999999999999')).toBe('range')
    expect(err(AMOUNT_MAX + 1)).toBe('range')
    expect(ok(AMOUNT_MAX)).toBe(AMOUNT_MAX)
    expect(err(Number.NaN)).toBe('format')
    expect(err(true)).toBe('format')
  })
})

describe('接口: 写错的金额返回 400,不会存进去', () => {
  const makeApp = () => { const dir = mkdtempSync(join(tmpdir(), 'portal-amt-')); return createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x') }) }
  const call = async (app: ReturnType<typeof makeApp>, path: string, json?: unknown) => {
    const res = await app.handle(new Request('http://localhost' + path, { method: json ? 'POST' : 'GET', headers: { 'x-portal': '1', 'content-type': 'application/json', 'x-lang': 'en' }, body: json ? JSON.stringify(json) : undefined }))
    return { status: res.status, json: (await res.json()) as any }
  }
  const seed = [{ file: 'a.png', status: 'AUTO', reasons: [], data: { merchant: 'SHOP', date: '2024-01-02', currency: 'MYR', subtotal: 10, total: 10, items: [] } }]

  test('保存时金额写成 1O.50 或太大: 400 + 具体提示,数据没被改', async () => {
    const app = makeApp()
    await call(app, '/api/import/json', seed)
    const d = (await call(app, '/api/receipts/1')).json as ReceiptDetail
    const body = (total: string) => ({ action: 'save', version: d.version, user: 'Ann', final: { ...d.data, total } })
    const bad = await call(app, '/api/receipts/1/review', body('1O.50'))
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('AMOUNT_INVALID')
    const big = await call(app, '/api/receipts/1/review', body('99999999999999999'))
    expect(big.json.code).toBe('AMOUNT_RANGE')
    expect(((await call(app, '/api/receipts/1')).json as ReceiptDetail).data.total).toBe(10)
  })

  test('流水线导入的数据格式不合格时只丢掉那个字段,不会把整张收据清空', async () => {
    const app = makeApp()
    await call(app, '/api/import/json', [{ file: 'x.png', status: 'AUTO', reasons: [], data: { merchant: 'KEEP ME', date: '2024-02-02', currency: 'MYR', total: '1O.50', subtotal: 5, items: [{ name: 'ok', qty: 1, price: 5 }, { name: 'bad', qty: 1, price: '??' }] } }])
    const d = (await call(app, '/api/receipts/1')).json as ReceiptDetail
    expect(d.data).toMatchObject({ merchant: 'KEEP ME', total: null, subtotal: 5 })
    expect(d.data.items).toHaveLength(1)
  })

  test('统计: 逐张审核通过才算"人工确认",批量通过的单独计数', async () => {
    const app = makeApp()
    const rows = Array.from({ length: 4 }, (_, i) => ({ file: `p${i}.png`, status: 'AUTO', reasons: [], data: { merchant: 'S' + i, date: '2024-03-0' + (i + 1), currency: 'MYR', subtotal: 10, total: 10, items: [] } }))
    await call(app, '/api/import/json', rows)
    const list = (await call(app, '/api/receipts?state=pending')).json as ListResponse
    // 两张逐张通过(其中一张改过金额),两张批量通过
    const one = (await call(app, `/api/receipts/${list.rows[0]!.id}`)).json as ReceiptDetail
    await call(app, `/api/receipts/${one.id}/review`, { action: 'approve', version: one.version, user: 'Ann', final: one.data })
    const two = (await call(app, `/api/receipts/${list.rows[1]!.id}`)).json as ReceiptDetail
    await call(app, `/api/receipts/${two.id}/review`, { action: 'approve', version: two.version, user: 'Ann', final: { ...two.data, total: '12.00' } })
    await call(app, '/api/bulk', { ids: [list.rows[2]!.id, list.rows[3]!.id], action: 'approve', user: 'Ann' })
    const a = (await call(app, '/api/analytics')).json as Analytics
    expect(a.kpis).toMatchObject({ approved: 4, editSample: 2, bulkApproved: 2, editRate: 0.5, autoSample: 2, autoPrecision: 0.5 })
    expect(a.fieldCorrections.find((f) => f.field === 'total')).toMatchObject({ count: 1, rate: 0.5 })
    // 重新打开一张批量通过的,它就不再算批量
    await call(app, '/api/bulk', { ids: [list.rows[2]!.id], action: 'reopen', user: 'Ann' })
    expect(((await call(app, '/api/analytics')).json as Analytics).kpis.bulkApproved).toBe(1)
  })
})
