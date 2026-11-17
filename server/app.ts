import type { Database } from 'bun:sqlite'
import { Elysia, t } from 'elysia'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { PIPELINE_STATUSES, type BulkRequest, type Lang, type PipelineStatus, type ReceiptQuery } from '../shared/types'
import { getAnalytics } from './lib/analytics'
import { nowLocal } from './db'
import { itemsCsv, receiptsCsv } from './lib/csv'
import { HttpError } from './lib/errors'
import { parseLang, serverMessage } from './lib/i18n'
import { attachImage, importZip, ingest, MAX_IMG } from './lib/importer'
import { PUBLIC_SCHEMA_VERSION, UNTRUSTED_TEXT_FIELDS } from '../shared/public'
import type { OcrProvider } from './lib/ocr'
import { limiter, scanImage } from './lib/scan'
import { enqueueSecond, secondEnabled } from './lib/second'
import { getAccuracy, importTruth, truthCount } from './lib/truth'
import { getPublicReceipt, validateReceipt, type ValidateRequest } from './lib/v1'
import { getPublicV2, healthPayload, listPublicV2, parseHintType, toScanV2, typesPayload } from './lib/v2'
import { bulkAction, previewBulk, getDetail, getMeta, getStats, listAudit, listReceipts, reviewReceipt } from './lib/receipts'

export interface AppContext {
  db: Database
  dataDir: string
  token: string // 空字符串 = 不要求口令(仅限本机时)
  localOnly: boolean // 只监听本机时,额外校验 Host 头,防 DNS rebinding
  webDir: string // 前端构建产物目录
  ocr?: OcrProvider | null // 门户内扫描用的识别服务;没有或为 null 就关闭扫描
  ocrSharedKey?: boolean // 用的是公开共享的测试 key(界面上提示员工)
}

const MAX_ZIP = 2 * 1024 ** 3

const stateT = t.Union([t.Literal('pending'), t.Literal('approved'), t.Literal('rejected'), t.Literal('all')])
const statusT = t.Union(PIPELINE_STATUSES.map((s) => t.Literal(s)) as [ReturnType<typeof t.Literal<PipelineStatus>>])
const receiptQuery = t.Object({
  state: t.Optional(stateT), status: t.Optional(statusT), q: t.Optional(t.String()), currency: t.Optional(t.String()),
  from: t.Optional(t.String()), to: t.Optional(t.String()), edited: t.Optional(t.Union([t.Literal('yes'), t.Literal('no')])),
  type: t.Optional(t.String()), direction: t.Optional(t.String()),
  reviewer: t.Optional(t.String()), ids: t.Optional(t.String()), lang: t.Optional(t.Union([t.Literal('zh'), t.Literal('en')])), sort: t.Optional(t.String()), dir: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
  page: t.Optional(t.Numeric()), pageSize: t.Optional(t.Numeric()),
})

const langOf = (request: Request): Lang => parseLang(request.headers.get('x-lang'), request.headers.get('accept-language'))

/** 统一的错误响应: 业务错误(HttpError)按请求头 x-lang 翻译成中文或英文;同时返回 code,前端可以自行处理。 */
const onError = ({ code, error, set, request }: { code: string | number; error: unknown; set: { status?: number | string }; request: Request }) => {
  const lang = langOf(request)
  if (error instanceof HttpError) {
    set.status = error.status
    return { error: serverMessage(error.code, lang, error.params), code: error.code }
  }
  if (code === 'VALIDATION') { set.status = 400; return { error: serverMessage('VALIDATION', lang), code: 'VALIDATION' } }
  if (code === 'PARSE') { set.status = 400; return { error: serverMessage('PARSE', lang), code: 'PARSE' } }
  if (code === 'NOT_FOUND') { set.status = 404; return { error: serverMessage('API_NOT_FOUND', lang), code: 'API_NOT_FOUND' } }
  console.error(error)
  set.status = 500
  return { error: serverMessage('SERVER_ERROR', lang), code: 'SERVER_ERROR' }
}

const safeEqual = (a: string, b: string) => {
  const A = Buffer.from(a), B = Buffer.from(b)
  return A.length === B.length && timingSafeEqual(A, B)
}

/** 文字类静态文件(js/css/html/svg)压缩后缓存在内存里,首次打开约少传 70% 的数据。 */
const GZ_TYPES = /\.(js|css|html|svg|json|map)$/
const gzCache = new Map<string, { mtime: number; bytes: Uint8Array }>()
function gzipped(path: string, acceptEncoding: string): Uint8Array | null {
  if (!acceptEncoding.includes('gzip') || !GZ_TYPES.test(path)) return null
  const mtime = statSync(path).mtimeMs
  const hit = gzCache.get(path)
  if (hit && hit.mtime === mtime) return hit.bytes
  const bytes = Bun.gzipSync(new Uint8Array(readFileSync(path)))
  gzCache.set(path, { mtime, bytes })
  return bytes
}

export function createApp(ctx: AppContext) {
  const { db, dataDir } = ctx
  const ocrSlots = limiter(ctx.ocr?.concurrency ?? 2) // 同时在识别的张数: 默认 2;识别服务自己声明(Claude 默认 4)

  /** 所有 /api 请求的统一守卫: Host 校验 → 防跨站伪造 → 口令。 */
  const guard = ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    if (ctx.localOnly && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new HttpError(403, 'HOST_FORBIDDEN')
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('x-portal') !== '1') throw new HttpError(403, 'REQUEST_FORBIDDEN')
    if (ctx.token) {
      const given = request.headers.get('x-token') ?? url.searchParams.get('t') ?? ''
      if (!safeEqual(given, ctx.token)) throw new HttpError(401, 'TOKEN_REQUIRED')
    }
  }

  const csvResponse = (bytes: Uint8Array, name: string) =>
    new Response(bytes, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } })

  const exportQuery = (q: ReceiptQuery): ReceiptQuery => ({ ...q, state: q.state ?? 'approved' })

  const api = new Elysia({ prefix: '/api' })
    .onError(onError)
    .onBeforeHandle(guard)
    .get('/stats', () => getStats(db))
    .get('/meta', () => getMeta(db))
    .get('/receipts', ({ query }) => listReceipts(db, query as ReceiptQuery), { query: receiptQuery })
    .get('/receipts/:id', ({ params }) => getDetail(db, params.id), { params: t.Object({ id: t.Numeric() }) })
    // 手动(重新)请求第二意见: 202 = 已入队;409 = 没开第二个读取模型 / 已在队列里
    .post('/receipts/:id/second', ({ params, set }) => {
      if (!secondEnabled()) throw new HttpError(409, 'SECOND_DISABLED')
      if (!getDetail(db, params.id)) throw new HttpError(404, 'RECEIPT_NOT_FOUND')
      if (!enqueueSecond(params.id)) throw new HttpError(409, 'SECOND_ALREADY_QUEUED')
      set.status = 202
      return { queued: true }
    }, { params: t.Object({ id: t.Numeric() }) })
    .post(
      '/receipts/:id/review',
      ({ params, body }) => reviewReceipt(db, params.id, body as Parameters<typeof reviewReceipt>[2]),
      {
        params: t.Object({ id: t.Numeric() }),
        body: t.Object({
          action: t.Union([t.Literal('approve'), t.Literal('reject'), t.Literal('save'), t.Literal('reopen')]),
          version: t.Integer(), user: t.String({ maxLength: 60 }), note: t.Optional(t.String({ maxLength: 500 })), final: t.Optional(t.Any()),
        }),
      },
    )
    .post('/bulk', ({ body }) => bulkAction(db, body as BulkRequest), {
      body: t.Object({
        ids: t.Array(t.Integer(), { maxItems: 5000 }), action: t.Union([t.Literal('approve'), t.Literal('reject'), t.Literal('reopen')]),
        user: t.String({ maxLength: 60 }), note: t.Optional(t.String({ maxLength: 500 })), scope: t.Optional(t.Union([t.Literal('clean'), t.Literal('all')])),
      }),
    })
    .post('/bulk/preview', ({ body }) => previewBulk(db, body.ids), { body: t.Object({ ids: t.Array(t.Integer(), { maxItems: 5000 }) }) })
    .get(
      '/image/:id',
      ({ params, request }) => {
        const row = db.query<{ image: string | null }, [number]>('SELECT image FROM receipts WHERE id = ?').get(params.id)
        if (!row?.image) throw new HttpError(404, 'IMAGE_NOT_FOUND')
        // 图片文件名就是内容哈希,拿它当 ETag: 浏览器再次打开同一张图只需一次极小的校验请求
        const etag = `"${row.image}"`
        const headers = { 'cache-control': 'private, no-cache', etag } // no-cache = 每次都向服务器核对 ETag(很小的请求): 清空数据后编号会从 1 重来,不能让浏览器凭编号直接用旧图
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
        return new Response(Bun.file(join(dataDir, 'images', basename(row.image))), { headers })
      },
      { params: t.Object({ id: t.Numeric() }) },
    )
    // ---- 导入 ----
    .post(
      '/import/zip',
      async ({ request }) => {
        const bytes = new Uint8Array(await request.arrayBuffer()) // 不依赖 content-length(分块传输时没有);大小上限由 maxRequestBodySize 保证
        if (!bytes.length || bytes.length > MAX_ZIP) throw new HttpError(400, 'FILE_EMPTY_OR_TOO_BIG')
        return importZip(db, dataDir, bytes)
      },
      { parse: 'none' },
    )
    .post(
      '/import/json',
      ({ body }) => {
        const list = Array.isArray(body) ? body : (body as { results?: unknown })?.results
        if (!Array.isArray(list)) throw new HttpError(400, 'JSON_BAD_FORMAT')
        return ingest(db, dataDir, list, () => null, `json ${new Date().toISOString().slice(0, 19)}`)
      },
      { body: t.Any() },
    )
    .post(
      '/import/image',
      async ({ request, query }) => {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!bytes.length || bytes.length > MAX_IMG) throw new HttpError(400, 'IMAGE_EMPTY_OR_TOO_BIG')
        return { attached: attachImage(db, dataDir, query.file, bytes) }
      },
      { parse: 'none', query: t.Object({ file: t.String() }) },
    )
    // ---- 扫描: 上传一张图片 → 识别 → 提取 → 进入待审核 ----
    .get('/scan/info', () => ({ enabled: !!ctx.ocr, provider: ctx.ocr?.name ?? null, sharedTestKey: !!ctx.ocrSharedKey, maxBytes: MAX_IMG, local: !!ctx.ocr?.local }))
    .post(
      '/scan',
      async ({ request, query }) => {
        if (!ctx.ocr) throw new HttpError(503, 'SCAN_DISABLED')
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!bytes.length || bytes.length > MAX_IMG) throw new HttpError(400, 'IMAGE_EMPTY_OR_TOO_BIG')
        return ocrSlots(() => scanImage(db, dataDir, ctx.ocr!, bytes, query.file, query.batch))
      },
      { parse: 'none', query: t.Object({ file: t.String({ maxLength: 200 }), batch: t.Optional(t.String({ maxLength: 60 })) }) },
    )
    // ---- 标准答案对照: 导入 CSV(文件名 → 商家/日期/总额),再看识别准确率 ----
    .post(
      '/truth/import',
      async ({ request }) => {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new HttpError(400, 'FILE_EMPTY_OR_TOO_BIG')
        return importTruth(db, new TextDecoder().decode(bytes))
      },
      { parse: 'none' },
    )
    .get('/truth/info', () => ({ count: truthCount(db) }))
    .get('/accuracy', () => getAccuracy(db))
    // ---- 统计 / 审计 / 导出 ----
    .get('/analytics', ({ query }) => getAnalytics(db, query), {
      query: t.Object({
        from: t.Optional(t.String()), to: t.Optional(t.String()), currency: t.Optional(t.String()),
        granularity: t.Optional(t.Union([t.Literal('day'), t.Literal('week'), t.Literal('month')])),
      }),
    })
    .get('/audit', ({ query }) => listAudit(db, query), {
      query: t.Object({ user: t.Optional(t.String()), action: t.Optional(t.String()), q: t.Optional(t.String()), page: t.Optional(t.Numeric()), pageSize: t.Optional(t.Numeric()) }),
    })
    .get('/export/receipts.csv', ({ query, request }) => csvResponse(receiptsCsv(db, exportQuery(query as ReceiptQuery), query.lang ?? langOf(request)), 'receipts.csv'), { query: receiptQuery })
    .get('/export/items.csv', ({ query, request }) => csvResponse(itemsCsv(db, exportQuery(query as ReceiptQuery), query.lang ?? langOf(request)), 'receipt_items.csv'), { query: receiptQuery })

  /** 对外 API(/v1): 给 MCP 和其他系统调用。口令走标准的 Authorization: Bearer;不要求门户专用的 x-portal 头。 */
  const v1Guard = ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    if (ctx.localOnly && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new HttpError(403, 'HOST_FORBIDDEN')
    if (ctx.token) {
      const auth = request.headers.get('authorization') ?? ''
      const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (request.headers.get('x-token') ?? '')
      if (!safeEqual(given, ctx.token)) throw new HttpError(401, 'TOKEN_REQUIRED')
    }
  }
  const money = t.Union([t.Number(), t.Null()])
  const v1 = new Elysia({ prefix: '/v1' })
    .onError(onError)
    .onBeforeHandle(v1Guard)
    .get('/schema', () => ({ schema_version: PUBLIC_SCHEMA_VERSION, untrusted_text_fields: UNTRUSTED_TEXT_FIELDS }))
    // 联调用: 能连上、口令对不对、扫描有没有开(没设 ANTHROPIC_API_KEY 时 scan_enabled = false,/v1/scan 会返回 503)。不调用模型,不花钱。
    .get('/health', () => ({ ok: true, scan_enabled: !!ctx.ocr, provider: ctx.ocr?.name ?? null, max_image_bytes: MAX_IMG, schema_version: PUBLIC_SCHEMA_VERSION }))
    .get('/receipts/:id', ({ params }) => getPublicReceipt(db, params.id), { params: t.Object({ id: t.Numeric() }) })
    // 给另一个系统调用: 请求体就是图片的原始字节(不是表单),?file=文件名(要带扩展名 jpg/png/webp/gif)。
    // 识别 → 校验 → 入库(进入待审核),返回扫描结果 + 公开契约的收据(含对账结果和质量判定)。同一张图再传不会重复调用模型。
    // 状态码: 400 图片为空 / 太大 / 格式不支持;401 口令不对;429 额度或频率限制;502 识别服务出错;503 扫描没开(没设 ANTHROPIC_API_KEY)。
    .post(
      '/scan',
      async ({ request, query }) => {
        if (!ctx.ocr) throw new HttpError(503, 'SCAN_DISABLED')
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!bytes.length || bytes.length > MAX_IMG) throw new HttpError(400, 'IMAGE_EMPTY_OR_TOO_BIG')
        const scan = await ocrSlots(() => scanImage(db, dataDir, ctx.ocr!, bytes, query.file, query.batch ?? `api ${nowLocal()}`))
        return { scan, receipt: scan.id === null ? null : getPublicReceipt(db, scan.id) }
      },
      { parse: 'none', query: t.Object({ file: t.String({ maxLength: 200 }), batch: t.Optional(t.String({ maxLength: 60 })) }) },
    )
    .post('/validate', ({ body }) => validateReceipt(body as ValidateRequest), {
      body: t.Object({
        currency: t.Optional(t.Union([t.String({ maxLength: 8 }), t.Null()])),
        subtotal: t.Optional(money), discount: t.Optional(money), service_charge: t.Optional(money), tax: t.Optional(money), tip: t.Optional(money),
        fees: t.Optional(money), rounding: t.Optional(money), total: t.Optional(money), paid: t.Optional(money), change: t.Optional(money),
        items: t.Optional(t.Array(t.Object({ name: t.Optional(t.String({ maxLength: 200 })), qty: t.Optional(money), price: t.Optional(money) }), { maxItems: 500 })),
        taxes: t.Optional(t.Array(t.Object({ label: t.Optional(t.Union([t.String({ maxLength: 40 }), t.Null()])), rate: money, base: money, amount: money }), { maxItems: 20 })),
      }),
    })

  /**
   * 对外 API v2(单据分类版)。口令和 /v1 同一套(Authorization: Bearer),不要求门户专用的 x-portal 头。
   * 响应结构见 shared/schema/document-v2.schema.json 和 openapi.yaml;/v1 保持不变。
   */
  const v2 = new Elysia({ prefix: '/v2' })
    .onError(onError)
    .onBeforeHandle(v1Guard)
    .get('/health', () => healthPayload(ctx.ocr))
    .get('/types', () => typesPayload())
    // 请求体就是图片的原始字节;?file= 文件名(带扩展名);?batch= 批次名;?hint_type= 调用方已经知道类型时直接指定(仍然会校验,方向 / 日期 / 证件号检查照旧)。
    // 返回 { scan, receipt }: receipt 是 v2 结构(分类、标题、关键词、对方、金额、商品行、对账、质量)。同一张图再传不会重复调用模型(返回已有结果,hint_type 不会改动已入库的)。
    // 状态码: 400 图片为空 / 太大 / 格式不支持;401 口令不对;422 hint_type 不认识;429 额度 / 频率限制;502 识别服务出错;503 扫描没开。
    .post(
      '/scan',
      async ({ request, query }) => {
        if (!ctx.ocr) throw new HttpError(503, 'SCAN_DISABLED')
        const hintType = parseHintType(query.hint_type)
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!bytes.length || bytes.length > MAX_IMG) throw new HttpError(400, 'IMAGE_EMPTY_OR_TOO_BIG')
        const scan = await ocrSlots(() => scanImage(db, dataDir, ctx.ocr!, bytes, query.file, query.batch ?? `api ${nowLocal()}`, { hintType }))
        return { scan: toScanV2(scan), receipt: scan.id === null ? null : getPublicV2(db, scan.id) }
      },
      { parse: 'none', query: t.Object({ file: t.String({ maxLength: 200 }), batch: t.Optional(t.String({ maxLength: 60 })), hint_type: t.Optional(t.String({ maxLength: 40 })) }) },
    )
    .get(
      '/receipts',
      ({ query }) => listPublicV2(db, query),
      {
        query: t.Object({
          type: t.Optional(t.String({ maxLength: 40 })), direction: t.Optional(t.String({ maxLength: 20 })), state: t.Optional(t.String({ maxLength: 20 })), q: t.Optional(t.String({ maxLength: 100 })),
          from: t.Optional(t.String({ maxLength: 10 })), to: t.Optional(t.String({ maxLength: 10 })), page: t.Optional(t.Numeric()), page_size: t.Optional(t.Numeric()),
        }),
      },
    )
    .get('/receipts/:id', ({ params }) => getPublicV2(db, params.id), { params: t.Object({ id: t.Numeric() }) })

  const webRoot = resolve(ctx.webDir)
  const SECURITY = {
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }

  return new Elysia({ serve: { maxRequestBodySize: MAX_ZIP + 1024 * 1024 } })
    .onError(onError)
    .use(api)
    .use(v1)
    .use(v2)
    .get('/*', ({ request }) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/v2/')) throw new HttpError(404, 'API_NOT_FOUND') // 未知接口不能回退成页面
      if (!existsSync(webRoot)) return new Response(serverMessage('FRONTEND_NOT_BUILT', langOf(request)), { status: 503 })
      const full = resolve(webRoot, '.' + pathname)
      const isFile = full.startsWith(webRoot + sep) && existsSync(full) && statSync(full).isFile()
      const target = isFile ? full : join(webRoot, 'index.html') // 单页应用: 找不到的路径都回到 index.html
      const immutable = isFile && pathname.startsWith('/assets/')
      const headers: Record<string, string> = { ...SECURITY, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store', vary: 'accept-encoding' }
      const gz = gzipped(target, request.headers.get('accept-encoding') ?? '')
      if (gz) return new Response(gz, { headers: { ...headers, 'content-encoding': 'gzip', 'content-type': Bun.file(target).type } })
      return new Response(Bun.file(target), { headers })
    })
}

export type App = ReturnType<typeof createApp>
