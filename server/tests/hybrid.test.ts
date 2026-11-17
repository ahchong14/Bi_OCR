import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { dateInText, guardFields, hybridMerge, hybridOpts } from '../lib/hybrid'
import type { OcrProvider, StructuredOutput } from '../lib/ocr'
import { scanImage } from '../lib/scan'
import { secondOpts } from '../lib/second'

const TEXT = ['KEDAI RUNCIT MAJU SDN BHD', '15/08/2025', 'SUBTOTAL 27.00', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00'].join('\n')
const FIELDS = { merchant_name: 'KEDAI RUNCIT MAJU SDN BHD', date: '15/08/2025', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '30.00', change_given: '3.00' }
const native = (over: Record<string, unknown> = {}): StructuredOutput => ({ fields: { ...FIELDS, ...over }, items: [], text: TEXT, failed: [], answers: [{ name: 'core', raw: JSON.stringify({ ...FIELDS, ...over }) }], ms: 1, provider: 'minicpm-ocr' })
const qwenSays = (j: Record<string, unknown>) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(j) } }] }))) as unknown as typeof fetch
const Q = (j: Record<string, unknown>) => ({ baseUrl: 'https://q', fetchImpl: qwenSays(j) })
const base = { merchant_name: 'X', date: '2025-08-15', currency: 'RM', subtotal: 27, tax_amount: null, total: 27, discount_amount: null, service_charge_amount: null, rounding_adjustment: null, amount_paid: 30, change_given: 3, line_items: [] }

describe('混合读法: 出处检查', () => {
  test('日期必须在转写里有「日 月 年」;只有年份才补 20xx(日和月不补)', () => {
    expect(dateInText('2018-03-27', 'DATE 27-03-18 11:59')).toBe(true)
    expect(dateInText('2018-03-27', '27/03/2018')).toBe(true)
    expect(dateInText('2018-03-27', '2018/03/27')).toBe(true)
    expect(dateInText('2024-03-31', '27-03-18')).toBe(false)   // 编造的日期
    expect(dateInText('2018-03-27', 'no date here')).toBe(false)
  })
  test('金额必须能在转写里原样找到,找不到当作「没有」', () => {
    const f = guardFields({ ...base, total: 27, subtotal: 99.99, amount_paid: 30 }, TEXT)
    expect(f.total).toBe('27.00')
    expect(f.subtotal).toBe('###')       // 转写里没有 99.99
    expect(f.amount_paid).toBe('30.00')
  })
})

describe('混合读法: 合并', () => {
  test('商家 / 日期 / 总额沿用原生;明细字段取 Qwen 的(Qwen 说没有就是没有,不退回原生的抄值)', async () => {
    const o = native({ amount_paid: '27.00', change_given: '3.00', merchant_name: 'NATIVE NAME' })  // 原生把总额抄进了实付
    const r = await hybridMerge(o, Q({ ...base, merchant_name: 'QWEN NAME', amount_paid: null, change_given: null }))
    expect(r.used).toBe(true)
    expect(r.out.fields.merchant_name).toBe('NATIVE NAME')    // 商家不用 Qwen 的
    expect(r.out.fields.total).toBe('27.00')
    expect(r.out.fields.amount_paid).toBe('###')              // Qwen 说没有
    expect(r.out.fields.change_given).toBe('###')
    expect(r.out.answers!.some((a) => a.name === 'qwen_detail')).toBe(true)
    expect(r.disagree).toEqual([])
  })
  test('总额读得不一样(差一分钱)→ 标 disagree;日期不一样也是', async () => {
    // 真实案例: 票上 SUBTOTAL 4.51 / TOTAL 4.50,原生读成 4.51,Qwen 读对 4.50。没有付款行时流水线自己没法仲裁
    const tricky: StructuredOutput = { ...native({ total: '4.51', subtotal: '4.51', amount_paid: '###', change_given: '###' }), text: 'SHOP SDN BHD\n15/08/2025\nSUBTOTAL 4.51\nTOTAL 4.50' }
    const r1 = await hybridMerge(tricky, Q({ ...base, subtotal: 4.51, total: 4.5, amount_paid: null, change_given: null }))
    expect(r1.disagree).toEqual(['total'])
    const r2 = await hybridMerge(native({ date: '16/08/2025' }), Q({ ...base, date: '2025-08-15' }))
    expect(r2.disagree).toEqual(['date'])
  })
  test('Qwen 给的总额在转写里找不到 → 被丢掉,不算分歧(不能因为它瞎编就拦人工)', async () => {
    const r = await hybridMerge(native(), Q({ ...base, total: 55.55 }))
    expect(r.disagree).toEqual([])
  })
  test('没配 Qwen / 调用失败 / 返回乱码 → 原样返回原生读数', async () => {
    const o = native()
    expect((await hybridMerge(o, null)).used).toBe(false)
    expect((await hybridMerge(o, { baseUrl: 'https://q', fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch })).out).toBe(o)
    expect((await hybridMerge(o, { baseUrl: 'https://q', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })).used).toBe(false)
    expect((await hybridMerge(o, { baseUrl: 'https://q', fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }))) as unknown as typeof fetch })).used).toBe(false)
  })
})

describe('混合读法: 接进扫描', () => {
  afterEach(() => { hybridOpts.enabled = false; secondOpts.qwen = null; secondOpts.mode = 'off' })
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const png = (n: number) => { const b = PNG.slice(); b[b.length - 20] = n; return b }
  const prov = (o: StructuredOutput): OcrProvider => ({ name: 'fake', maxBytes: 1e7, local: true, concurrency: 1, async recognize() { return { text: '', ms: 0, provider: 'fake' } }, async extract() { return structuredClone(o) } })
  const run = async (o: StructuredOutput) => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-hybrid-'))
    return scanImage(openDb(dir), dir, prov(o), png(Math.floor(Math.random() * 250)), 'a.png')
  }

  test('关着(默认)= 和以前完全一样,不调 Qwen', async () => {
    let called = 0
    secondOpts.qwen = { baseUrl: 'https://q', fetchImpl: (async () => { called++; return new Response('{}') }) as unknown as typeof fetch }
    const o = await run(native())
    expect(called).toBe(0)
    expect(o.reasons).not.toContain('detail_from_qwen')
  })
  test('打开 + 两个读者一致 → 带 detail_from_qwen 提示,状态不受影响', async () => {
    hybridOpts.enabled = true; secondOpts.qwen = Q({ ...base })
    const baseline = await (async () => { hybridOpts.enabled = false; const r = await run(native()); hybridOpts.enabled = true; return r })()
    const o = await run(native())
    expect(o.reasons).toContain('detail_from_qwen')
    expect(o.reasons.some((r) => r.startsWith('reader_disagree'))).toBe(false)
    expect(o.status).toBe(baseline.status)
  })
  test('打开 + 总额不一致 → 原因 reader_disagree:total,不能自动放行', async () => {
    hybridOpts.enabled = true; secondOpts.qwen = Q({ ...base, total: 27 })
    const tricky: StructuredOutput = { ...native({ total: '4.51', subtotal: '4.51', amount_paid: '###', change_given: '###' }), text: 'SHOP SDN BHD\n15/08/2025\nSUBTOTAL 4.51\nTOTAL 4.50' }
    secondOpts.qwen = Q({ ...base, subtotal: 4.51, total: 4.5, amount_paid: null, change_given: null })
    const o = await run(tricky)
    expect(o.reasons).toContain('reader_disagree:total')
    expect(o.status).toBe('REVIEW')
  })
  test('打开但 Qwen 挂了 → 扫描照常完成,用原生读数', async () => {
    hybridOpts.enabled = true
    secondOpts.qwen = { baseUrl: 'https://q', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch }
    const o = await run(native())
    expect(o.id).not.toBeNull()
    expect(o.reasons).not.toContain('detail_from_qwen')
  })
})
