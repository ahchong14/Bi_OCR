import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createApp } from '../app'
import { openDb } from '../db'
import { claudeProvider, TEXT_PROMPT, type ClaudeClientLike } from '../lib/claude'
import type { OcrProvider } from '../lib/ocr'
import type { PublicReceipt } from '../../shared/public'
import type { ScanOutcome } from '../../shared/types'

// 另一个系统通过 POST /v1/scan 把发票图片交给门户: Bearer 口令、原始图片字节、不需要门户专用的 x-portal 头。
const FIELDS = {
  merchant_name: 'ACME TRADING SDN BHD', date: '17/06/2018', currency: 'MYR', subtotal: '10.00', tax_amount: '0.60', total: '10.60',
  discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '20.00', change_given: '9.40',
  line_items: [{ description: 'COFFEE', quantity: '2', unit_price: '5.00', amount: '10.00' }],
}
const TRANSCRIPT = 'ACME TRADING SDN BHD\n17/06/2018\nCOFFEE 2 5.00 10.00\nSUBTOTAL 10.00\nSST 0.60\nTOTAL 10.60\nCASH 20.00\nCHANGE 9.40'

function fakeClaude() {
  const state = { calls: 0 }
  const client: ClaudeClientLike = {
    messages: {
      async create(p) {
        state.calls++
        const prompt = ((p.messages[0]!.content as Anthropic.ContentBlockParam[]).find((b) => b.type === 'text') as { text: string }).text
        const text = prompt === TEXT_PROMPT ? TRANSCRIPT : JSON.stringify(FIELDS)
        return { id: 'm', type: 'message', role: 'assistant', model: p.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message
      },
    },
  }
  return { state, provider: claudeProvider({ client }) }
}

const TOKEN = 'secret-token'
const makeApp = (ocr: OcrProvider | null, token = TOKEN) => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-scanapi-'))
  return createApp({ db: openDb(dir), dataDir: dir, token, localOnly: true, webDir: join(dir, 'x'), ocr, ocrSharedKey: false })
}
const img = async (seed: number) => new Uint8Array(await sharp({ create: { width: 200 + seed, height: 300, channels: 3, background: '#fff' } }).jpeg().toBuffer())
const post = (app: ReturnType<typeof makeApp>, file: string, body: Uint8Array, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  app.handle(new Request(`http://localhost/v1/scan?file=${encodeURIComponent(file)}`, { method: 'POST', headers, body }))

describe('POST /v1/scan(给另一个系统调用)', () => {
  test('带口令上传一张图: 识别 → 入库 → 返回扫描结果 + 公开契约的收据', async () => {
    const { provider, state } = fakeClaude()
    const app = makeApp(provider)
    const r = await post(app, 'inv-001.jpg', await img(1))
    expect(r.status).toBe(200)
    const body = (await r.json()) as { scan: ScanOutcome; receipt: PublicReceipt }
    expect(body.scan).toMatchObject({ file: 'inv-001.jpg', duplicate: false, merchant: 'ACME TRADING SDN BHD', total: 10.6, currency: 'MYR' })
    expect(body.receipt.id).toBe(body.scan.id!)
    expect(body.receipt.merchant.name).toBe('ACME TRADING SDN BHD')
    expect(body.receipt.amounts).toMatchObject({ total: 10.6, tax: 0.6, paid: 20, change: 9.4 })
    expect(body.receipt.document).toMatchObject({ date: '2018-06-17', currency: 'MYR' })
    expect(body.receipt.line_items).toHaveLength(1)
    expect(body.receipt.review.state).toBe('pending') // 进入待审核队列,和界面上传的一样
    expect(state.calls).toBe(2) // 字段 + 整页转写
  })

  test('不需要门户专用的 x-portal 头(那是给浏览器防跨站用的)', async () => {
    const app = makeApp(fakeClaude().provider)
    expect((await post(app, 'a.jpg', await img(2), { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
  })

  test('没带口令 / 口令错 → 401,而且不会调用模型', async () => {
    const { provider, state } = fakeClaude()
    const app = makeApp(provider)
    expect((await post(app, 'a.jpg', await img(3), {})).status).toBe(401)
    expect((await post(app, 'a.jpg', await img(3), { authorization: 'Bearer wrong' })).status).toBe(401)
    expect(state.calls).toBe(0)
  })

  test('同一张图再传: 返回已有结果,不再调用模型(省钱)', async () => {
    const { provider, state } = fakeClaude()
    const app = makeApp(provider)
    const bytes = await img(4)
    const a = (await (await post(app, 'a.jpg', bytes)).json()) as { scan: ScanOutcome }
    const n = state.calls
    const b = (await (await post(app, 'a-again.jpg', bytes)).json()) as { scan: ScanOutcome; receipt: PublicReceipt }
    expect(b.scan.duplicate).toBe(true)
    expect(b.scan.id).toBe(a.scan.id)
    expect(b.receipt.id).toBe(a.scan.id!)
    expect(state.calls).toBe(n)
  })

  test('GET /v1/health: 联调用,不调用模型;口令不对 → 401;扫描没开时 scan_enabled = false', async () => {
    const { provider, state } = fakeClaude()
    const get = (app: ReturnType<typeof makeApp>, headers: Record<string, string>) => app.handle(new Request('http://localhost/v1/health', { headers }))
    const on = makeApp(provider)
    const ok = (await (await get(on, { authorization: `Bearer ${TOKEN}` })).json()) as Record<string, unknown>
    expect(ok).toMatchObject({ ok: true, scan_enabled: true, provider: 'claude-haiku-5-5' })
    expect((await get(on, {})).status).toBe(401)
    expect(state.calls).toBe(0)
    const off = (await (await get(makeApp(null), { authorization: `Bearer ${TOKEN}` })).json()) as Record<string, unknown>
    expect(off).toMatchObject({ ok: true, scan_enabled: false, provider: null })
  })

  test('扫描没开(没设 ANTHROPIC_API_KEY) → 503', async () => {
    const app = makeApp(null)
    expect((await post(app, 'a.jpg', await img(5))).status).toBe(503)
  })

  test('空请求体 → 400;不支持的文件类型 → 400', async () => {
    const app = makeApp(fakeClaude().provider)
    expect((await post(app, 'a.jpg', new Uint8Array())).status).toBe(400)
    expect((await post(app, 'a.pdf', await img(6))).status).toBe(400)
  })

  test('Claude 额度 / 限流 → 429,密钥错 → 502(不把 Anthropic 的错误细节原样透出)', async () => {
    const h = new Headers()
    const failing = (err: unknown): OcrProvider => claudeProvider({ client: { messages: { create: async () => { throw err } } } })
    const limited = await post(makeApp(failing(new Anthropic.RateLimitError(429, { type: 'error' }, 'slow', h))), 'a.jpg', await img(7))
    expect(limited.status).toBe(429)
    const badKey = await post(makeApp(failing(new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key sk-ant-SECRET', h))), 'a.jpg', await img(8))
    expect(badKey.status).toBe(502)
    expect(await badKey.text()).not.toContain('sk-ant-SECRET')
  })
})
