import type {
  AccuracyReport, TruthImportResult, Analytics, AnalyticsQuery, AuditQuery, AuditResponse, BulkPreview, BulkRequest, BulkResult, ImportResult, Lang, ListResponse, Meta, ReceiptDetail, ReceiptQuery, ReviewRequest, ScanInfo, ScanOutcome, Stats,
} from '../../shared/types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

let token = localStorage.getItem('portal_token') ?? ''
let askToken: (() => Promise<void>) | null = null
export const setTokenPrompt = (fn: () => Promise<void>) => { askToken = fn }
export const setToken = (t: string) => { token = t; localStorage.setItem('portal_token', t) }
let lang: Lang = 'zh'
/** 界面语言,每个请求都带上,服务端的错误提示就用同一种语言。 */
export const setApiLang = (l: Lang) => { lang = l }

const baseHeaders = (extra?: HeadersInit): Record<string, string> => ({
  'x-portal': '1', // 写操作必须带这个自定义头,防止别的网站伪造请求
  'x-lang': lang,
  ...(token ? { 'x-token': token } : {}),
  ...(extra as Record<string, string> | undefined),
})

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { ...init, headers: baseHeaders(init.headers) })
  } catch {
    // 断网、服务器没开、被防火墙拦了: 浏览器只会给一句英文 "Failed to fetch",这里换成员工看得懂、知道下一步怎么做的话
    throw new ApiError(0, lang === 'zh' ? '连不上服务器。请检查网络,或确认门户服务器还在运行。你填的内容还在,恢复后再点一次即可。' : 'Cannot reach the server. Check your network or that the portal server is running. What you entered is still here; try again once it is back.')
  }
  if (res.status === 401 && askToken && !retried) {
    await askToken()
    return request<T>(path, init, true)
  }
  let data: unknown = null
  try { data = await res.json() } catch { /* 空响应 */ }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `请求失败(${res.status})`)
  return data as T
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** 对象 → 查询串,自动忽略空值。 */
export function qs(o: object): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  stats: () => request<Stats>('/api/stats'),
  meta: () => request<Meta>('/api/meta'),
  receipts: (q: ReceiptQuery) => request<ListResponse>(`/api/receipts${qs(q)}`),
  receipt: (id: number) => request<ReceiptDetail>(`/api/receipts/${id}`),
  review: (id: number, body: ReviewRequest) => request<ReceiptDetail>(`/api/receipts/${id}/review`, post(body)),
  requestSecond: (id: number) => request<{ queued: boolean }>(`/api/receipts/${id}/second`, post({})),
  bulk: (req: BulkRequest) => request<BulkResult>('/api/bulk', post(req)),
  bulkPreview: (ids: number[]) => request<BulkPreview>('/api/bulk/preview', post({ ids })),
  scanInfo: () => request<ScanInfo>('/api/scan/info'),
  scanImage: (file: File, batch: string) => request<ScanOutcome>(`/api/scan${qs({ file: file.name, batch })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  truthInfo: () => request<{ count: number }>('/api/truth/info'),
  importTruth: (file: File) => request<TruthImportResult>('/api/truth/import', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file }),
  accuracy: () => request<AccuracyReport>('/api/accuracy'),
  analytics: (q: AnalyticsQuery) => request<Analytics>(`/api/analytics${qs(q)}`),
  audit: (q: AuditQuery) => request<AuditResponse>(`/api/audit${qs(q)}`),
  importJson: (results: unknown) => request<ImportResult>('/api/import/json', post(results)),
  attachImage: (file: File) =>
    request<{ attached: number }>(`/api/import/image${qs({ file: file.name })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  /** v 随便一个「这条记录独有」的值(导入时间)。清空数据后收据编号会从 1 重来,浏览器按网址缓存图片,
   *  不带 v 的话新的 5 号会显示旧的 5 号的图。带上 v,网址就不一样,旧缓存用不上。 */
  imageUrl: (id: number, v?: string) => { const q = [v ? `v=${encodeURIComponent(v)}` : '', token ? `t=${encodeURIComponent(token)}` : ''].filter(Boolean).join('&'); return `/api/image/${id}${q ? `?${q}` : ''}` },

  /** 上传 zip(用 XHR 才有上传进度)。 */
  uploadZip(file: File, onProgress: (ratio: number) => void): Promise<ImportResult> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open('POST', '/api/import/zip')
      for (const [k, v] of Object.entries(baseHeaders())) x.setRequestHeader(k, v)
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      x.onerror = () => reject(new ApiError(0, '网络错误,请重试'))
      x.onload = async () => {
        let data: { error?: string } & Partial<ImportResult> = {}
        try { data = JSON.parse(x.responseText) } catch { /* ignore */ }
        if (x.status === 401 && askToken) { await askToken(); return api.uploadZip(file, onProgress).then(resolve, reject) }
        if (x.status !== 200) return reject(new ApiError(x.status, data.error ?? '导入失败'))
        resolve(data as ImportResult)
      }
      x.send(file)
    })
  },

  /** 下载 CSV(带口令头,所以不能直接用 <a href>)。 */
  async download(kind: 'receipts' | 'items', q: ReceiptQuery) {
    const res = await fetch(`/api/export/${kind}.csv${qs({ ...q, lang })}`, { headers: baseHeaders() })
    if (!res.ok) throw new ApiError(res.status, '导出失败')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(await res.blob())
    a.download = kind === 'receipts' ? 'receipts.csv' : 'receipt_items.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  },
}
