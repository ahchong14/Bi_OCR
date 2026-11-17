import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { getDetail } from '../lib/receipts'
import type { OcrProvider, StructuredOutput } from '../lib/ocr'
import { scanImage } from '../lib/scan'
import { askQwen, buildAggMessages, compareCandidates, decideUpgrade, enqueueSecond, initSecond, parseAgg, secondOpinion, secondOpts } from '../lib/second'
import { fromStructured } from '../lib/structured'

const lines = (...l: string[]) => l.join('\n')
const TEXT = lines('KEDAI RUNCIT MAJU SDN BHD', '15/08/2025', 'SUBTOTAL 27.00', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00')
const FIELDS = { merchant_name: 'KEDAI RUNCIT MAJU SDN BHD', date: '15/08/2025', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '30.00', change_given: '3.00' }
// answers 里放真实的字段 JSON: 队列任务是从入库的原始文字重建第一轮读数的
const out = (over: Record<string, unknown> = {}, text = TEXT, provider = 'minicpm-ocr'): StructuredOutput => ({ fields: { ...FIELDS, ...over }, items: [], text, failed: [], answers: [{ name: 'core', raw: JSON.stringify({ ...FIELDS, ...over }) }], ms: 1, provider })
// 1x1 PNG(改一个字节就是另一张图)
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const png = (n: number) => { const b = PNG.slice(); b[b.length - 20] = n; return b }

describe('第二意见: 纯逻辑', () => {
  test('逐字段比较: 一致 / 不一致 / 两边都没有的跳过', () => {
    const c = compareCandidates({ merchant: 'A SDN BHD', total: 10, tax: null, date: '2018-01-01' }, { merchant: 'a sdn bhd', total: 10.004, tax: null, date: '2018-02-01' })
    expect(c.agree).toEqual({ merchant: true, total: true, date: false })
    expect(c.disputed).toEqual(['date'])
  })
  test('只把不一致的字段发给聚合员', () => {
    const { messages, diff } = buildAggMessages('Total Payable 33.05', { total: 25.44, merchant: 'X' }, { total: 33.05, merchant: 'X' }, ['total_conflicts_with_text_rule'])
    expect(diff).toEqual(['total'])
    expect(JSON.parse(messages[1]!.content)).toMatchObject({ fields_to_decide: ['total'], A: { total: 25.44 }, B: { total: 33.05 }, rule_flags: ['total_conflicts_with_text_rule'] })
  })
  test('聚合员选的值必须在转写里找得到,否则降级成「都不是」', () => {
    const T = 'SHOP SDN BHD\nTotal 6% supplies: 25.44\nTotal Payable: 33.05'
    const ok = parseAgg('{"fields":[{"field":"total","pick":"B","value":33.05,"evidence":"Total Payable: 33.05"},{"field":"merchant","pick":"A","value":"Shop Sdn Bhd","evidence":"SHOP SDN BHD"}]}', T)
    expect(ok.total).toMatchObject({ pick: 'B', value: 33.05 })
    expect(ok.merchant!.pick).toBe('A')
    const bad = parseAgg('{"fields":[{"field":"total","pick":"A","value":99.99,"evidence":"made up"},{"field":"merchant","pick":"B","value":"Other Co","evidence":"x"}]}', T)
    expect(bad.total).toEqual({ pick: 'neither', value: null, evidence: 'made up' })
    expect(bad.merchant!.pick).toBe('neither')
  })
  test('容忍围栏、前后废话、坏 JSON、未知字段', () => {
    expect(parseAgg('not json', 't')).toEqual({})
    expect(parseAgg('x {"fields":[{"field":"total","pick":"B","value":"33.05","evidence":"e"}]} y', 'Total 33.05').total!.pick).toBe('B')
    expect(parseAgg('{"fields":[{"field":"nonsense","pick":"A","value":1,"evidence":""},{"field":"total","pick":"C","value":1,"evidence":""}]}', '1.00')).toEqual({})
  })
  test('Qwen 调用: 带密钥、要求 JSON schema;非 200 / 网络错误一律返回 null', async () => {
    let seen: { url: string; auth: string | null; body: any } | null = null
    const ok = (async (url: string, init: RequestInit) => { seen = { url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"fields":[]}' } }] })) }) as unknown as typeof fetch
    expect(await askQwen({ baseUrl: 'https://x.example/qwen/', apiKey: 'k', fetchImpl: ok }, [{ role: 'user', content: 'hi' }])).toBe('{"fields":[]}')
    expect(seen!.url).toBe('https://x.example/qwen/v1/chat/completions')
    expect(seen!.auth).toBe('Bearer k')
    expect(seen!.body.response_format.type).toBe('json_schema')
    expect(await askQwen({ baseUrl: 'https://x', fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch }, [])).toBeNull()
    expect(await askQwen({ baseUrl: 'https://x', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch }, [])).toBeNull()
  })
})

// 第一轮把商家读成了品牌名(转写开头是带 SDN BHD 的公司名)→ 需检查;第二个模型读对了
const first = () => out({ merchant_name: 'ZZ BRAND' })
// 真实的第二个模型的答案段叫 second_core(见 minicpm.ts readSecond)
const second = (): StructuredOutput => { const o = out({}, TEXT, 'glm-ocr'); o.answers = [{ name: 'second_core', raw: o.answers![0]!.raw }]; return o }
const qwenSays = (pick: 'A' | 'B' | 'neither', value: string | null) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fields: [{ field: 'merchant', pick, value, evidence: 'KEDAI RUNCIT MAJU SDN BHD' }] }) } }] }))) as unknown as typeof fetch
const provider = (o1: StructuredOutput, o2: StructuredOutput | null, scores = { a: 0.4, b: 0.9 }): OcrProvider => ({
  name: 'fake', maxBytes: 1e7, local: true, concurrency: 1,
  async recognize() { return { text: '', ms: 0, provider: 'fake' } },
  async extract() { return structuredClone(o1) },
  async readSecond() { return o2 ? structuredClone(o2) : null },
  async verify(_img, t) { return { score: t === o1.text && o2 && o1.text !== o2.text ? scores.a : scores.b, verdict: 'scored' } },
})

describe('第二意见: 整条流程(不碰数据库)', () => {
  test('两个模型不一致 → 比较、Jev 打分、Qwen 仲裁、重新校验后判断「可以升级」', async () => {
    const f = fromStructured(first())
    expect(f.status).not.toBe('AUTO_VERIFIED')
    const { result } = await secondOpinion({ provider: provider(first(), second()) }, png(1), first(), f, { baseUrl: 'https://q', fetchImpl: qwenSays('B', 'KEDAI RUNCIT MAJU SDN BHD') })
    expect(result.disputed).toEqual(['merchant'])
    expect(result.qwen!.merchant).toMatchObject({ pick: 'B', value: 'KEDAI RUNCIT MAJU SDN BHD' })
    expect(result.jev).toEqual({ first: 0.9, second: 0.9 })
    expect(result.decision).toEqual({ upgrade: true, why: 'resolved_and_revalidated', fields: ['merchant'] })
  })
  test('Qwen 选了一个转写里没有的名字 → 降级,不升级', async () => {
    const { result } = await secondOpinion({ provider: provider(first(), second()) }, png(1), first(), fromStructured(first()), { baseUrl: 'https://q', fetchImpl: qwenSays('B', 'NOT ON THE RECEIPT SDN BHD') })
    expect(result.qwen!.merchant!.pick).toBe('neither')
    expect(result.decision).toMatchObject({ upgrade: false, why: 'unresolved:merchant' })
  })
  test('没有配 Qwen → 只有比较,有争议就不升级(留给人工)', async () => {
    const { result } = await secondOpinion({ provider: provider(first(), second()) }, png(1), first(), fromStructured(first()), null)
    expect(result.qwen).toBeNull()
    expect(result.decision.upgrade).toBe(false)
  })
  test('第二个读取模型读不出来 → 结果里 model2 为 null,不抛错', async () => {
    const { result, out2 } = await secondOpinion({ provider: provider(first(), null) }, png(1), first(), fromStructured(first()))
    expect(out2).toBeNull()
    expect(result.model2).toBeNull()
    expect(result.decision.why).toBe('no_second_reading')
  })
  test('第一轮已经基本可信 → 不升级', () => {
    const ok = out()
    expect(decideUpgrade(fromStructured(structuredClone(ok)), ok, out(), { disputed: [], qwen: null })).toMatchObject({ upgrade: false, why: 'already_trusted' })
  })
})

describe('第二意见: 队列与影子模式(走真实的扫描入库)', () => {
  afterEach(() => { secondOpts.mode = 'off'; secondOpts.upgrade = false; secondOpts.qwen = null; secondOpts.demoteOn = [] })
  const setup = (p: OcrProvider) => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-second-'))
    const db = openDb(dir)
    initSecond(db, dir, p as never)
    return { dir, db }
  }
  const waitDone = async (db: ReturnType<typeof openDb>, id: number) => {
    for (let i = 0; i < 200; i++) {
      const s = db.query<{ second_state: string | null }, [number]>('SELECT second_state FROM receipts WHERE id = ?').get(id)?.second_state
      if (s === 'done' || s === 'failed') return s
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('second opinion did not finish')
  }

  test('影子模式: 第二意见只存储和显示,不改字段和状态;原因代码和「模型 2」原始回答都写进去', async () => {
    secondOpts.mode = 'flagged'
    secondOpts.qwen = { baseUrl: 'https://q', fetchImpl: qwenSays('B', 'KEDAI RUNCIT MAJU SDN BHD') }
    const p = provider(first(), second())
    const { dir, db } = setup(p)
    const o = await scanImage(db, dir, p, png(11), 'a.png')
    expect(o.status).not.toBe('AUTO_VERIFIED')
    expect(await waitDone(db, o.id!)).toBe('done')
    const d = getDetail(db, o.id!)
    expect(d.second!.disputed).toEqual(['merchant'])
    expect(d.second!.decision.upgrade).toBe(true)      // 如果打开升级会升级…
    expect(d.second!.applied).toBe(false)               // …但影子模式没有执行
    expect(d.data.merchant).toBe('ZZ BRAND')            // 字段没有被改
    expect(d.pipelineStatus).toBe(o.status!)             // 状态没有被改
    expect(d.reasons).toContain('second_disagrees:merchant')
    expect(d.secondState).toBe('done')
    expect(d.ocrText).toContain('[second core fields]')
    expect(d.audit.some((a) => a.action === 'second_opinion')).toBe(true)
  })

  test('SECOND_UPGRADE=1 且判断可以升级: 写入采纳后的值,状态变基本可信,更正记录和原因代码留痕', async () => {
    secondOpts.mode = 'flagged'; secondOpts.upgrade = true
    secondOpts.qwen = { baseUrl: 'https://q', fetchImpl: qwenSays('B', 'KEDAI RUNCIT MAJU SDN BHD') }
    const p = provider(first(), second())
    const { dir, db } = setup(p)
    const o = await scanImage(db, dir, p, png(12), 'b.png')
    await waitDone(db, o.id!)
    const d = getDetail(db, o.id!)
    expect(d.second!.applied).toBe(true)
    expect(d.data.merchant).toBe('KEDAI RUNCIT MAJU SDN BHD')
    expect(d.pipelineStatus).toBe('AUTO_VERIFIED')
    expect(d.reasons).toContain('second_resolved:merchant')
    expect(d.corrections.some((c) => c.field === 'merchant' && c.old === 'ZZ BRAND')).toBe(true)
  })

  test('第一轮已经基本可信的收据,flagged 模式不入队;all 模式才入队', async () => {
    secondOpts.mode = 'flagged'
    const p = provider(out(), second())
    const { dir, db } = setup(p)
    const o = await scanImage(db, dir, p, png(13), 'c.png')
    expect(o.status).toBe('AUTO_VERIFIED')
    expect(db.query<{ second_state: string | null }, [number]>('SELECT second_state FROM receipts WHERE id = ?').get(o.id!)!.second_state).toBeNull()
    secondOpts.mode = 'all'
    const p2 = provider(out(), second())
    const { dir: d2, db: db2 } = setup(p2)
    const o2 = await scanImage(db2, d2, p2, png(14), 'd.png')
    expect(await waitDone(db2, o2.id!)).toBe('done')
  })

  test('SECOND_DEMOTE=merchant: 「基本可信」的收据,两个读者的商家读得不一样 → 降成需检查;不在清单里的字段不降;关着不降', async () => {
    // 第一轮商家读成 ZZ BRAND 但字段齐全、算术对得上 → 基本可信;第二个读取模型读成公司名 → 商家分歧
    const trusted = out({ merchant_name: 'ZZ BRAND SDN BHD' })
    const mk = (o: StructuredOutput) => provider(o, second())
    secondOpts.mode = 'all'
    // 1) 关着: 不降
    let p = mk(trusted); let { dir, db } = setup(p)
    let o = await scanImage(db, dir, p, png(31), 'd1.png')
    expect(o.status).toBe('AUTO_VERIFIED')
    await waitDone(db, o.id!)
    expect(getDetail(db, o.id!).pipelineStatus).toBe('AUTO_VERIFIED')
    // 2) 打开: 降级
    secondOpts.demoteOn = ['merchant']
    p = mk(trusted); ({ dir, db } = setup(p))
    o = await scanImage(db, dir, p, png(32), 'd2.png')
    await waitDone(db, o.id!)
    const d = getDetail(db, o.id!)
    expect(d.second!.disputed).toContain('merchant')
    expect(d.pipelineStatus).toBe('REVIEW')
    expect(d.audit.some((a) => JSON.stringify(a.detail).includes('demoted'))).toBe(true)
    // 3) 清单里没有 merchant: 不降
    secondOpts.demoteOn = ['total']
    p = mk(trusted); ({ dir, db } = setup(p))
    o = await scanImage(db, dir, p, png(33), 'd3.png')
    await waitDone(db, o.id!)
    expect(getDetail(db, o.id!).pipelineStatus).toBe('AUTO_VERIFIED')
  })
  test('第二个读取模型读不出来: 状态是 failed,这张收据照旧可用(不受影响)', async () => {
    secondOpts.mode = 'flagged'
    const p = provider(first(), null)
    const { dir, db } = setup(p)
    const o = await scanImage(db, dir, p, png(15), 'e.png')
    expect(await waitDone(db, o.id!)).toBe('failed')
    const d = getDetail(db, o.id!)
    expect(d.data.merchant).toBe('ZZ BRAND')
    expect(d.pipelineStatus).toBe(o.status!)
  })

  test('重启后: 上次没做完的(排队中 / 进行中)自动重新入队;手动再请求第二意见也可以', async () => {
    secondOpts.mode = 'flagged'
    const p = provider(first(), second())
    const { dir, db } = setup(p)
    const o = await scanImage(db, dir, p, png(16), 'f.png')
    await waitDone(db, o.id!)
    db.query("UPDATE receipts SET second_state = 'running' WHERE id = ?").run(o.id!) // 模拟中途重启
    expect(initSecond(db, dir, p as never)).toBe(1)
    expect(await waitDone(db, o.id!)).toBe('done')
    expect(enqueueSecond(o.id!)).toBe(true)
    expect(await waitDone(db, o.id!)).toBe('done')
  })
})

describe('第二个读取模型 = PaddleOCR-VL(只转写,字段由文字规则抽)', () => {
  test('readSecond: 一次 "OCR:" 转写 → 规则抽字段;带 kind=paddle 时扫描时不做内联第二次读取', async () => {
    const { miniCpmProvider } = await import('../lib/minicpm')
    const prompts: string[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      prompts.push(body.messages[0].content.find((c: { type: string }) => c.type === 'text').text)
      const asked = prompts[prompts.length - 1]!
      return new Response(JSON.stringify({ choices: [{ message: { content: asked === 'OCR:' || asked.startsWith('Text') ? TEXT : JSON.stringify(FIELDS) } }] }))
    }) as unknown as typeof fetch
    const p = miniCpmProvider({ baseUrl: 'https://m1.example', fetchImpl: fake, second: { baseUrl: 'https://m2.example/m2', kind: 'paddle', mode: 'all' } })
    const o = await p.readSecond!(png(21))
    expect(prompts).toEqual(['OCR:'])                       // 固定提示词,只问一次
    expect(o!.provider).toBe('paddleocr-vl')
    expect(o!.text).toBe(TEXT)
    expect(o!.fields).toMatchObject({ total: '27.00', date: '2025-08-15', amount_paid: '30.00', change_given: '3.00' })
    expect(String(o!.fields.merchant_name)).toContain('KEDAI RUNCIT MAJU')
    prompts.length = 0
    await p.extract!(png(22), 'x.png')                       // mode=all 但 kind=paddle: 扫描时不会多发第二个模型的请求
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts).not.toContain('OCR:')                   // 没有向第二个模型发任何请求
  })
})
