import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { openDb } from '../db'
import { maskPan } from '../lib/pan'

const makeApp = (token = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-v1-'))
  return { app: createApp({ db: openDb(dir), dataDir: dir, token, localOnly: true, webDir: join(dir, 'no-web') }), dir }
}
const post = (app: ReturnType<typeof makeApp>['app'], path: string, json: unknown, headers: Record<string, string> = {}) =>
  app.handle(new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(json) }))

describe('银行卡号掩码', () => {
  test('通过 Luhn 的卡号只留后 4 位', () => {
    expect(maskPan('VISA 4111 1111 1111 1111 THANK').text).toBe('VISA **** **** **** 1111 THANK')
    expect(maskPan('4111-1111-1111-1111').masked).toBe(1)
  })
  test('小票号、电话、条码不会被误伤', () => {
    for (const s of ['No: 1234567890123', 'Tel 0123456789', 'Ref 1111111111111111', 'TOTAL 12345.67']) expect(maskPan(s).masked).toBe(0)
  })
})

describe('/v1 对外接口', () => {
  test('validate: 不需要 x-portal 头,返回契约版本与对账结果', async () => {
    const { app } = makeApp()
    const res = await post(app, '/v1/validate', { currency: 'MYR', subtotal: 100, tax: 6, total: 106 })
    expect(res.status).toBe(200)
    const j = (await res.json()) as any
    expect(j.schema_version).toBe('1.0')
    expect(j.has_failure).toBe(false)
    expect(j.mode).toBe('exclusive')
  })
  test('validate: 对不上时 has_failure 为真并给出检查项', async () => {
    const { app } = makeApp()
    const j = (await (await post(app, '/v1/validate', { currency: 'MYR', subtotal: 100, tax: 6, total: 120 })).json()) as any
    expect(j.has_failure).toBe(true)
    expect(j.checks.find((c: any) => c.id === 'total_formula').status).toBe('fail')
  })
  test('validate: 多税率 taxes[] 求和补出税额,不一致只警告', async () => {
    const { app } = makeApp()
    const ok = (await (await post(app, '/v1/validate', { currency: 'EUR', subtotal: 100, total: 113, taxes: [{ rate: 7, base: 50, amount: 3.5 }, { rate: 19, base: 50, amount: 9.5 }] })).json()) as any
    expect(ok.has_failure).toBe(false)
    expect(ok.warnings).toEqual([])
    const bad = (await (await post(app, '/v1/validate', { currency: 'EUR', subtotal: 100, tax: 10, total: 110, taxes: [{ rate: 7, base: 50, amount: 3.5 }] })).json()) as any
    expect(bad.warnings).toContain('taxes_sum_ne_tax')
  })
  test('validate: 字段类型不对返回 400', async () => {
    const { app } = makeApp()
    expect((await post(app, '/v1/validate', { total: 'abc' })).status).toBe(400)
  })
  test('口令: 支持 Authorization: Bearer,缺少或错误返回 401', async () => {
    const { app } = makeApp('s3cret')
    expect((await post(app, '/v1/validate', { total: 1 })).status).toBe(401)
    expect((await post(app, '/v1/validate', { total: 1 }, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post(app, '/v1/validate', { total: 1 }, { authorization: 'Bearer s3cret' })).status).toBe(200)
  })
  test('未知 /v1 路径返回 404 而不是页面', async () => {
    const { app } = makeApp()
    expect((await app.handle(new Request('http://localhost/v1/nope'))).status).toBe(404)
  })
  test('查询不存在的收据返回 404;schema 可读', async () => {
    const { app } = makeApp()
    expect((await app.handle(new Request('http://localhost/v1/receipts/999'))).status).toBe(404)
    const s = (await (await app.handle(new Request('http://localhost/v1/schema'))).json()) as any
    expect(s.untrusted_text_fields).toContain('merchant.name')
  })
  test('导入后: 公开契约不含 OCR 原文,卡号已掩码并标注原因', async () => {
    const { app } = makeApp()
    const rows = [{ file: 'x.png', status: 'AUTO', reasons: [], data: { merchant: 'SHOP', date: '2024-01-02', currency: 'MYR', subtotal: 10, tax: 0, total: 10, items: [] }, ocr_text: 'CARD 4111 1111 1111 1111 TOTAL 10.00' }]
    const imp = await post(app, '/api/import/json', rows, { 'x-portal': '1' })
    expect(imp.status).toBe(200)
    const pub = (await (await app.handle(new Request('http://localhost/v1/receipts/1'))).json()) as any
    expect(pub.schema_version).toBe('1.0')
    expect(pub.amounts.total).toBe(10)
    expect(pub.quality.reasons).toContain('card_number_masked')
    expect(JSON.stringify(pub)).not.toContain('4111')
    expect(JSON.stringify(pub)).not.toContain('ocr')
    const detail = (await (await app.handle(new Request('http://localhost/api/receipts/1'))).json()) as any
    expect(detail.ocrText).toContain('1111')
    expect(detail.ocrText).not.toContain('4111')
  })
})

describe('静态文件与图片缓存', () => {
  test('支持 gzip 的浏览器拿到压缩版;图片带 ETag 并支持 304', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'portal-static-'))
    const web = join(dir, 'web')
    mkdirSync(join(web, 'assets'), { recursive: true })
    writeFileSync(join(web, 'index.html'), '<html>' + 'x'.repeat(5000) + '</html>')
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1);'.repeat(500))
    const app = createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: web })
    const gz = await app.handle(new Request('http://localhost/assets/app.js', { headers: { 'accept-encoding': 'gzip, br' } }))
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gz.headers.get('content-type')).toContain('javascript')
    const raw = new Uint8Array(await gz.arrayBuffer())
    expect(raw.length).toBeLessThan(7500)
    expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe('console.log(1);'.repeat(500))
    const plain = await app.handle(new Request('http://localhost/assets/app.js'))
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect((await plain.text()).length).toBe(7500)

    // 图片 ETag
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const { zipSync, strToU8 } = await import('fflate')
    const zip = zipSync({ 'receipts_result.json': strToU8(JSON.stringify([{ file: 'a.png', status: 'AUTO', data: { merchant: 'S', total: 1 }, image: 'images/a.png' }])), 'images/a.png': png })
    const imp = await app.handle(new Request('http://localhost/api/import/zip', { method: 'POST', headers: { 'x-portal': '1' }, body: zip }))
    expect(imp.status).toBe(200)
    const first = await app.handle(new Request('http://localhost/api/image/1'))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()
    const second = await app.handle(new Request('http://localhost/api/image/1', { headers: { 'if-none-match': etag } }))
    expect(second.status).toBe(304)
  })
})
