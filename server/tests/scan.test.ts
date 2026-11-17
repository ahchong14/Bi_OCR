import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import samples from './fixtures/ocrspace-samples.json'
import { createApp } from '../app'
import { openDb } from '../db'
import { extractFromText, findDate, fixSpacedDecimals, merchantLooksNoisy, regexPayment, regexTotal } from '../lib/extract'
import { OcrError, ocrSpaceProvider, prepareImage, recognizeWithRetry, type OcrProvider } from '../lib/ocr'
import type { ReceiptDetail, ScanInfo, ScanOutcome } from '../../shared/types'

type Sample = { file: string; text: string; trueTotal: number | null }
const S = samples as Sample[]
const byFile = (f: string) => S.find((s) => s.file === f)!

describe('字段提取: 用真实 OCR 文字验证(总额是我对照原图核实过的)', () => {
  test('核实过的 4 张,总额都对', () => {
    for (const s of S.filter((x) => x.trueTotal !== null)) expect(extractFromText(s.text).data.total, s.file).toBe(s.trueTotal!)
  })
  test('小数点后带空格(39. 90)和 Amt Due 都能读', () => {
    expect(fixSpacedDecimals('Total 39. 90')).toBe('Total 39.90')
    expect(fixSpacedDecimals('Rate 6. 0 %')).toBe('Rate 6. 0 %') // 只合并「恰好两位小数」
    expect(regexTotal('Total After Rounding\t39. 90')).toBe(39.9)
    expect(regexTotal('Sub Total\t129.30\nAmt Due\t129.30')).toBe(129.3)
    expect(regexPayment('CASH 50.00\nCHANGE 19.70')).toEqual({ paid: 50, change: 19.7 })
  })
  test('Nando\'s: 商家名把单独一行的 Sdn Bhd 并回上一行,税额取 6% 那行不取汇总表', () => {
    const d = extractFromText(byFile('X51005444037.jpg').text).data
    expect(d.merchant).toBe("Nando's Chickenland Malaysia Sdn Bhd")
    expect(d.tax).toBe(7.3)
    expect(d.date).toBe('2018-03-28')
    expect(d.currency).toBe('MYR')
  })
  test('含税合计行(Total Sales Incl. GST 39.90)不会被当成税额', () => {
    const d = extractFromText(byFile('X51006311764.jpg').text).data
    expect(d.tax).toBeNull()
    expect(d.total).toBe(39.9)
  })
  test('分流: 算术能互相印证且字段齐全 → AUTO_VERIFIED;OCR 读乱的商家名、日期有歧义 → 一律 REVIEW', () => {
    expect(extractFromText(byFile('X51006311764.jpg').text).status).toBe('AUTO_VERIFIED')
    expect(extractFromText(byFile('X51005444037.jpg').text).status).toBe('AUTO_VERIFIED')
    const noisy = extractFromText(byFile('X51005663276.jpg').text) // 商家读成 FRwOnL
    expect(noisy.status).toBe('REVIEW')
    expect(noisy.reasons).toContain('merchant_unsure')
    const amb = extractFromText(byFile('X51006557195.jpg').text) // 12/10/2017 日月有歧义,但这是马来西亚(日在前)的票: 只是提示,不拦
    expect(amb.reasons).toContain('date_day_first_assumed')
    expect(amb.reasons).not.toContain('date_day_month_swapped')
    // 币种未知 / 月在前的地区(美元): 歧义仍然交给人工
    const us = extractFromText(byFile('X51006557195.jpg').text.replace(/RM|MYR/gi, 'USD$').replace(/SDN\.?\s*BHD|GST|MALAYSIA|SELANGOR|KUALA LUMPUR/gi, 'INC'))
    expect(us.status).toBe('REVIEW')
    expect(us.reasons).toContain('date_day_month_swapped')
    expect(extractFromText(byFile('X51005453804.jpg').text).reasons).toContain('missing_date')
  })
  test('没有任何 AUTO(只有一个识别来源,不给最高档)', () => {
    for (const s of S) expect(extractFromText(s.text).status).not.toBe('AUTO')
  })
  test('日期: 日/月歧义按日在前并标记;第二位>12 只能是月/日', () => {
    expect(findDate('Date 12/10/2017')).toEqual({ iso: '2017-10-12', ambiguous: true })
    expect(findDate('Date 02/14/2018')).toEqual({ iso: '2018-02-14', ambiguous: false })
    expect(findDate('28 Mar 18 18:32')).toEqual({ iso: '2018-03-28', ambiguous: false })
    expect(findDate('no date here 12345')).toBeNull()
  })
  test('商家名读乱的特征', () => {
    for (const bad of ['FRwOnL', 'VAL SDN IBHC', 'ANN GIAP TRADING SDN BHD T33L']) expect(merchantLooksNoisy(bad), bad).toBe(true)
    for (const good of ['GARDENIA BAKERIES (KL) SDN BHD', "Nando's Chickenland Malaysia Sdn Bhd", 'KEDAI PAPAN YEW CHUAN']) expect(merchantLooksNoisy(good), good).toBe(false)
  })
  test('空文字不报错', () => {
    const e = extractFromText('')
    expect(e.status).toBe('REVIEW')
    expect(e.reasons).toContain('missing_total')
  })
})

describe('识别服务接入', () => {
  test('图片超过上限会缩小到上限以内;够小的原样发送', async () => {
    const w = 2400, h = 2400
    const noise = Buffer.alloc(w * h * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24 // 伪随机噪声,压缩不掉
    const big = new Uint8Array(await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer())
    expect(big.length).toBeGreaterThan(1024 * 1024)
    const out = await prepareImage(big, 1024 * 1024)
    expect(out.length).toBeLessThanOrEqual(1024 * 1024)
    const meta = await sharp(Buffer.from(out)).metadata()
    expect(meta.format).toBe('jpeg')
    const small = new Uint8Array([1, 2, 3])
    expect(await prepareImage(small, 1024 * 1024)).toBe(small)
  }, 60000)

  const okBody = { OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: 'TOTAL 9.00' }] }
  const mk = (res: () => Response | Promise<Response>) => ocrSpaceProvider({ apiKey: 'k', fetchImpl: (async () => res()) as unknown as typeof fetch })
  const code = async (p: OcrProvider) => { try { await p.recognize(new Uint8Array([1]), 'a.jpg'); return 'ok' } catch (e) { return (e as OcrError).code } }

  test('OCR.space 响应映射成明确的错误类型', async () => {
    expect(await mk(() => Response.json(okBody)).recognize(new Uint8Array([1]), 'a.jpg')).toMatchObject({ text: 'TOTAL 9.00', provider: 'ocr.space' })
    expect(await code(mk(() => new Response('x', { status: 429 })))).toBe('RATE_LIMIT')
    expect(await code(mk(() => new Response('x', { status: 503 })))).toBe('UPSTREAM')
    expect(await code(mk(() => Response.json({ OCRExitCode: 3, IsErroredOnProcessing: true, ErrorMessage: ['You have exceeded the daily limit'] })))).toBe('RATE_LIMIT')
    expect(await code(mk(() => Response.json({ OCRExitCode: 3, IsErroredOnProcessing: true, ErrorMessage: 'Invalid API key' })))).toBe('AUTH')
    expect(await code(mk(() => Response.json({ OCRExitCode: 1, ParsedResults: [{ ParsedText: '  ' }] })))).toBe('NO_TEXT')
    expect(await code(mk(() => { throw new TypeError('fetch failed') }))).toBe('NETWORK')
  })

  test('临时错误自动重试,限流不重试', async () => {
    let n = 0
    const flaky: OcrProvider = { name: 'x', maxBytes: 1e6, recognize: async () => { if (++n < 3) throw new OcrError('UPSTREAM', 'boom', true); return { text: 'ok', ms: 1, provider: 'x' } } }
    expect((await recognizeWithRetry(flaky, new Uint8Array([1]), 'a.jpg', 3, async () => {})).text).toBe('ok')
    expect(n).toBe(3)
    let m = 0
    const limited: OcrProvider = { name: 'x', maxBytes: 1e6, recognize: async () => { m++; throw new OcrError('RATE_LIMIT', 'limit', false) } }
    await expect(recognizeWithRetry(limited, new Uint8Array([1]), 'a.jpg', 3, async () => {})).rejects.toThrow('limit')
    expect(m).toBe(1)
  })
})

describe('/api/scan: 上传 → 识别 → 提取 → 进入待审核', () => {
  const makeApp = (provider: OcrProvider | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-scan-'))
    return createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x'), ocr: provider, ocrSharedKey: true })
  }
  const img = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, n, 1, 2, 3, 4]) // 内容不同的假 JPEG 头(小图不会被解码)
  const scan = (app: ReturnType<typeof makeApp>, file: string, bytes: Uint8Array) =>
    app.handle(new Request(`http://localhost/api/scan?file=${encodeURIComponent(file)}`, { method: 'POST', headers: { 'x-portal': '1', 'x-lang': 'en' }, body: bytes }))
  const provider = (text: string, calls = { n: 0 }): OcrProvider => ({ name: 'mock', maxBytes: 1e6, recognize: async () => { calls.n++; return { text, ms: 5, provider: 'mock' } } })

  test('扫描成功: 入库、带提取的字段、状态和原因,打开详情能看到', async () => {
    const app = makeApp(provider(byFile('X51006311764.jpg').text))
    const r = await scan(app, 'tony.jpg', img(1))
    expect(r.status).toBe(200)
    const out = (await r.json()) as ScanOutcome
    expect(out).toMatchObject({ file: 'tony.jpg', duplicate: false, status: 'AUTO_VERIFIED' })
    const d = (await (await app.handle(new Request(`http://localhost/api/receipts/${out.id}`))).json()) as ReceiptDetail
    expect(d.data).toMatchObject({ total: 39.9, date: '2018-03-29', currency: 'MYR' })
    expect(d.reasons).toContain('scanned_in_portal')
    expect(d.hasImage).toBe(true)
    expect(d.state).toBe('pending')
  })

  test('同一张图再扫一次: 不再调用识别服务(省免费额度)', async () => {
    const calls = { n: 0 }
    const app = makeApp(provider('TOTAL 5.00\nDate 01/02/2018', calls))
    await scan(app, 'a.jpg', img(2))
    const again = (await (await scan(app, 'a-copy.jpg', img(2))).json()) as ScanOutcome
    expect(again.duplicate).toBe(true)
    expect(calls.n).toBe(1)
  })

  test('识别服务限流 → 429 和清楚的提示,图片没入库;网络错误 → 502', async () => {
    const limited = makeApp({ name: 'm', maxBytes: 1e6, recognize: async () => { throw new OcrError('RATE_LIMIT', 'x', false) } })
    const r = await scan(limited, 'a.jpg', img(3))
    expect(r.status).toBe(429)
    expect(((await r.json()) as { code: string; error: string }).code).toBe('SCAN_RATE_LIMIT')
    expect(((await (await limited.handle(new Request('http://localhost/api/stats'))).json()) as { pending: number }).pending).toBe(0)
    const down = makeApp({ name: 'm', maxBytes: 1e6, recognize: async () => { throw new OcrError('NETWORK', 'x', false) } })
    expect((await scan(down, 'a.jpg', img(4))).status).toBe(502)
  })

  test('识别不出文字: 照样入库(留空待手填),图片不丢', async () => {
    const app = makeApp({ name: 'm', maxBytes: 1e6, recognize: async () => { throw new OcrError('NO_TEXT', 'x', false) } })
    const out = (await (await scan(app, 'blank.jpg', img(5))).json()) as ScanOutcome
    expect(out.status).toBe('REVIEW')
    expect(out.reasons).toContain('extract_failed')
    expect(out.id).not.toBeNull()
  })

  test('卡号在入库前被遮盖', async () => {
    const app = makeApp(provider('SHOP SDN BHD\nTOTAL 5.00\nVISA 4111 1111 1111 1111'))
    const out = (await (await scan(app, 'card.jpg', img(6))).json()) as ScanOutcome
    const d = (await (await app.handle(new Request(`http://localhost/api/receipts/${out.id}`))).json()) as ReceiptDetail
    expect(d.ocrText).not.toContain('4111')
    expect(d.reasons).toContain('card_number_masked')
  })

  test('关闭扫描: 503;不支持的文件类型: 400;信息接口说明是否开启', async () => {
    const off = makeApp(null)
    expect((await scan(off, 'a.jpg', img(7))).status).toBe(503)
    expect(((await (await off.handle(new Request('http://localhost/api/scan/info'))).json()) as ScanInfo).enabled).toBe(false)
    const on = makeApp(provider('TOTAL 1.00'))
    expect((await scan(on, 'a.heic', img(8))).status).toBe(400)
    expect(((await (await on.handle(new Request('http://localhost/api/scan/info'))).json()) as ScanInfo)).toMatchObject({ enabled: true, provider: 'mock', sharedTestKey: true })
  })

  test('批量扫描时同时在识别的不超过 2 张', async () => {
    let active = 0, peak = 0
    const slow: OcrProvider = { name: 'm', maxBytes: 1e6, recognize: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { text: 'TOTAL 1.00', ms: 30, provider: 'm' } } }
    const app = makeApp(slow)
    await Promise.all(Array.from({ length: 8 }, (_, i) => scan(app, `f${i}.jpg`, img(20 + i))))
    expect(peak).toBeLessThanOrEqual(2)
    expect(((await (await app.handle(new Request('http://localhost/api/stats'))).json()) as { pending: number }).pending).toBe(8)
  })
})
