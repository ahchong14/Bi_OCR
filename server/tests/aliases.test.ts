import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { openDb } from '../db'
import { aliasResolver, backfillAliases, knownMerchants, learnAlias, loadAliases, makeResolver } from '../lib/aliases'
import { fromStructured } from '../lib/structured'
import type { ListResponse, ReceiptDetail } from '../../shared/types'

describe('商家记忆表: 解析器', () => {
  const entries = [{ alias: 'MYDIN', canonical: 'MYDIN MOHAMED HOLDINGS BHD', hits: 1 }, { alias: 'Family Mart Malaysia Store', canonical: 'FAMILYMART MALAYSIA SDN BHD', hits: 2 }]
  test('精确匹配(去符号、大小写)出现过 1 次就用', () => {
    const f = makeResolver(entries)
    expect(f('MYDIN')).toBe('MYDIN MOHAMED HOLDINGS BHD')
    expect(f('mydin')).toBe('MYDIN MOHAMED HOLDINGS BHD')
    expect(f('FAMILY-MART MALAYSIA STORE')).toBe('FAMILYMART MALAYSIA SDN BHD')
  })
  test('模糊匹配要出现过 2 次才用;太短的名字不模糊', () => {
    const f = makeResolver(entries)
    expect(f('Family Mart Malaysia Stores')).toBe('FAMILYMART MALAYSIA SDN BHD') // hits 2,相似度够
    expect(f('MYDINN')).toBeNull() // hits 只有 1,不做模糊
    expect(f('AEON')).toBeNull()
  })
  test('同一个读法有多个确认名 → 取出现次数最多的;读法本身等于确认名不记', () => {
    const f = makeResolver([{ alias: 'OLD ASIA', canonical: 'CHEF LEE SDN BHD', hits: 1 }, { alias: 'OLD ASIA', canonical: 'OLD ASIA CAFE SDN BHD', hits: 3 }, { alias: 'SAME NAME', canonical: 'same-name', hits: 5 }])
    expect(f('OLD ASIA')).toBe('OLD ASIA CAFE SDN BHD')
    expect(f('SAME NAME')).toBeNull()
  })
})

describe('商家记忆表: 学习', () => {
  const db = () => openDb(mkdtempSync(join(tmpdir(), 'portal-alias-')))
  test('读法和确认名差得多 → 记一条,再来一次次数 +1', () => {
    const d = db()
    expect(learnAlias(d, 'MYDIN', 'MYDIN MOHAMED HOLDINGS BHD')).toBe(true)
    expect(learnAlias(d, 'mydin', 'MYDIN MOHAMED HOLDINGS BHD')).toBe(true)
    expect(loadAliases(d)).toMatchObject([{ canonical: 'MYDIN MOHAMED HOLDINGS BHD', hits: 2 }])
  })
  test('只是大小写/标点不同、或 OCR 错一个字母(相似度 ≥ 0.9)→ 不记', () => {
    const d = db()
    expect(learnAlias(d, 'Mydin Holdings', 'MYDIN HOLDINGS')).toBe(false)
    expect(learnAlias(d, 'LIAN HING STATIONERY SDN BHD', 'LAN HING STATIONERY SDN BHD')).toBe(false)
    expect(learnAlias(d, null, 'X')).toBe(false)
    expect(learnAlias(d, 'X', '')).toBe(false)
    expect(loadAliases(d)).toEqual([])
  })
})

describe('商家记忆表: 扫描时使用', () => {
  const T = ['CHEF LEE SDN BHD', '15/08/2025', 'SUBTOTAL 27.00', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00'].join('\n')
  const F = { merchant_name: 'OLD ASIA', date: '15/08/2025', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '30.00', change_given: '3.00' }
  const scan = (opts = {}) => fromStructured({ fields: { ...F }, items: [], text: T, failed: [], ms: 1, provider: 'x' }, opts)
  test('没有记忆表: 品牌名对法定名 → 标记 merchant_legal_name_differs,不自动通过', () => {
    const e = scan()
    expect(e.reasons).toContain('merchant_legal_name_differs')
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('记忆表里有这个读法 → 换成确认过的名字,留更正记录,不再标法定名,可以自动通过', () => {
    const e = scan({ aliasOf: makeResolver([{ alias: 'OLD ASIA', canonical: 'CHEF LEE SDN BHD', hits: 1 }]) })
    expect(e.data.merchant).toBe('CHEF LEE SDN BHD')
    expect(e.reasons).toContain('merchant_alias')
    expect(e.reasons).not.toContain('merchant_legal_name_differs')
    expect(e.corrections.some((c) => c.field === 'merchant' && c.old === 'OLD ASIA')).toBe(true)
    expect(e.status).toBe('AUTO_VERIFIED')
  })
  test('审核员以前确认过「OLD ASIA」这个名字本身 → 不再标法定名(品牌名就是他们要的)', () => {
    const e = scan({ isKnown: (n: string) => n === 'OLD ASIA' })
    expect(e.data.merchant).toBe('OLD ASIA')
    expect(e.reasons).not.toContain('merchant_legal_name_differs')
  })
})

describe('商家记忆表: 审核流程里学习', () => {
  const png = (n: number) => { const b = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); b[b.length - 20] = n; return b }
  const zip = () => zipSync({
    'receipts_result.json': strToU8(JSON.stringify(['a', 'b'].map((k) => ({ file: `${k}.png`, status: 'REVIEW', reasons: [], data: { merchant: 'MYDIN', date: '2018-03-03', currency: 'MYR', total: 27, subtotal: 27, items: [] }, image: `images/${k}.png` })))),
    'images/a.png': png(1), 'images/b.png': png(2),
  })
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-alias-flow-'))
    const db = openDb(dir)
    const app = createApp({ db, dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x') })
    const call = async (path: string, json?: unknown, raw?: Uint8Array) => {
      const res = await app.handle(new Request('http://localhost' + path, { method: json !== undefined || raw ? 'POST' : 'GET', headers: { 'x-portal': '1', ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : raw }))
      return (await res.json()) as any
    }
    await call('/api/import/zip', undefined, zip())
    const rows = ((await call('/api/receipts?state=pending')) as ListResponse).rows
    return { db, call, rows }
  }
  test('逐张审核通过并把商家改成法定名 → 记一条别名,并进入「确认过的商家」', async () => {
    const { db, call, rows } = await setup()
    const id = rows.find((r) => r.file === 'a.png')!.id
    const d = (await call(`/api/receipts/${id}`)) as ReceiptDetail
    await call(`/api/receipts/${id}/review`, { version: d.version, action: 'approve', user: 'Ann', final: { ...d.data, merchant: 'MYDIN MOHAMED HOLDINGS BHD' } })
    expect(loadAliases(db)).toMatchObject([{ alias: 'MYDIN', canonical: 'MYDIN MOHAMED HOLDINGS BHD', hits: 1 }])
    expect(aliasResolver(db)('MYDIN')).toBe('MYDIN MOHAMED HOLDINGS BHD')
    expect(knownMerchants(db)('Mydin Mohamed Holdings Bhd')).toBe(true)
  })
  test('批量通过不学(没有逐张看过)', async () => {
    const { db, call, rows } = await setup()
    await call('/api/receipts/bulk', { action: 'approve', ids: rows.map((r) => r.id), scope: 'all', user: 'Ann' })
    expect(loadAliases(db)).toEqual([])
    expect(knownMerchants(db)('MYDIN')).toBe(false)
  })
  test('审核时没改商家 → 不记别名', async () => {
    const { db, call, rows } = await setup()
    const id = rows[0]!.id
    const d = (await call(`/api/receipts/${id}`)) as ReceiptDetail
    await call(`/api/receipts/${id}/review`, { version: d.version, action: 'approve', user: 'Ann', final: d.data })
    expect(loadAliases(db)).toEqual([])
    expect(knownMerchants(db)('MYDIN')).toBe(true) // 但「MYDIN」这个名字被确认过了
  })
})

describe('助手代审核(claude-assist)直接当作商家记忆表的来源', () => {
  const png = (n: number) => { const b = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); b[b.length - 20] = n; return b }
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-assistant-'))
    const db = openDb(dir)
    const app = createApp({ db, dataDir: dir, token: '', localOnly: true, webDir: join(dir, 'x') })
    const call = async (path: string, json?: unknown, raw?: Uint8Array) => {
      const res = await app.handle(new Request('http://localhost' + path, { method: json !== undefined || raw ? 'POST' : 'GET', headers: { 'x-portal': '1', ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : raw }))
      return (await res.json()) as any
    }
    const zip = zipSync({
      'receipts_result.json': strToU8(JSON.stringify(['a', 'b'].map((k) => ({ file: `${k}.png`, status: 'REVIEW', reasons: [], data: { merchant: 'MYDIN', date: '2018-03-03', currency: 'MYR', total: 27, subtotal: 27, items: [] }, image: `images/${k}.png` })))),
      'images/a.png': png(1), 'images/b.png': png(2),
    })
    await call('/api/import/zip', undefined, zip)
    const rows = ((await call('/api/receipts?state=pending')) as ListResponse).rows
    const review = async (file: string, user: string) => {
      const id = rows.find((r) => r.file === file)!.id
      const d = (await call(`/api/receipts/${id}`)) as ReceiptDetail
      await call(`/api/receipts/${id}/review`, { version: d.version, action: 'approve', user, final: { ...d.data, merchant: 'MYDIN MOHAMED HOLDINGS BHD' } })
    }
    return { db, review }
  }
  test('助手逐张通过并改了商家 → 学别名,并进入「确认过的商家」', async () => {
    const { db, review } = await setup()
    await review('a.png', 'claude-assist')
    expect(loadAliases(db)).toMatchObject([{ alias: 'MYDIN', canonical: 'MYDIN MOHAMED HOLDINGS BHD', hits: 1 }])
    expect(knownMerchants(db)('MYDIN MOHAMED HOLDINGS BHD')).toBe(true)
  })
  test('回填: 清掉记忆表后补学,结果一样;重复运行不会重复计数', async () => {
    const { db, review } = await setup()
    await review('a.png', 'claude-assist')
    await review('b.png', 'Ann')
    db.exec('DELETE FROM merchant_alias')
    expect(backfillAliases(db)).toEqual({ receipts: 2, learned: 2 })
    expect(loadAliases(db)).toMatchObject([{ alias: 'MYDIN', canonical: 'MYDIN MOHAMED HOLDINGS BHD', hits: 2 }])
    expect(backfillAliases(db).learned).toBe(0)
    expect(loadAliases(db)[0]!.hits).toBe(2)
  })
})
