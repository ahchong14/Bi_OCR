import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createApp } from '../app'
import { openDb } from '../db'
import { cleanBoxes } from '../lib/importer'
import { ocrSpaceProvider, overlayToBoxes, type OcrProvider } from '../lib/ocr'
import type { ReceiptDetail } from '../../shared/types'

const overlay = { Lines: [{ Words: [
  { WordText: 'Total', Left: 100, Top: 50, Height: 20, Width: 50 },
  { WordText: '$7.60', Left: 400, Top: 50, Height: 20, Width: 80 },
  { WordText: 'outside', Left: 900, Top: 50, Height: 20, Width: 50 }, // 超出图片(宽 500)
  { WordText: '  ', Left: 1, Top: 1, Height: 5, Width: 5 }, // 空词
  { WordText: 'bad', Left: 'x', Top: 1, Height: 5, Width: 5 }, // 坐标不是数字
] }] }

describe('文字框: OCR.space 的像素坐标 → 占整张图的比例', () => {
  test('换算成 0..1,丢掉图外的、空的、坐标不对的框', () => {
    const b = overlayToBoxes(overlay, 500, 1000)
    expect(b).toEqual([
      { t: 'Total', x: 0.2, y: 0.05, w: 0.1, h: 0.02 },
      { t: '$7.60', x: 0.8, y: 0.05, w: 0.16, h: 0.02 },
    ])
  })
  test('没有位置信息 / 图片尺寸未知时是空数组,不会抛错', () => {
    expect(overlayToBoxes(undefined, 500, 1000)).toEqual([])
    expect(overlayToBoxes({ Lines: 'x' }, 500, 1000)).toEqual([])
    expect(overlayToBoxes(overlay, 0, 0)).toEqual([])
  })
  test('OCR.space 请求里要求返回位置,并把框带回来', async () => {
    const jpg = new Uint8Array(await sharp({ create: { width: 500, height: 1000, channels: 3, background: '#fff' } }).jpeg().toBuffer())
    let sent: FormData | null = null
    const p = ocrSpaceProvider({
      apiKey: 'k',
      fetchImpl: (async (_u: unknown, init: RequestInit) => { sent = init.body as FormData; return Response.json({ OCRExitCode: 1, ParsedResults: [{ ParsedText: 'Total $7.60', TextOverlay: overlay }] }) }) as unknown as typeof fetch,
    })
    const r = await p.recognize(jpg, 'a.jpg')
    expect(sent!.get('isOverlayRequired')).toBe('true')
    expect(r.boxes).toHaveLength(2)
    expect(r.boxes![1]).toMatchObject({ t: '$7.60', x: 0.8 })
  })
})

describe('文字框: 导入校验', () => {
  test('只收形状和范围合理的框', () => {
    expect(cleanBoxes([{ t: ' a ', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, { t: 'x', x: 2, y: 0, w: 0.1, h: 0.1 }, { t: '', x: 0, y: 0, w: 0.1, h: 0.1 }, null, 'z', { t: 'n', x: 0, y: 0, w: 0, h: 0.1 }])).toEqual([{ t: 'a', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }])
    expect(cleanBoxes(undefined)).toEqual([])
  })
})

describe('文字框: 扫描 → 入库 → 详情', () => {
  test('扫描出的框存进库,打开详情能拿到;卡号在框里也被掩码', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-boxes-'))
    const boxes = [{ t: '$7.60', x: 0.8, y: 0.05, w: 0.16, h: 0.02 }, { t: '4111111111111111', x: 0.1, y: 0.5, w: 0.3, h: 0.02 }]
    const provider: OcrProvider = { name: 'mock', maxBytes: 1e6, recognize: async () => ({ text: 'SHOP SDN BHD\nTOTAL 7.60', ms: 1, provider: 'mock', boxes }) }
    const app = createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x'), ocr: provider, ocrSharedKey: true })
    const h = { 'x-portal': '1', 'x-lang': 'en' }
    const r = await app.handle(new Request('http://localhost/api/scan?file=a.jpg', { method: 'POST', headers: h, body: Uint8Array.from([0xff, 0xd8, 0xff, 7, 1, 2, 3]) }))
    const { id } = (await r.json()) as { id: number }
    const d = (await (await app.handle(new Request(`http://localhost/api/receipts/${id}`, { headers: h }))).json()) as ReceiptDetail
    expect(d.boxes).toHaveLength(2)
    expect(d.boxes[0]).toMatchObject({ t: '$7.60', x: 0.8 })
    expect(d.boxes[1]!.t).not.toContain('4111111111111111')
  })
  test('没有给位置的识别服务: 详情里 boxes 是空数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-boxes-'))
    const provider: OcrProvider = { name: 'mock', maxBytes: 1e6, recognize: async () => ({ text: 'SHOP SDN BHD\nTOTAL 7.60', ms: 1, provider: 'mock' }) }
    const app = createApp({ db: openDb(dir), dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x'), ocr: provider, ocrSharedKey: true })
    const h = { 'x-portal': '1', 'x-lang': 'en' }
    const r = await app.handle(new Request('http://localhost/api/scan?file=b.jpg', { method: 'POST', headers: h, body: Uint8Array.from([0xff, 0xd8, 0xff, 8, 1, 2, 3]) }))
    const { id } = (await r.json()) as { id: number }
    const d = (await (await app.handle(new Request(`http://localhost/api/receipts/${id}`, { headers: h }))).json()) as ReceiptDetail
    expect(d.boxes).toEqual([])
  })
})
