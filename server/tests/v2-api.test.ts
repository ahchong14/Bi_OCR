import { afterEach, describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { DOC_TYPES, DOC_TYPE_INFO } from '../../shared/doctypes'
import type { PublicDocumentV2 } from '../../shared/public2'
import type { ReceiptDetail } from '../../shared/types'
import { createApp } from '../app'
import { openDb } from '../db'
import { claudeProvider, TEXT_PROMPT, type ClaudeClientLike } from '../lib/claude'
import { classifyOpts } from '../lib/classify'
import { ingest } from '../lib/importer'
import { ourCompanyOpts, parseOurCompany } from '../lib/ourCompany'
import type { PublicListItemV2, PublicScanV2 } from '../lib/v2'
import { TRANSCRIPT, modelDoc, party } from './fixtures/modeldoc'
import { validate } from './helpers/jsonschema'

// 对外 API v2 的契约测试: 鉴权、每个接口的形状(用 JSON Schema 校验)、错误码、/v1 不受影响。
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, '../../shared/schema/document-v2.schema.json'), 'utf8')) as Record<string, unknown>
const TOKEN = 'secret-token'
const OUR = 'OUR TRADING SDN BHD'
const DEFAULT_TRUSTED = new Set(classifyOpts.trusted)
afterEach(() => { ourCompanyOpts.company = null; classifyOpts.trusted = new Set(DEFAULT_TRUSTED) })

interface Opts { doc?: Record<string, unknown>; transcript?: string; scanOff?: boolean; fail?: Error }
function makeApp(o: Opts = {}) {
  const calls = { n: 0 }
  let doc = o.doc ?? modelDoc()
  const client: ClaudeClientLike = {
    messages: {
      async create(p) {
        calls.n++
        if (o.fail) throw o.fail
        const prompt = ((p.messages[0]!.content as Anthropic.ContentBlockParam[]).find((b) => b.type === 'text') as { text: string }).text
        const text = prompt === TEXT_PROMPT ? (o.transcript ?? TRANSCRIPT) : JSON.stringify(doc)
        return { id: 'm', type: 'message', role: 'assistant', model: p.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message
      },
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'portal-v2-'))
  const db = openDb(dir)
  const app = createApp({ db, dataDir: dir, token: TOKEN, localOnly: true, webDir: join(dir, 'x'), ocr: o.scanOff ? null : claudeProvider({ client, classify: true }), ocrSharedKey: false })
  return { app, db, dir, calls, setDoc: (d: Record<string, unknown>) => { doc = d } }
}
type Ctx = ReturnType<typeof makeApp>
let seed = 300
const img = async () => new Uint8Array(await sharp({ create: { width: 100 + seed++, height: 160, channels: 3, background: '#fff' } }).jpeg().toBuffer())
const auth = { authorization: `Bearer ${TOKEN}` }
const get = (c: Ctx, path: string, headers: Record<string, string> = auth) => c.app.handle(new Request(`http://localhost${path}`, { headers }))
const scan = (c: Ctx, file: string, bytes: Uint8Array, q = '', headers: Record<string, string> = auth) =>
  c.app.handle(new Request(`http://localhost/v2/scan?file=${encodeURIComponent(file)}${q}`, { method: 'POST', headers, body: bytes }))
const scanOk = async (c: Ctx, file: string, q = '') => { const r = await scan(c, file, await img(), q); expect(r.status).toBe(200); return (await r.json()) as { scan: PublicScanV2; receipt: PublicDocumentV2 } }
const err = async (r: Response) => (await r.json()) as { error: string; code: string }
const INVOICE = { document_type: 'invoice', evidence: ['TAX INVOICE', 'Bill To'], counterparty: party('XYZ SDN BHD') }

describe('鉴权: 和 /v1 同一套(Authorization: Bearer),不要求门户专用的 x-portal 头', () => {
  test('没带口令 / 口令错 → 401 TOKEN_REQUIRED(每个接口都一样),而且不会调用模型', async () => {
    const c = makeApp()
    for (const path of ['/v2/health', '/v2/types', '/v2/receipts', '/v2/receipts/1']) {
      expect({ path, s: (await get(c, path, {})).status }).toEqual({ path, s: 401 })
      expect({ path, s: (await get(c, path, { authorization: 'Bearer wrong' })).status }).toEqual({ path, s: 401 })
    }
    const r = await scan(c, 'a.jpg', await img(), '', {})
    expect(r.status).toBe(401)
    expect((await err(r)).code).toBe('TOKEN_REQUIRED')
    expect(calls(c)).toBe(0)
  })
  test('带对口令就行,POST 不需要 x-portal 头;x-token 头也认', async () => {
    const c = makeApp()
    expect((await scan(c, 'a.jpg', await img(), '', auth)).status).toBe(200)
    expect((await get(c, '/v2/health', { 'x-token': TOKEN })).status).toBe(200)
  })
  test('未知的 /v2 路径返回 JSON 404,不是网页', async () => {
    const r = await get(makeApp(), '/v2/nope')
    expect(r.status).toBe(404)
    expect((await err(r)).code).toBe('API_NOT_FOUND')
  })
})
const calls = (c: Ctx) => c.calls.n

describe('GET /v2/health 与 GET /v2/types', () => {
  test('health: 不调用模型;扫描 / 分类开关、我方身份、信任类型、阈值', async () => {
    const c = makeApp()
    const h = (await (await get(c, '/v2/health')).json()) as Record<string, unknown>
    expect(h).toMatchObject({ ok: true, scan_enabled: true, provider: 'claude-haiku-5-5', classify_enabled: true, schema_version: '2.0', our_company_configured: false, trusted_types: ['receipt'], min_confidence: 0.8 })
    expect(typeof h.max_image_bytes).toBe('number')
    expect(calls(c)).toBe(0)
    ourCompanyOpts.company = parseOurCompany({ OUR_COMPANY_NAMES: OUR })
    expect(((await (await get(c, '/v2/health')).json()) as { our_company_configured: boolean }).our_company_configured).toBe(true)
  })
  test('health: 扫描没开时 scan_enabled = false', async () => {
    const h = (await (await get(makeApp({ scanOff: true }), '/v2/health')).json()) as Record<string, unknown>
    expect(h).toMatchObject({ ok: true, scan_enabled: false, provider: null, classify_enabled: false })
  })

  test('types: 全部 9 个类型,字段要求、映射和代码里的清单一致', async () => {
    const t = (await (await get(makeApp(), '/v2/types')).json()) as { schema_version: string; types: any[]; directions: string[]; type_verdicts: string[]; payment_methods: string[] }
    expect(t.schema_version).toBe('2.0')
    expect(t.types.map((x) => x.id)).toEqual([...DOC_TYPES])
    for (const x of t.types) {
      const i = DOC_TYPE_INFO[x.id as keyof typeof DOC_TYPE_INFO]
      expect({ id: x.id, label: x.label, postable: x.postable, reconcile: x.reconcile_amounts, needs: x.needs }).toEqual({ id: i.id, label: { zh: i.zh, en: i.en }, postable: i.postable, reconcile: i.reconcileAmounts, needs: i.needs })
    }
    const by = (id: string) => t.types.find((x) => x.id === id)!
    expect(by('receipt').autocount.purchase).toEqual({ entity: 'gl.cash_book', code: 'PV', party_role: null, post_as: 'cash_book_voucher', verified: true })
    expect(by('receipt').autocount.sales).toMatchObject({ entity: 'sales.cash_sale', code: 'CS', party_role: 'debtor' })
    expect(by('invoice')).toMatchObject({ postable: false, model_outputs: true, autocount: { sales: null, purchase: null } })
    expect(by('sales_invoice')).toMatchObject({ model_outputs: false, default_direction: 'sales' }) // 由代码按方向从「发票」落成
    expect(by('quotation').autocount.sales.verified).toBe(false) // 还没用 describe_entity 核对过
    expect(t.directions).toEqual(['sales', 'purchase', 'unknown'])
    expect(t.type_verdicts).toContain('direction_unknown')
  })
})

describe('POST /v2/scan', () => {
  test('成功: 返回 { scan, receipt },receipt 通过 JSON Schema;分类 / 标题 / 关键词 / 对方 / 金额 / 商品行都在', async () => {
    const c = makeApp()
    const { scan: s, receipt: r } = await scanOk(c, 'r.jpg')
    expect(s).toMatchObject({ file: 'r.jpg', duplicate: false, status: 'AUTO_VERIFIED', document_type: 'receipt', direction: 'purchase', merchant: 'ACME TRADING SDN BHD', total: 10.6, items: 1, title: 'ACME TRADING SDN BHD receipt INV-1023 (2018-10-17)' })
    expect(Object.keys(s).every((k) => k === k.toLowerCase())).toBe(true) // 对外全是下划线命名,没有驼峰
    expect(validate(SCHEMA, r)).toEqual([])
    expect(r.id).toBe(s.id!)
    expect(r.classification).toMatchObject({ document_type: 'receipt', autocount_doc_type: 'PV', direction: 'purchase', confidence: 0.93, type_verdict: 'ok' })
    expect(r.title).toBe('ACME TRADING SDN BHD receipt INV-1023 (2018-10-17)')
    expect(r.keywords).toEqual(['acme trading', 'coffee', 'cash'])
    expect(r.header).toMatchObject({ doc_no: 'INV-1023', doc_date: '2018-10-17', currency: 'MYR' })
    expect(r.parties.issuer?.name_as_printed).toBe('ACME TRADING SDN BHD')
    expect(r.amounts).toMatchObject({ subtotal: 10, tax: 0.6, total: 10.6, paid: 20, change: 9.4 })
    expect(r.line_items).toHaveLength(1)
    expect(r.line_items[0]).toMatchObject({ line_no: 1, description: 'COFFEE', quantity: 2, unit_price: 5, total_price: 10 })
    expect(r.autocount_hint).toMatchObject({ entity: 'gl.cash_book', post_as: 'cash_book_voucher', needs_master_match: false })
    expect(r.quality).toMatchObject({ verdict: 'AUTO_VERIFIED', type_verdict: 'ok', needs_review: true, needs_review_reasons: [] })
    expect(r.review.state).toBe('pending')
  })

  test('v2 输出里没有 OCR 原文、图片路径、审核备注等内部信息', async () => {
    const { receipt } = await scanOk(makeApp(), 'r.jpg')
    const json = JSON.stringify(receipt)
    expect(json).not.toContain('Bill To: XYZ') // 转写原文
    for (const k of ['ocr_text', 'ocrText', '"image"', 'boxes', 'machine']) expect(json).not.toContain(k)
  })

  test('配置了我方身份: 开单方是我们的发票 → sales_invoice,对方 = 客户,AutoCount 提示是 sales.invoice', async () => {
    ourCompanyOpts.company = parseOurCompany({ OUR_COMPANY_NAMES: OUR })
    const c = makeApp({ doc: modelDoc({ ...INVOICE, issuer: party(OUR) }) })
    const { scan: s, receipt: r } = await scanOk(c, 'i.jpg')
    expect(s).toMatchObject({ status: 'REVIEW', document_type: 'sales_invoice', direction: 'sales', merchant: 'XYZ SDN BHD' })
    expect(validate(SCHEMA, r)).toEqual([])
    expect(r.classification).toMatchObject({ document_type: 'sales_invoice', autocount_doc_type: 'IV', direction: 'sales' })
    expect(r.autocount_hint).toEqual({ entity: 'sales.invoice', party_role: 'debtor', party_name_as_printed: 'XYZ SDN BHD', needs_master_match: true, post_as: 'document' })
    expect(r.quality.needs_review_reasons).toContain('type_unverified')
  })

  test('没配置我方身份: 发票是 invoice(方向未定),开单方和对方照常给,不写入', async () => {
    const { receipt: r } = await scanOk(makeApp({ doc: modelDoc(INVOICE) }), 'i.jpg')
    expect(r.classification).toMatchObject({ document_type: 'invoice', autocount_doc_type: null, direction: 'unknown', type_verdict: 'direction_unknown' })
    expect(r.parties.issuer?.name_as_printed).toBe('ACME TRADING SDN BHD')
    expect(r.parties.counterparty?.name_as_printed).toBe('XYZ SDN BHD')
    expect(r.autocount_hint).toMatchObject({ entity: null, post_as: 'none', needs_master_match: false })
    expect(r.quality.verdict).toBe('REVIEW')
  })

  test('同一张图再传: 返回已有结果、不再调用模型;receipt 仍然完整', async () => {
    const c = makeApp()
    const bytes = await img()
    const first = (await (await scan(c, 'a.jpg', bytes)).json()) as { scan: PublicScanV2 }
    const n = calls(c)
    const again = (await (await scan(c, 'a-copy.jpg', bytes)).json()) as { scan: PublicScanV2; receipt: PublicDocumentV2 }
    expect(again.scan).toMatchObject({ duplicate: true, id: first.scan.id, document_type: 'receipt' })
    expect(again.receipt.id).toBe(first.scan.id!)
    expect(validate(SCHEMA, again.receipt)).toEqual([])
    expect(calls(c)).toBe(n)
  })

  test('图片读不出内容(模型回的不是 JSON)不是错误: 200 + REVIEW,字段为空,留给人工', async () => {
    const c = makeApp({ doc: modelDoc() })
    c.setDoc({ not: 'a doc' } as never)
    const { scan: s, receipt: r } = await scanOk(c, 'blank.jpg')
    expect(s.status).toBe('REVIEW')
    expect(validate(SCHEMA, r)).toEqual([])
    expect(r.classification.document_type).toBe('other')
  })
})

describe('POST /v2/scan: hint_type(调用方已经知道类型)', () => {
  test('以调用方为准: 模型说收据,hint 是销售订单 → 销售订单,把握度 1,模型的判断留作候选,并有提示', async () => {
    const { receipt: r, scan: s } = await scanOk(makeApp(), 'h.jpg', '&hint_type=sales_order')
    expect(r.classification).toMatchObject({ document_type: 'sales_order', confidence: 1, direction: 'sales', autocount_doc_type: 'SO' })
    expect(r.classification.alternatives[0]).toMatchObject({ document_type: 'receipt', confidence: 0.93 })
    expect(s.reasons).toEqual(expect.arrayContaining(['type_hinted', 'type_hint_differs']))
    expect(validate(SCHEMA, r)).toEqual([])
  })

  test('和模型一致时只有 type_hinted,没有 differs', async () => {
    const { scan: s } = await scanOk(makeApp(), 'h.jpg', '&hint_type=receipt')
    expect(s.reasons).toContain('type_hinted')
    expect(s.reasons).not.toContain('type_hint_differs')
    expect(s.status).toBe('AUTO_VERIFIED') // 收据是可信类型,hint 一致,其他检查都过
  })

  test('hint 跳过的是模型的把握度 / 证据检查(那是模型推断的),其余检查照旧: 没验证过的类型仍然转人工', async () => {
    const lowConf = makeApp({ doc: modelDoc({ confidence: 0.4, evidence: ['nothing'] }) })
    expect((await scanOk(lowConf, 'l.jpg', '&hint_type=receipt')).scan.status).toBe('AUTO_VERIFIED') // 调用方说是收据就是收据
    expect((await scanOk(makeApp(), 'o.jpg', '&hint_type=sales_order')).scan.status).toBe('REVIEW') // 订单没验证过
  })

  test('hint 是 sales_invoice → 方向是销售;和我方身份判出来的方向矛盾 → 按 hint,但转人工并标 type_conflict', async () => {
    const plain = await scanOk(makeApp({ doc: modelDoc(INVOICE) }), 'a.jpg', '&hint_type=sales_invoice')
    expect(plain.receipt.classification).toMatchObject({ document_type: 'sales_invoice', direction: 'sales' })
    ourCompanyOpts.company = parseOurCompany({ OUR_COMPANY_NAMES: OUR })
    const conflict = await scanOk(makeApp({ doc: modelDoc({ ...INVOICE, issuer: party('ACME TRADING SDN BHD'), counterparty: party(OUR) }) }), 'b.jpg', '&hint_type=sales_invoice')
    expect(conflict.receipt.classification).toMatchObject({ document_type: 'sales_invoice', direction: 'sales', type_verdict: 'conflict' })
    expect(conflict.scan.reasons).toContain('type_conflict')
    expect(conflict.scan.status).toBe('REVIEW')
  })

  test('hint 不认识 → 422 TYPE_NOT_ENABLED(中英文提示),不调用模型', async () => {
    const c = makeApp()
    const r = await scan(c, 'h.jpg', await img(), '&hint_type=bank_slip')
    expect(r.status).toBe(422)
    const body = await err(r)
    expect(body.code).toBe('TYPE_NOT_ENABLED')
    expect(body.error).toContain('bank_slip')
    const en = await (await scan(c, 'h.jpg', await img(), '&hint_type=bank_slip', { ...auth, 'x-lang': 'en' })).json() as { error: string }
    expect(en.error).toContain('Unknown document type')
    expect(calls(c)).toBe(0)
  })

  test('空的 hint_type 当没传', async () => {
    expect((await scan(makeApp(), 'h.jpg', await img(), '&hint_type=')).status).toBe(200)
  })
})

describe('POST /v2/scan: 错误码', () => {
  test('扫描没开 → 503 SCAN_DISABLED', async () => {
    const r = await scan(makeApp({ scanOff: true }), 'a.jpg', await img())
    expect(r.status).toBe(503)
    expect((await err(r)).code).toBe('SCAN_DISABLED')
  })
  test('空请求体 / 不支持的扩展名 → 400;缺 file 参数 → 400 VALIDATION', async () => {
    const c = makeApp()
    expect((await err(await scan(c, 'a.jpg', new Uint8Array()))).code).toBe('IMAGE_EMPTY_OR_TOO_BIG')
    expect((await scan(c, 'a.jpg', new Uint8Array())).status).toBe(400)
    const pdf = await scan(c, 'a.pdf', await img())
    expect([pdf.status, (await err(pdf)).code]).toEqual([400, 'IMAGE_UNSUPPORTED'])
    const missing = await c.app.handle(new Request('http://localhost/v2/scan', { method: 'POST', headers: auth, body: await img() }))
    expect([missing.status, (await err(missing)).code]).toEqual([400, 'VALIDATION'])
  })
  test('Anthropic 限流 → 429;密钥错 / 上游故障 → 502,细节不透给调用方', async () => {
    const mk = (status: number, message: string, cls: new (s: any, e: any, m: any, h: any) => Error) => new cls(status, { type: 'error', error: { type: 'x', message } }, undefined, new Headers())
    const limited = await scan(makeApp({ fail: mk(429, 'slow down', Anthropic.RateLimitError) }), 'a.jpg', await img())
    expect([limited.status, (await err(limited)).code]).toEqual([429, 'SCAN_RATE_LIMIT'])
    const bad = await scan(makeApp({ fail: mk(401, 'invalid x-api-key sk-ant-SECRET123', Anthropic.AuthenticationError) }), 'a.jpg', await img())
    expect(bad.status).toBe(502)
    expect(JSON.stringify(await bad.json())).not.toContain('SECRET123')
  })
})

describe('GET /v2/receipts/{id}', () => {
  test('404 RECEIPT_NOT_FOUND;存在的通过 JSON Schema', async () => {
    const c = makeApp()
    const nf = await get(c, '/v2/receipts/999')
    expect([nf.status, (await err(nf)).code]).toEqual([404, 'RECEIPT_NOT_FOUND'])
    const { scan: s } = await scanOk(c, 'a.jpg')
    const r = (await (await get(c, `/v2/receipts/${s.id}`)).json()) as PublicDocumentV2
    expect(validate(SCHEMA, r)).toEqual([])
    expect(r.id).toBe(s.id!)
  })

  test('取到的是最新的值: 人工在门户里改过商家和总额并批准后,v2 里是改后的值,并列出改过的字段', async () => {
    const c = makeApp()
    const { scan: s } = await scanOk(c, 'a.jpg')
    // 门户内部的 /api/* 认 x-token 头(对外的 /v1 /v2 认 Authorization: Bearer)
    const portal = { 'x-token': TOKEN }
    const d = (await (await c.app.handle(new Request(`http://localhost/api/receipts/${s.id}`, { headers: portal }))).json()) as ReceiptDetail
    const rv = await c.app.handle(new Request(`http://localhost/api/receipts/${s.id}/review`, {
      method: 'POST', headers: { ...portal, 'x-portal': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', version: d.version, user: 'tester', final: { ...d.data, total: 11, merchant: 'ACME TRADING (FIXED)' } }),
    }))
    expect({ status: rv.status, body: rv.status === 200 ? 'ok' : await rv.text() }).toEqual({ status: 200, body: 'ok' })
    const r = (await (await get(c, `/v2/receipts/${s.id}`)).json()) as PublicDocumentV2
    expect(r.amounts.total).toBe(11)
    expect(r.review).toMatchObject({ state: 'approved', reviewed_by: 'tester' })
    expect(r.review.human_edited_fields).toEqual(expect.arrayContaining(['merchant', 'total']))
    expect(r.quality.needs_review).toBe(false)
    expect(validate(SCHEMA, r)).toEqual([])
  })
})

describe('GET /v2/receipts(列表与搜索)', () => {
  async function seeded() {
    ourCompanyOpts.company = parseOurCompany({ OUR_COMPANY_NAMES: OUR })
    const c = makeApp()
    const put = async (name: string, doc: Record<string, unknown>) => { c.setDoc(doc); await scanOk(c, name) }
    await put('receipt.jpg', modelDoc({ doc_date: '2018-10-17' }))
    await put('invoice.jpg', modelDoc({ ...INVOICE, issuer: party(OUR), doc_date: '2018-11-05', doc_no: 'IV-9001', title: 'XYZ SDN BHD invoice IV-9001' }))
    await put('do.jpg', modelDoc({ document_type: 'delivery_order', evidence: ['TAX INVOICE'], issuer: party(OUR), counterparty: party('XYZ SDN BHD'), doc_date: '2018-12-01', doc_no: 'DO-55', title: 'XYZ SDN BHD delivery DO-55' }))
    // 一张没分类过的旧数据(直接入库,没有 doc)
    ingest(c.db, c.dir, [{ file: 'legacy.jpg', status: 'AUTO', reasons: [], ocr_text: 'x', data: { merchant: 'OLD SHOP', date: '2017-01-01', currency: 'MYR', total: 5, items: [] } }], () => null, 'legacy')
    return c
  }
  const list = async (c: Ctx, q = '') => { const r = await get(c, `/v2/receipts${q}`); return { status: r.status, body: (await r.json()) as { items: PublicListItemV2[]; total: number; page: number; page_size: number } & { code?: string } } }
  const files = (b: { items: PublicListItemV2[] }) => b.items.map((i) => i.file)

  test('默认: 全部,最新的在前;每项的字段', async () => {
    const c = await seeded()
    const { status, body } = await list(c)
    expect(status).toBe(200)
    expect(body).toMatchObject({ total: 4, page: 1, page_size: 20 })
    expect(files(body)).toEqual(['legacy.jpg', 'do.jpg', 'invoice.jpg', 'receipt.jpg'])
    const inv = body.items.find((i) => i.file === 'invoice.jpg')!
    expect(inv).toMatchObject({ document_type: 'sales_invoice', direction: 'sales', doc_no: 'IV-9001', party: 'XYZ SDN BHD', doc_date: '2018-11-05', currency: 'MYR', total: 10.6, verdict: 'REVIEW', needs_review: true, review_state: 'pending', title: 'XYZ SDN BHD invoice IV-9001' })
    expect(typeof inv.imported_at).toBe('string')
    expect(body.items.find((i) => i.file === 'legacy.jpg')).toMatchObject({ document_type: null, direction: 'unknown', title: null, party: 'OLD SHOP' })
  })

  test('按类型、方向、none、关键词、日期筛选,可以组合', async () => {
    const c = await seeded()
    expect(files((await list(c, '?type=sales_invoice')).body)).toEqual(['invoice.jpg'])
    expect(files((await list(c, '?type=none')).body)).toEqual(['legacy.jpg'])
    expect(files((await list(c, '?direction=sales')).body)).toEqual(['do.jpg', 'invoice.jpg'])
    expect(files((await list(c, '?direction=purchase')).body)).toEqual(['receipt.jpg'])
    expect(files((await list(c, '?type=delivery_order&direction=sales')).body)).toEqual(['do.jpg'])
    expect(files((await list(c, '?q=IV-9001')).body)).toEqual(['invoice.jpg']) // 单据号
    expect(files((await list(c, '?q=delivery')).body)).toEqual(['do.jpg']) // 标题
    expect(files((await list(c, '?from=2018-11-01&to=2018-11-30')).body)).toEqual(['invoice.jpg'])
    expect(files((await list(c, '?state=approved')).body)).toEqual([])
    expect(files((await list(c, '?state=pending&type=receipt')).body)).toEqual(['receipt.jpg'])
  })

  test('分页: page / page_size,上限 100;total 是筛选后的总数', async () => {
    const c = await seeded()
    const p1 = (await list(c, '?page_size=2&page=1')).body
    const p2 = (await list(c, '?page_size=2&page=2')).body
    expect([p1.total, p1.page, p1.page_size, files(p1)]).toEqual([4, 1, 2, ['legacy.jpg', 'do.jpg']])
    expect([p2.page, files(p2)]).toEqual([2, ['invoice.jpg', 'receipt.jpg']])
    expect((await list(c, '?page_size=100000')).body.page_size).toBe(100)
    expect((await list(c, '?page_size=0')).body.page_size).toBe(1)
    expect((await list(c, '?page=0')).body.page).toBe(1)
  })

  test('不认识的类型 → 422;不合法的方向 / 状态 / 日期 → 400 VALIDATION(不会悄悄返回全部数据)', async () => {
    const c = await seeded()
    const t = await list(c, '?type=bogus')
    expect([t.status, t.body.code]).toEqual([422, 'TYPE_NOT_ENABLED'])
    for (const q of ['?direction=sideways', '?state=maybe', '?from=17/10/2018', '?to=2018-13']) {
      const r = await list(c, q)
      expect({ q, s: r.status, code: r.body.code }).toEqual({ q, s: 400, code: 'VALIDATION' })
    }
  })
})

describe('/v1 不受影响', () => {
  test('/v1/receipts/{id} 仍是 v1 结构(没有 classification),/v1/scan 照旧返回 v1 的 receipt', async () => {
    const c = makeApp()
    const v1scan = (await (await c.app.handle(new Request('http://localhost/v1/scan?file=a.jpg', { method: 'POST', headers: auth, body: await img() }))).json()) as { scan: PublicScanV2; receipt: Record<string, unknown> }
    expect(v1scan.receipt.schema_version).toBe('1.0')
    expect(v1scan.receipt).not.toHaveProperty('classification')
    expect(v1scan.receipt).not.toHaveProperty('title')
    expect(v1scan.receipt).toHaveProperty('merchant')
    const r = (await (await get(c, `/v1/receipts/${v1scan.scan.id}`)).json()) as Record<string, unknown>
    expect(r.schema_version).toBe('1.0')
    expect(Object.keys(r).sort()).toEqual(['amounts', 'document', 'file', 'id', 'line_items', 'merchant', 'quality', 'reconciliation', 'review', 'schema_version', 'taxes', 'untrusted_text_fields', 'warnings'])
  })
})
