/**
 * 防漂移: openapi.yaml(给对方看的接口文档)、shared/schema/document-v2.schema.json(机器可校验的结构)和代码三者必须一致。
 * 不一致时这里会失败,而不是等对方照着文档写出错误的对接代码。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAYMENT_METHODS } from '../../shared/doc'
import { DIRECTIONS, DOC_TYPES, TYPE_VERDICTS } from '../../shared/doctypes'
import { toPublicV2 } from '../../shared/public2'
import { reconcile } from '../../shared/reconcile'
import { openDb } from '../db'
import { ingest } from '../lib/importer'
import { getDetail, listReceipts } from '../lib/receipts'
import { healthPayload, toListItemV2, toScanV2, typesPayload } from '../lib/v2'
import { FIXTURES } from './fixtures/docv2'

const ROOT = join(import.meta.dir, '../..')
type J = Record<string, any>
const api = Bun.YAML.parse(readFileSync(join(ROOT, 'openapi.yaml'), 'utf8')) as J
const jsonSchema = JSON.parse(readFileSync(join(ROOT, 'shared/schema/document-v2.schema.json'), 'utf8')) as J
const comp = api.components.schemas as J
const appSrc = readFileSync(join(ROOT, 'server/app.ts'), 'utf8')

const keys = (o: J) => Object.keys(o).sort()
/** 沿着 $ref / allOf 取到真正的 object 定义。 */
const resolve = (s: J): J => {
  if (s.$ref) return resolve(comp[String(s.$ref).split('/').pop()!])
  if (s.allOf?.length === 1) return resolve(s.allOf[0])
  return s
}

describe('openapi.yaml 本身', () => {
  test('能解析,且 v1 和 v2 的路径都在', () => {
    expect(Object.keys(api.paths).sort()).toEqual([
      '/v1/health', '/v1/receipts/{id}', '/v1/scan', '/v1/schema', '/v1/validate',
      '/v2/health', '/v2/receipts', '/v2/receipts/{id}', '/v2/scan', '/v2/types',
    ])
  })

  test('所有 $ref 都能找到目标', () => {
    const bad: string[] = []
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n as J)) {
        if (k === '$ref' && typeof v === 'string') {
          const parts = v.replace(/^#\//, '').split('/')
          let cur: any = api
          for (const p of parts) cur = cur?.[p]
          if (cur === undefined) bad.push(v)
        } else walk(v)
      }
    }
    walk(api)
    expect(bad).toEqual([])
  })
})

describe('v2 路径和代码里的路由一致', () => {
  test('文档里的每个 v2 路径在 app.ts 里都有路由,反之亦然', () => {
    const v2Block = appSrc.slice(appSrc.indexOf("prefix: '/v2'"))
    const routes = new Set<string>([...v2Block.matchAll(/\.(get|post)\(\s*'(\/[^'*]*)'/g)].map((m) => m[2]!))
    expect(routes.size).toBeGreaterThan(0)
    const docPaths = Object.keys(api.paths).filter((p) => p.startsWith('/v2')).map((p) => p.slice(3).replace(/\{(\w+)\}/g, ':$1'))
    for (const p of docPaths) expect(routes.has(p)).toBe(true)
    for (const p of routes) expect(docPaths).toContain(p)
  })

  test('POST /v2/scan 的查询参数: file 必填,batch / hint_type 可选,x-lang 在 header', () => {
    const ps = api.paths['/v2/scan'].post.parameters as J[]
    const byName = Object.fromEntries(ps.map((p) => [p.name, p]))
    expect(Object.keys(byName).sort()).toEqual(['batch', 'file', 'hint_type', 'x-lang'])
    expect(byName.file.required).toBe(true)
    expect(byName.batch.required).toBeFalsy()
    expect(byName.hint_type.required).toBeFalsy()
    expect(byName['x-lang'].in).toBe('header')
  })

  test('GET /v2/receipts 的查询参数和 V2ListQuery 一致,page_size 上限 100', () => {
    const ps = api.paths['/v2/receipts'].get.parameters as J[]
    expect(ps.map((p) => p.name).sort()).toEqual(['direction', 'from', 'page', 'page_size', 'q', 'state', 'to', 'type'].sort())
    const direction = ps.find((p) => p.name === 'direction')!
    expect([...direction.schema.enum].sort()).toEqual([...DIRECTIONS].sort())
    const size = ps.find((p) => p.name === 'page_size')!
    expect(size.schema.maximum).toBe(100)
    expect(size.schema.default).toBe(20)
  })
})

describe('DocumentV2 和 JSON Schema 一致', () => {
  const compare = (oa: J, js: J, path: string, defs: J) => {
    const o = resolve(oa)
    const j = js.$ref ? defs[String(js.$ref).split('/').pop()!] : js.oneOf ? js.oneOf.find((x: J) => x.$ref) && defs[String(js.oneOf.find((x: J) => x.$ref).$ref).split('/').pop()!] : js
    if (j.properties) {
      expect({ path, keys: keys(o.properties ?? {}) }).toEqual({ path, keys: keys(j.properties) })
      expect({ path, required: [...(o.required ?? [])].sort() }).toEqual({ path, required: [...(j.required ?? [])].sort() })
      expect({ path, ap: o.additionalProperties }).toEqual({ path, ap: j.additionalProperties })
      for (const k of Object.keys(j.properties)) compare(o.properties[k], j.properties[k], `${path}.${k}`, defs)
    }
    if (j.enum) expect({ path, enum: [...o.enum].sort() }).toEqual({ path, enum: j.enum.filter((x: unknown) => x !== null).sort() })
    if (j.items) compare(o.items, j.items, `${path}[]`, defs)
    if (j.maxItems !== undefined) expect({ path, m: o.maxItems }).toEqual({ path, m: j.maxItems })
    if (j.maxLength !== undefined) expect({ path, m: o.maxLength }).toEqual({ path, m: j.maxLength })
    if (j.pattern !== undefined) expect({ path, p: o.pattern }).toEqual({ path, p: j.pattern })
  }

  test('字段、必填、枚举、长度限制逐层相同', () => {
    compare(comp.DocumentV2, jsonSchema, 'DocumentV2', jsonSchema.$defs)
  })

  test('document_type 枚举 = 代码里的类型清单(含 invoice)', () => {
    const e = comp.DocumentV2.properties.classification.properties.document_type.enum as string[]
    expect([...e].sort()).toEqual([...DOC_TYPES].sort())
    const alt = comp.AlternativeV2.properties.document_type.enum as string[]
    expect([...alt].sort()).toEqual([...DOC_TYPES].sort())
  })

  test('枚举和代码一致: 方向 / 判定 / 付款方式', () => {
    const c = comp.DocumentV2.properties
    expect([...c.classification.properties.direction.enum].sort()).toEqual([...DIRECTIONS].sort())
    expect([...c.classification.properties.type_verdict.enum].sort()).toEqual([...TYPE_VERDICTS].sort())
    expect([...c.quality.properties.type_verdict.enum].sort()).toEqual([...TYPE_VERDICTS].sort())
    expect([...c.payment.properties.method.enum].sort()).toEqual([...PAYMENT_METHODS].filter((x) => x).sort())
  })
})

describe('响应结构和真实输出一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-drift-'))
  const db = openDb(dir)
  const f = FIXTURES.sales_invoice!
  ingest(db, dir, [{ file: f.file, status: f.status, reasons: f.reasons, data: f.data, ocr_text: f.ocr_text, doc: f.doc }], () => null, 'drift')
  const id = listReceipts(db, { state: 'all', page: 1, pageSize: 1, sort: 'id', dir: 'desc' }).rows[0]!.id

  test('DocumentV2: 真实输出的顶层字段 = 文档', () => {
    const d = getDetail(db, id)
    const pub = toPublicV2(d, reconcile({ ...d.data })) as unknown as J
    expect(keys(pub)).toEqual(keys(comp.DocumentV2.properties))
  })

  test('ScanV2 / ListItemV2 / TypeInfoV2 / health 的字段 = 文档', () => {
    const scan = toScanV2({ file: 'a.jpg', id: 1, duplicate: false, status: 'AUTO', reasons: [], ms: 1, merchant: null, total: null, currency: null, items: 0 } as any)
    expect(keys(scan as any)).toEqual(keys(comp.ScanV2.properties))
    const rows = listReceipts(db, { state: 'all', page: 1, pageSize: 5, sort: 'id', dir: 'desc' }).rows
    expect(rows.length).toBeGreaterThan(0)
    expect(keys(toListItemV2(rows[0]!) as any)).toEqual(keys(comp.ListItemV2.properties))
    expect(keys(typesPayload().types[0] as any)).toEqual(keys(comp.TypeInfoV2.properties))
    const healthSchema = resolve(api.paths['/v2/health'].get.responses['200'].content['application/json'].schema)
    expect(keys(healthPayload(null) as any)).toEqual(keys(healthSchema.properties))
    const typesSchema = resolve(api.paths['/v2/types'].get.responses['200'].content['application/json'].schema)
    expect(keys(typesPayload() as any)).toEqual(keys(typesSchema.properties))
  })

  test('列表响应的外层字段', () => {
    const s = resolve(api.paths['/v2/receipts'].get.responses['200'].content['application/json'].schema)
    expect(keys(s.properties)).toEqual(['items', 'page', 'page_size', 'total'])
  })
})
