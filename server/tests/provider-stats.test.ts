import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { getAnalytics, providerOf } from '../lib/analytics'
import { ingest } from '../lib/importer'

describe('providerOf: 从批次名判断是谁识别的', () => {
  test('门户扫描的批次名带识别服务名;只取 @ 前面(隧道主机每次都不同)', () => {
    expect(providerOf('scan 2026-11-02 07:20:27 · minicpm-ocr@exactly-cabinet.trycloudflare.com')).toBe('minicpm-ocr')
    expect(providerOf('scan 2026-11-02 07:20:27 · minicpm-ocr@127.0.0.1:18499')).toBe('minicpm-ocr')
    expect(providerOf('scan 2026-11-02 07:20:27 · ocr.space')).toBe('ocr.space')
  })
  test('旧的扫描批次(没记录来源)、zip / json 导入、其他', () => {
    expect(providerOf('scan 2026-10-22 07:46:34')).toBe('scan')
    expect(providerOf('zip 2026-10-22T09:51:07')).toBe('zip')
    expect(providerOf('json 2026-10-22T09:51:07')).toBe('json')
    expect(providerOf('随便什么')).toBe('other')
    expect(providerOf(null)).toBe('other')
    expect(providerOf('scan x · ')).toBe('other') // 服务名为空
  })
})

describe('getAnalytics.providers: 按识别来源对比', () => {
  function build() {
    const dir = mkdtempSync(join(tmpdir(), 'portal-prov-'))
    const db = openDb(dir)
    let n = 0
    const add = (batch: string, status: string, extra: Record<string, unknown> = {}) => {
      const file = `r${++n}.jpg`
      ingest(db, dir, [{ file, status, reasons: [], data: { merchant: 'M', date: '2026-01-02', total: 10, currency: 'MYR' }, ...extra }], () => null, batch)
      return (db.query('SELECT id FROM receipts WHERE file = ?').get(file) as { id: number }).id
    }
    const review = (id: number, mode: 'single' | 'bulk', edited: boolean) =>
      db.query("UPDATE receipts SET state = 'approved', review_mode = ?, edited_fields = ?, reviewer = 'x', reviewed_at = '2026-11-02T10:00:00' WHERE id = ?").run(mode, edited ? '["total"]' : '[]', id)

    // MiniCPM: 两个批次(隧道主机不同,应合并成一组),共 6 张;其中 4 张有耗时记录(10/12/14/16 秒 → 平均 13)
    const A = 'scan 2026-11-02 07:00:00 · minicpm-ocr@aaa.trycloudflare.com'
    const B = 'scan 2026-11-02 09:00:00 · minicpm-ocr@bbb.trycloudflare.com'
    const m1 = add(A, 'AUTO_VERIFIED', { timing: { total: 10 } })
    const m2 = add(A, 'REVIEW', { timing: { total: 12 } })
    const m3 = add(A, 'REVIEW', { timing: { total: 14 } })
    const m4 = add(A, 'CORRECTED', { timing: { total: 16 } })
    add(B, 'REVIEW'); add(B, 'REVIEW')
    review(m1, 'single', false) // 逐张审核通过,没改
    review(m2, 'single', true) // 逐张审核通过,改过
    review(m3, 'bulk', false) // 批量通过: 不能算"人工确认过",不进改动率的样本
    // m4 保持待审

    // 旧的扫描批次(没记录来源): 3 张,2 张逐张通过都改过
    const old = 'scan 2026-10-22 07:46:34'
    const o1 = add(old, 'REVIEW'), o2 = add(old, 'REVIEW'); add(old, 'AUTO_VERIFIED')
    review(o1, 'single', true); review(o2, 'single', true)
    // zip 导入: 2 张都逐张通过没改
    const z1 = add('zip 2026-10-22T09:51:07', 'AUTO_VERIFIED'), z2 = add('zip 2026-10-22T09:51:07', 'AUTO_VERIFIED')
    review(z1, 'single', false); review(z2, 'single', false)
    return { db, m4 }
  }

  test('同一服务的不同批次(隧道主机不同)合并成一组;按收据数排序', () => {
    const { db } = build()
    const p = getAnalytics(db, {}).providers
    expect(p.map((x) => x.provider)).toEqual(['minicpm-ocr', 'scan', 'zip'])
    expect(p.map((x) => x.count)).toEqual([6, 3, 2])
  })
  test('MiniCPM 一组的各项指标', () => {
    const m = getAnalytics(build().db, {}).providers.find((x) => x.provider === 'minicpm-ocr')!
    expect(m).toMatchObject({ count: 6, pending: 3, approved: 3, rejected: 0 })
    expect(m.autoShare).toBeCloseTo(1 / 6) // 6 张里只有 1 张初判「基本可信」
    expect(m.reviewShare).toBeCloseTo(4 / 6) // 4 张「需检查」(2+2);另外 1 张已更正
    // 改动率: 逐张通过的只有 2 张(批量通过的那张不算),其中 1 张改过 → 50%
    expect(m.editSample).toBe(2)
    expect(m.editRate).toBeCloseTo(0.5)
    // 平均耗时只统计有记录的 4 张: (10+12+14+16)/4 = 13
    expect(m.timedCount).toBe(4)
    expect(m.avgSeconds).toBeCloseTo(13)
  })
  test('没有记录耗时的来源,平均耗时是 null 而不是 0', () => {
    const p = getAnalytics(build().db, {}).providers
    expect(p.find((x) => x.provider === 'scan')).toMatchObject({ avgSeconds: null, timedCount: 0, editRate: 1, editSample: 2 })
    expect(p.find((x) => x.provider === 'zip')).toMatchObject({ avgSeconds: null, editRate: 0, autoShare: 1 })
  })
  test('没有逐张审核过的样本时,改动率是 null(界面显示"—"),不是 0%', () => {
    const { db } = build()
    db.query("UPDATE receipts SET state = 'pending', review_mode = NULL, edited_fields = '[]' WHERE batch LIKE 'zip %'").run()
    const z = getAnalytics(db, {}).providers.find((x) => x.provider === 'zip')!
    expect(z.editSample).toBe(0)
    expect(z.editRate).toBeNull()
  })
  test('空库不报错,providers 是空数组', () => {
    expect(getAnalytics(openDb(mkdtempSync(join(tmpdir(), 'portal-prov-empty-'))), {}).providers).toEqual([])
  })
})
