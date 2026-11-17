import { beforeAll, describe, expect, test } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { openDb } from '../db'
import { toAmount } from '../lib/clean'
import type { Analytics, BulkPreview, BulkResult, ListResponse, ReceiptDetail, Stats } from '../../shared/types'

// 1x1 透明 PNG;改一个字节就能得到"内容不同"的另一张图
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const png = (n: number) => { const b = PNG.slice(); b[b.length - 20] = n; return b }

const data = (o: Record<string, unknown>) => ({ merchant: null, date: null, currency: 'MYR', subtotal: null, tax: null, total: null, items: [], ...o })
const SAMPLE = [
  { file: 'a.png', status: 'REVIEW', reasons: ['total_conflicts_with_text_rule', 'verifier_disagrees:total'], data: data({ merchant: 'MR. D.I.Y.', date: '2017-12-28', subtotal: 9.9, tax: 0.56, total: 6, items: [{ name: 'PADLOCK', qty: 1, price: 9.9 }] }), regex_total: 9.9, suggested_total: 9.9, image: 'images/a.png' },
  { file: 'b.png', status: 'PARTIAL', reasons: ['items_sum_ne_subtotal'], data: data({ merchant: 'AEON CO. (M) BHD', date: '2018-02-19', subtotal: 17.7, total: 17.7 }), image: 'images/b.png' },
  { file: 'c.png', status: 'AUTO', reasons: [], data: data({ merchant: 'SAMPLE SHOP', date: '2018-03-03', subtotal: 58, total: 58 }), image: 'images/c.png' },
  { file: 'd.png', status: 'AUTO_VERIFIED', reasons: ['audit_sample'], data: data({ merchant: '=cmd|evil', date: '2018-04-04', total: 12.5 }), image: 'images/d.png' },
  { file: 'e.png', status: 'REVIEW', reasons: ['extract_failed'], data: null, image: 'images/e.png' },
]
const buildZip = (results: unknown[] = SAMPLE) =>
  zipSync({
    'receipts_result.json': strToU8(JSON.stringify(results)),
    ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k, i) => [`images/${k}.png`, png(i + 1)])),
  })

let dir: string
let webDir: string
const makeApp = (over: Partial<{ token: string; localOnly: boolean; webDir: string }> = {}) => {
  dir = mkdtempSync(join(tmpdir(), 'portal-test-'))
  return createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'no-web'), ...over })
}
type App = ReturnType<typeof makeApp>

const call = async (app: App, path: string, init: { method?: string; json?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'x-portal': '1', ...init.headers }
  let body: string | Uint8Array | undefined
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json) }
  if (init.raw) { headers['content-type'] = 'application/octet-stream'; body = init.raw }
  const res = await app.handle(new Request('http://localhost' + path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text, headers: res.headers }
}

describe('清洗与解析', () => {
  test('toAmount 支持各种写法', () => {
    expect(toAmount('RM 1,234.56')).toBe(1234.56)
    expect(toAmount('1.234,56')).toBe(1234.56)
    expect(toAmount('(5.00)')).toBe(-5)
    expect(toAmount('28,73')).toBe(28.73)
    expect(toAmount('')).toBeNull()
    expect(() => toAmount('abc')).toThrow()
  })
})

describe('导入与查询', () => {
  let app: App
  beforeAll(async () => {
    app = makeApp()
  })

  test('导入 zip: 新增 5 张,图片落盘', async () => {
    const r = await call(app, '/api/import/zip', { raw: buildZip() })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ added: 5, duplicates: 0, withoutImage: 0, failed: 0 })
    expect(readdirSync(join(dir, 'images')).length).toBe(5)
  })

  test('重复导入会跳过', async () => {
    const r = await call(app, '/api/import/zip', { raw: buildZip() })
    expect(r.json).toMatchObject({ added: 0, duplicates: 5 })
  })

  test('坏压缩包 / 缺少结果文件给出中文提示', async () => {
    expect((await call(app, '/api/import/zip', { raw: strToU8('not a zip') })).json.error).toContain('压缩包')
    expect((await call(app, '/api/import/zip', { raw: zipSync({ 'x.txt': strToU8('hi') }) })).json.error).toContain('receipts_result.json')
  })

  test('待审核队列按优先级排序;统计正确', async () => {
    const r = (await call(app, '/api/receipts?state=pending')).json as ListResponse
    expect(r.rows.map((x) => x.pipelineStatus)).toEqual(['REVIEW', 'REVIEW', 'PARTIAL', 'AUTO_VERIFIED', 'AUTO'])
    const s = (await call(app, '/api/stats')).json as Stats
    expect(s).toMatchObject({ pending: 5, approved: 0, rejected: 0 })
    expect(s.pendingByStatus.REVIEW).toBe(2)
  })

  test('分页、排序、搜索、币种汇总', async () => {
    const p1 = (await call(app, '/api/receipts?state=all&pageSize=2&page=2&sort=total&dir=desc')).json as ListResponse
    expect(p1).toMatchObject({ total: 5, page: 2, pageSize: 2 })
    expect(p1.rows.length).toBe(2)
    const q = (await call(app, '/api/receipts?state=all&q=AEON')).json as ListResponse
    expect(q.rows.map((x) => x.file)).toEqual(['b.png'])
    const pct = (await call(app, '/api/receipts?state=all&q=' + encodeURIComponent('100%'))).json as ListResponse
    expect(pct.total).toBe(0) // % 是普通字符,不会变成通配符
    const sums = (await call(app, '/api/receipts?state=all')).json as ListResponse
    expect(sums.sums.find((s) => s.currency === 'MYR')).toMatchObject({ count: 4 }) // 识别失败的那张没有币种
    expect(sums.sums.find((s) => s.currency === null)).toMatchObject({ count: 1 })
  })

  test('机器识别失败的收据以空白表单导入', async () => {
    const list = (await call(app, '/api/receipts?state=all&q=e.png')).json as ListResponse
    const d = (await call(app, `/api/receipts/${list.rows[0]!.id}`)).json as ReceiptDetail
    expect(d.data.merchant).toBeNull()
    expect(d.data.items).toEqual([])
    expect(d.audit[0]).toMatchObject({ user: 'system', action: 'imported' })
  })

  test('不存在的收据 / 接口返回 404', async () => {
    expect((await call(app, '/api/receipts/99999')).status).toBe(404)
    expect((await call(app, '/api/nope')).status).toBe(404)
  })
})

describe('审核流程', () => {
  let app: App
  let id: number
  beforeAll(async () => {
    app = makeApp()
    await call(app, '/api/import/zip', { raw: buildZip() })
    id = ((await call(app, '/api/receipts?state=pending&q=a.png')).json as ListResponse).rows[0]!.id
  })
  const detail = async () => (await call(app, `/api/receipts/${id}`)).json as ReceiptDetail
  const review = (body: Record<string, unknown>) => call(app, `/api/receipts/${id}/review`, { json: body })

  test('校验: 缺审核人 / 日期格式 / 金额格式 / 驳回无原因 / 通过缺商家', async () => {
    const d = await detail()
    const base = { version: d.version, final: d.data }
    expect((await review({ ...base, action: 'approve', user: '  ' })).json.error).toContain('审核人')
    expect((await review({ ...base, action: 'approve', user: 'Ann', final: { ...d.data, date: '17/06/2018' } })).json.error).toContain('日期')
    expect((await review({ ...base, action: 'approve', user: 'Ann', final: { ...d.data, date: '2018-02-30' } })).json.error).toContain('日期')
    expect((await review({ ...base, action: 'approve', user: 'Ann', final: { ...d.data, tax: 'abc' } })).json.error).toContain('税额')
    expect((await review({ ...base, action: 'reject', user: 'Ann' })).json.error).toContain('原因')
    expect((await review({ ...base, action: 'approve', user: 'Ann', final: { ...d.data, merchant: '' } })).json.error).toContain('商家')
  })

  test('通过并修改: 状态、列值、商品表、修改字段、审计', async () => {
    const d = await detail()
    const r = await review({ action: 'approve', version: d.version, user: 'Ann', final: { ...d.data, total: 'RM 9.90', items: [{ name: 'PADLOCK', qty: 1, price: '9,90' }] } })
    expect(r.status).toBe(200)
    const x = r.json as ReceiptDetail
    expect(x).toMatchObject({ state: 'approved', total: 9.9, reviewer: 'Ann', version: d.version + 1 })
    expect(x.editedFields).toEqual(['total']) // 价格 9,90 -> 9.9 与机器结果相同,不算改动
    expect(x.machine.total).toBe(6) // 机器原始值保留
    expect(x.audit[0]).toMatchObject({ user: 'Ann', action: 'approve', detail: { changed: ['total'] } })
  })

  test('版本冲突返回 409', async () => {
    const d = await detail()
    expect((await review({ action: 'reject', version: d.version - 1, user: 'Bob', note: 'x', final: d.data })).status).toBe(409)
  })

  test('重新打开 -> 驳回(需原因)', async () => {
    let d = await detail()
    expect(((await review({ action: 'reopen', version: d.version, user: 'Ann' })).json as ReceiptDetail).state).toBe('pending')
    d = await detail()
    expect(d.reviewer).toBeNull()
    const r = (await review({ action: 'reject', version: d.version, user: 'Ann', note: '图片太模糊', final: d.data })).json as ReceiptDetail
    expect(r).toMatchObject({ state: 'rejected', note: '图片太模糊' })
  })

  test('批量通过: 默认只通过没问题的;有问题的和缺商家/总额的跳过并说明', async () => {
    const list = (await call(app, '/api/receipts?state=pending')).json as ListResponse
    const ids = list.rows.map((x) => x.id)
    // pending: b(系统标为 PARTIAL 且没人改过 → 有问题)、c(干净)、d(干净)、e(空白,不能通过)
    const prev = (await call(app, '/api/bulk/preview', { json: { ids } })).json as BulkPreview
    expect(prev.clean).toBe(2)
    expect(prev.flagged.map((p) => p.codes)).toEqual([['system.PARTIAL']])
    expect(prev.blocked[0]!.codes).toEqual(['missing_merchant', 'missing_total'])
    const r = (await call(app, '/api/bulk', { json: { ids, action: 'approve', user: 'Ann' } })).json as BulkResult
    expect(r).toMatchObject({ done: 2, skipped: 2, approvedFlagged: 0 })
    expect(r.flagged).toHaveLength(1)
    expect(r.blocked).toHaveLength(1)
    // 有问题的那张必须员工明确选 scope=all 才会通过,并且审计里记下当时没解决的问题
    const b = list.rows.find((x) => x.file === 'b.png')!
    const all = (await call(app, '/api/bulk', { json: { ids: [b.id], action: 'approve', user: 'Ann', scope: 'all' } })).json as BulkResult
    expect(all).toMatchObject({ done: 1, approvedFlagged: 1 })
    const log = ((await call(app, `/api/receipts/${b.id}`)).json as ReceiptDetail).audit[0]!
    expect(log.detail).toMatchObject({ bulk: true, unresolved: ['system.PARTIAL'] })
    const s = (await call(app, '/api/stats')).json as Stats
    expect(s).toMatchObject({ pending: 1, approved: 3, rejected: 1 })
  })

  test('统计分析: 金额、人工修改率、系统初判对比', async () => {
    const a = (await call(app, '/api/analytics')).json as Analytics
    expect(a.kpis).toMatchObject({ total: 5, approved: 3, rejected: 1, pending: 1 })
    expect(a.kpis.approvedAmounts[0]).toMatchObject({ currency: 'MYR', count: 3 })
    expect(a.kpis.approvedAmounts[0]!.sum).toBeCloseTo(17.7 + 58 + 12.5, 2)
    expect(a.currency).toBe('MYR')
    expect(a.series.length).toBeGreaterThan(0)
    expect(a.topMerchants[0]!.merchant).toBe('SAMPLE SHOP')
    // 这三张都是批量通过的,没有逐张看过 → 不能算"人工确认系统是对的",所有准确率指标没有样本
    expect(a.kpis).toMatchObject({ bulkApproved: 3, editSample: 0, editRate: null, autoSample: 0, autoPrecision: null })
    const auto = a.calibration.find((c) => c.status === 'AUTO')!
    expect(auto).toMatchObject({ approvedUnchanged: 0, approvedBulk: 1 })
    expect(a.reviewers[0]).toMatchObject({ reviewer: 'Ann', bulk: 3 })
    const range = (await call(app, '/api/analytics?from=2018-03-01&to=2018-03-31')).json as Analytics
    expect(range.kpis.approved).toBe(1)
  })

  test('导出 CSV: BOM、表头、公式注入被中和', async () => {
    const r = await call(app, '/api/export/receipts.csv?state=approved')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/csv')
    const raw = new Uint8Array(await (await app.handle(new Request('http://localhost/api/export/receipts.csv?state=approved'))).arrayBuffer())
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // UTF-8 BOM,Excel 直接打开不乱码
    expect(r.text).toContain('商家')
    expect(r.text).toContain("'=cmd|evil") // 以 = 开头的文本被加了单引号
    expect(r.text.trim().split('\r\n').length).toBe(1 + 3)
  })

  test('审计日志可按用户和动作筛选', async () => {
    const a = (await call(app, '/api/audit?user=Ann&action=approve')).json
    expect(a.total).toBeGreaterThanOrEqual(4)
    expect(a.rows.every((x: { user: string }) => x.user === 'Ann')).toBe(true)
    expect(a.users).toContain('Ann')
  })
})

describe('安全', () => {
  test('写操作必须带 x-portal 头', async () => {
    const app = makeApp()
    const res = await app.handle(new Request('http://localhost/api/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":[],"action":"approve","user":"a"}' }))
    expect(res.status).toBe(403)
  })

  test('设了口令: 无口令 401,错误口令 401,正确口令放行(头或 ?t=)', async () => {
    const app = makeApp({ token: 's3cret' })
    expect((await call(app, '/api/stats')).status).toBe(401)
    expect((await call(app, '/api/stats', { headers: { 'x-token': 'nope' } })).status).toBe(401)
    expect((await call(app, '/api/stats', { headers: { 'x-token': 's3cret' } })).status).toBe(200)
    expect((await call(app, '/api/stats?t=s3cret')).status).toBe(200)
  })

  test('只监听本机时拒绝陌生 Host(防 DNS rebinding)', async () => {
    const app = makeApp()
    const res = await app.handle(new Request('http://evil.example.com/api/stats', { headers: { 'x-portal': '1' } }))
    expect(res.status).toBe(403)
  })

  test('静态文件: 单页应用回退到 index.html,且不能读到目录外的文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portal-web-'))
    webDir = join(root, 'web-dist')
    mkdirSync(join(webDir, 'assets'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>SPA</title>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(root, 'secret.txt'), 'TOP SECRET')
    const app = makeApp({ webDir })
    const home = await call(app, '/')
    expect(home.text).toContain('SPA')
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await call(app, '/analytics/deep/link')).text).toContain('SPA')
    expect((await call(app, '/assets/app.js')).text).toContain('console.log')
    for (const evil of ['/../secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt']) {
      expect((await call(app, evil)).text).not.toContain('TOP SECRET')
    }
  })

  test('前端未构建时给出清晰提示', async () => {
    const app = makeApp()
    const r = await call(app, '/')
    expect(r.status).toBe(503)
    expect(r.text).toContain('bun run build')
    expect(existsSync(join(dir, 'portal.db'))).toBe(true)
  })
})
