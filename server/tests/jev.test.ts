import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createApp } from '../app'
import { openDb } from '../db'
import { miniCpmProvider } from '../lib/minicpm'
import type { JevMode } from '../lib/ocr'
import { jevOpts } from '../lib/scan'
import { applyJev, fromStructured, JEV_DEFAULT_THRESHOLD } from '../lib/structured'
import type { ReceiptDetail, ScanOutcome } from '../../shared/types'

// 和 minicpm.test.ts 同样的假模型,外加一个假的 /jev/score(网关)
const TEXT = ['SYARIKAT RUNCIT MAJU SDN BHD', 'Date: 15/08/2025', 'Nasi Lemak Ayam 2 x 8.50 17.00', 'Teh Tarik 1 x 3.20 3.20', 'Roti Canai 3 x 2.00 6.00',
  'Subtotal 26.20', 'SST 6% 1.57', 'Rounding 0.03-', 'TOTAL 27.74', 'CASH 30.00', 'CHANGE 2.26'].join('\n')
const GOOD = {
  core: { merchant_name: 'SYARIKAT RUNCIT MAJU SDN BHD', date: '15/08/2025', currency: 'RM', subtotal: '26.20', tax_amount: '1.57', total: '27.74' },
  extra: { discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '0.03-', amount_paid: '30.00', change_given: '2.26' },
  items: { line_items: [{ description: 'Nasi Lemak Ayam', quantity: '2', unit_price: '8.50', amount: '17.00' }, { description: 'Teh Tarik', quantity: '1', unit_price: '3.20', amount: '3.20' }, { description: 'Roti Canai', quantity: '3', unit_price: '2.00', amount: '6.00' }] },
  text: TEXT,
}
type JevCall = { url: string; auth: string | undefined; body: { image: string; text: string } }
function fakeFetch(jev: { calls: JevCall[]; reply?: () => Response | Promise<Response> }, over: Partial<Record<keyof typeof GOOD, unknown>> = {}): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/jev/score')) {
      jev.calls.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) })
      return jev.reply ? jev.reply() : Response.json({ score: 0.9, verdict: 'scored' })
    }
    const body = JSON.parse(String(init.body))
    const prompt = (body.messages[0].content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!
    const kind = prompt.startsWith('Text Recognition') ? 'text' : prompt.includes('line_items') ? 'items' : prompt.includes('"merchant_name"') ? 'core' : 'extra'
    const out = kind in over ? over[kind as keyof typeof GOOD] : GOOD[kind as keyof typeof GOOD]
    return Response.json({ choices: [{ message: { content: typeof out === 'string' ? out : JSON.stringify(out) } }] })
  }) as unknown as typeof fetch
}
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } }).jpeg().toBuffer().then((b) => new Uint8Array(b))
const mk = (f: typeof fetch, jev: JevMode, extra: Record<string, unknown> = {}) =>
  miniCpmProvider({ baseUrl: 'https://abc.trycloudflare.com', apiKey: 'sekret', fetchImpl: f, fullText: true, jev, ...extra })

afterEach(() => { jevOpts.threshold = JEV_DEFAULT_THRESHOLD; jevOpts.demote = false })

// ---------------------------------------------------------------- applyJev(纯函数)
describe('applyJev: 分数只会让结果更谨慎,不会更"可信"', () => {
  const base = () => fromStructured({ fields: GOOD.core && { ...GOOD.core, ...GOOD.extra }, items: GOOD.items.line_items, text: TEXT, failed: [], ms: 1, provider: 'x' })
  test('前提: 这张没问题 → 基本可信', () => { expect(base().status).toBe('AUTO_VERIFIED') })
  test('分数高: 只记录,状态和原因不变', () => {
    const e = applyJev(base(), { score: 0.93, verdict: 'scored' })
    expect(e.status).toBe('AUTO_VERIFIED')
    expect(e.reasons).not.toContain('jev_low')
    expect(e.verifier?.jev).toEqual({ score: 0.93, verdict: 'scored', threshold: 0.5 })
    expect(e.verifier?.agree).toEqual({ merchant: true, date: true, total: true }) // 原来的第二次读取结果还在
  })
  test('分数低(默认只提示): 加 jev_low,状态不变', () => {
    const e = applyJev(base(), { score: 0.2, verdict: 'scored' })
    expect(e.reasons).toContain('jev_low')
    expect(e.status).toBe('AUTO_VERIFIED')
  })
  test('分数低 + demote: 「基本可信」降为「需检查」', () => {
    expect(applyJev(base(), { score: 0.2, verdict: 'scored' }, { demote: true }).status).toBe('REVIEW')
  })
  test('分数刚好等于阈值不算低;阈值可调', () => {
    expect(applyJev(base(), { score: 0.5, verdict: 'scored' }).reasons).not.toContain('jev_low')
    expect(applyJev(base(), { score: 0.6, verdict: 'scored' }, { threshold: 0.7 }).reasons).toContain('jev_low')
  })
  test('没打成(verdict 不是 scored): 只记录原因,不加提示,更不能降级——验证器故障不等于收据有问题', () => {
    const e = applyJev(base(), { score: null, verdict: 'render_failed' }, { demote: true })
    expect(e.reasons).not.toContain('jev_low')
    expect(e.status).toBe('AUTO_VERIFIED')
    expect(e.verifier?.jev).toEqual({ score: null, verdict: 'render_failed', threshold: 0.5 })
  })
  test('已经是「需检查」的,低分不会改变状态(也不会把它变得更"可信")', () => {
    const bad = fromStructured({ fields: { ...GOOD.core, merchant_name: '###' }, items: [], text: TEXT, failed: [], ms: 1, provider: 'x' }) // 缺商家: 一定是「需检查」(总额读错会被仲裁改正、缺日期会从转写补上,都不再适合当例子)
    expect(bad.status).toBe('REVIEW')
    expect(applyJev(bad, { score: 0.99, verdict: 'scored' }).status).toBe('REVIEW')
  })
  test('没有原来的 verifier(没有转写)时也能记录', () => {
    const noText = fromStructured({ fields: GOOD.core, items: [], text: '', failed: [], ms: 1, provider: 'x' })
    expect(noText.verifier).toBeNull()
    expect(applyJev(noText, { score: 0.8, verdict: 'scored' }).verifier).toMatchObject({ saw: null, agree: null, jev: { score: 0.8 } })
  })
})

// ---------------------------------------------------------------- provider.verify
describe('miniCpmProvider.verify', () => {
  const img = () => jpeg(300, 500)
  test('请求格式: 同一个地址 + /jev/score,带同一个密钥,body 是 {image(纯 base64), text}', async () => {
    const jev = { calls: [] as JevCall[] }
    const r = await mk(fakeFetch(jev), 'all').verify!(await img(), TEXT)
    expect(r).toEqual({ score: 0.9, verdict: 'scored' })
    expect(jev.calls[0]!.url).toBe('https://abc.trycloudflare.com/jev/score')
    expect(jev.calls[0]!.auth).toBe('Bearer sekret')
    expect(jev.calls[0]!.body.text).toBe(TEXT)
    expect(jev.calls[0]!.body.image.startsWith('data:')).toBe(false)
    expect(Buffer.from(jev.calls[0]!.body.image, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8') // JPEG
  })
  test('网关没开 Jev(404)、网络错误、超时、返回乱码 → 都是 null,不抛错', async () => {
    const jev = { calls: [] as JevCall[] }
    const p = (reply: () => Response | Promise<Response>) => mk(fakeFetch({ ...jev, reply }), 'all').verify!
    expect(await p(() => new Response('no', { status: 404 }))(await img(), TEXT)).toBeNull()
    expect(await p(() => { throw new Error('network down') })(await img(), TEXT)).toBeNull()
    expect(await p(() => new Response('not json'))(await img(), TEXT)).toBeNull()
  })
  test('verdict 不是 scored 时分数一律当作没有(0.0 / -1.0 是固定的失败值,不是低分)', async () => {
    const jev = { calls: [] as JevCall[], reply: () => Response.json({ score: 0.0, verdict: 'render_failed' }) }
    expect(await mk(fakeFetch(jev), 'all').verify!(await img(), TEXT)).toEqual({ score: null, verdict: 'render_failed' })
  })
  test('空转写不调用', async () => {
    const jev = { calls: [] as JevCall[] }
    expect(await mk(fakeFetch(jev), 'all').verify!(await img(), '   ')).toBeNull()
    expect(jev.calls).toHaveLength(0)
  })
  test('jevMode 默认 off', () => { expect(mk(fakeFetch({ calls: [] }), undefined as unknown as JevMode).jevMode).toBe('off') })
})

// ---------------------------------------------------------------- 扫描端到端
describe('/api/scan + Jev', () => {
  const run = async (jevMode: JevMode, over: Partial<Record<keyof typeof GOOD, unknown>> = {}, reply?: () => Response | Promise<Response>, w = 320) => {
    const jev = { calls: [] as JevCall[], reply }
    const dir = mkdtempSync(join(tmpdir(), 'portal-jev-'))
    const app = createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x'), ocr: mk(fakeFetch(jev, over), jevMode), ocrSharedKey: false })
    const r = await app.handle(new Request('http://localhost/api/scan?file=r.jpg', { method: 'POST', headers: { 'x-portal': '1', 'x-lang': 'en' }, body: await jpeg(w, 520) }))
    const out = (await r.json()) as ScanOutcome
    const d = (await (await app.handle(new Request(`http://localhost/api/receipts/${out.id}`))).json()) as ReceiptDetail
    return { jev, out, d }
  }
  const fabricated = { text: TEXT.replace('SST 6% 1.57\n', '') } // 模型编造了税额 → 「需检查」

  test('off(默认): 从不调用,存的 verifier 里没有 jev', async () => {
    const { jev, d } = await run('off', fabricated)
    expect(jev.calls).toHaveLength(0)
    expect(d.verifier.jev).toBeUndefined()
  })
  test('flagged: 基本可信的不调用(省时间)', async () => {
    const { jev, out } = await run('flagged')
    expect(out.status).toBe('AUTO_VERIFIED')
    expect(jev.calls).toHaveLength(0)
  })
  test('flagged: 「需检查」的才调用,分数和阈值存进验证器,审核页读得到;耗时里有 jev', async () => {
    const { jev, out, d } = await run('flagged', fabricated, () => Response.json({ score: 0.31, verdict: 'scored' }), 321)
    expect(out.status).toBe('REVIEW')
    expect(jev.calls).toHaveLength(1)
    expect(d.verifier.jev).toEqual({ score: 0.31, verdict: 'scored', threshold: 0.5 })
    expect(d.reasons).toContain('jev_low')
    expect(d.timing).toHaveProperty('jev')
  })
  test('all: 基本可信的也打分(用来标定阈值);分数高不改变任何东西', async () => {
    const { jev, out, d } = await run('all', {}, undefined, 322)
    expect(jev.calls).toHaveLength(1)
    expect(out.status).toBe('AUTO_VERIFIED')
    expect(d.verifier.jev).toMatchObject({ score: 0.9, verdict: 'scored' })
    expect(d.reasons).not.toContain('jev_low')
  })
  test('all + 低分 + 降级开关: 入库就是「需检查」', async () => {
    jevOpts.demote = true
    const { out, d } = await run('all', {}, () => Response.json({ score: 0.1, verdict: 'scored' }), 323)
    expect(out.status).toBe('REVIEW')
    expect(d.reasons).toContain('jev_low')
  })
  test('all + 低分 + 默认(不降级): 状态不变,只多一条提示', async () => {
    const { out, d } = await run('all', {}, () => Response.json({ score: 0.1, verdict: 'scored' }), 324)
    expect(out.status).toBe('AUTO_VERIFIED')
    expect(d.reasons).toContain('jev_low')
  })
  test('验证器挂了(网关返回 500): 扫描照常成功,只是没有 jev', async () => {
    const { out, d } = await run('all', {}, () => new Response('boom', { status: 500 }), 325)
    expect(out.status).toBe('AUTO_VERIFIED')
    expect(d.verifier.jev).toBeUndefined()
    expect(d.data.total).toBe(27.74)
  })
  test('没有整页转写(fullText 关)时不调用', async () => {
    const jev = { calls: [] as JevCall[] }
    const dir = mkdtempSync(join(tmpdir(), 'portal-jev-'))
    const app = createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x'), ocr: mk(fakeFetch(jev), 'all', { fullText: false }), ocrSharedKey: false })
    await app.handle(new Request('http://localhost/api/scan?file=r.jpg', { method: 'POST', headers: { 'x-portal': '1' }, body: await jpeg(326, 520) }))
    expect(jev.calls).toHaveLength(0)
  })
})
