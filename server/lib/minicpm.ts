/**
 * MiniCPM-OCR 识别服务(llama.cpp 的 llama-server / vLLM 等提供的 OpenAI 兼容接口)。
 *
 * 和 OCR.space 的区别: 这里是多模态模型,可以直接问"商家、日期、金额是什么",不需要先转成文字再用规则猜,
 * 所以实现了 extract()(结构化识别),商品明细也能读。recognize() 只是备用(整页转写)。
 *
 * 部署位置不限: 本机、内网的 GPU 机器、NAS,或者(测试时)通过隧道指向 Kaggle。门户只认一个地址 MINICPM_URL。
 * 地址不在本机/内网时必须是 https,并且应当设置 --api-key,否则任何人都能用你的 GPU。
 */
import sharp from 'sharp'
import { OcrError, type JevMode, type JevScore, type OcrResult, type StructuredOutput, type StructuredProvider } from './ocr'
import { extractFromText } from './extract'
import { CORE_FIELDS, EXTRA_FIELDS } from './structured'
import { parseItemLines, salvageLineItems } from '../../shared/items'

export interface MiniCpmOptions {
  baseUrl: string
  apiKey?: string
  /** 服务端注册的模型名(llama-server 的 --alias),默认 minicpm-ocr。 */
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 发送前把长边缩到这个像素数(收据是小字,2400 足够,更大只会更慢)。 */
  maxEdge?: number
  /** 额外多问一次"整页文字",放进审核页的原始文字(审核员可以点里面的数字填进金额格)。多一次调用,默认关。 */
  fullText?: boolean
  concurrency?: number
  /** Jev 验证器(Kaggle 笔记本的网关提供 POST /jev/score,和 OCR 用同一个地址、同一个密钥)。需要 fullText(用整页转写打分)。 */
  jev?: JevMode
  jevTimeoutMs?: number
  /** 第二个读取模型(另一个 OpenAI 兼容服务,例如 Kaggle 上的 GLM-OCR)。每张收据用同样的提问再读一遍,
   *  结果存进原始文字的 [second …] 段,审核页把两个模型的读数并排给审核员选。第二个模型出错不影响第一个。 */
  second?: { baseUrl: string; apiKey?: string; model?: string; timeoutMs?: number
    /** all(默认,老行为)= 每张收据扫描时同时多读一遍;flagged / off = 扫描时不读,由「第二意见」队列只对不确定的收据调用 readSecond()。 */
    mode?: 'off' | 'flagged' | 'all'
    /** 第二个读取模型的种类。glm(默认)= GLM-OCR,按提示词直接输出 JSON 字段;paddle = PaddleOCR-VL,只能用固定提示词 "OCR:" 做整页转写,
     *  字段由门户用文字规则(extractFromText)从转写里抽出来,不会有「按提示词输出 JSON」这回事。 */
    kind?: 'glm' | 'paddle' }
}

// ---------------------------------------------------------------- 地址
const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/
/** 是不是本机或内网地址(图片不会经过公网)。不认识的一律当公网。 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) // IPv6: 回环、唯一本地、链路本地
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.test(h)
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || !h.includes('.') // 'nas' 这类无点主机名
}

/** 校验并规整 MINICPM_URL: 只认 http(s);非内网必须 https;不允许地址里带账号密码;去掉末尾的 / 和 /v1。 */
export function parseBaseUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error(`MINICPM_URL 不是有效的网址: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('MINICPM_URL 只支持 http:// 或 https://')
  if (u.username || u.password) throw new Error('MINICPM_URL 里不要带账号密码,请用 MINICPM_KEY')
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) throw new Error('MINICPM_URL 指向公网地址时必须使用 https://(否则图片和密钥会明文经过公网)')
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  u.search = ''
  u.hash = ''
  return u
}

// ---------------------------------------------------------------- 提示词(格式照官方 README 的 KIE 写法)
const kie = (fields: readonly string[]) => {
  const q = fields.map((f) => `"${f}"`).join(', ')
  return `Extract the ${q}. Format the output as a JSON object with keys: ${q}. If an item is not in the image, use "###".`
}
/** 字段分成两组问: 一次问太多相近的字段(服务费/舍入/合计)小模型会串位,分开问更稳。 */
export const CORE_PROMPT = kie(CORE_FIELDS)
export const EXTRA_PROMPT = kie(EXTRA_FIELDS)
export const ITEMS_PROMPT =
  'Extract all purchased line items from the receipt. Format the output as a JSON object with the single key "line_items", ' +
  'whose value is a list of objects with keys: "description", "quantity", "unit_price", "amount". If an item is not in the image, use "###".'
/** 明细「加详情」版: 在原来 4 项后面多问每行的单位(uom)和这一行自己的折扣(discount)。新键只放在最后,原来 4 项的顺序不变(坏 JSON 抢救还能用)。
 *  默认不开(环境变量 MINICPM_ITEM_DETAILS=on 才用): 多问两项会不会影响原来 4 项的准确率,要在真实收据上对比过再决定。 */
export const ITEMS_PROMPT_DETAIL =
  'Extract all purchased line items from the receipt. Format the output as a JSON object with the single key "line_items", ' +
  'whose value is a list of objects with keys: "description", "quantity", "unit_price", "amount", "uom", "discount", "tax". ' +
  '"uom" is the unit of measure printed for the item (e.g. pcs, kg, box); "discount" is a discount printed on that item\'s own line; "tax" is the tax rate or tax code printed on that item\'s line (e.g. 6%, SR, ZRL). ' +
  'If an item is not in the image, use "###".'
const itemsPrompt = () => (envFlag(process.env.MINICPM_ITEM_DETAILS, false) ? ITEMS_PROMPT_DETAIL : ITEMS_PROMPT)
/** 第一次明细没读出来时的重扫提示词: 换成每行一个商品、用 | 分隔的纯文本,
 *  不依赖 JSON,商品名里有引号/括号也不会把格式弄坏。(温度≈0,同一个提示词重问只会得到同样的输出,所以必须换问法。) */
export const ITEMS_RETRY_PROMPT =
  'List every purchased line item on the receipt, one item per line, in the format: description | quantity | unit_price | amount. ' +
  'Do not include totals, tax or payment lines. If a value is missing use ###.'
const TEXT_PROMPT = 'Text Recognition:'

/** 读环境变量里的开关: 没设(或空)就用默认值;1/on/true/yes 为开,其余为关。 */
export const envFlag = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v.trim() === '' ? dflt : ['1', 'on', 'true', 'yes'].includes(v.trim().toLowerCase())

/** 从模型回复里取出 JSON 对象(容忍 ```json 围栏和前后多余文字)。不是对象就返回 null。 */
export function parseJsonObject(s: string): Record<string, unknown> | null {
  const t = s.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '')
  const i = t.indexOf('{'), j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    const v = JSON.parse(t.slice(i, j + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { return null }
}

// salvageLineItems / parseItemLines 在 shared/items.ts(审核页的明细表格也用同一份解析)
export { parseItemLines, salvageLineItems }

/** 只拷贝约定好的字段名: 模型(或图片里的恶意文字)多塞的键一律忽略。 */
function pick(src: Record<string, unknown> | null, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (src) for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]
  return out
}

// ---------------------------------------------------------------- 服务
export function miniCpmProvider(opts: MiniCpmOptions): StructuredProvider {
  const base = parseBaseUrl(opts.baseUrl)
  const f = opts.fetchImpl ?? fetch
  const model = opts.model || 'minicpm-ocr'
  const timeoutMs = opts.timeoutMs ?? 180_000 // 免费 GPU 上第一次请求要预热,别设太短
  const maxEdge = opts.maxEdge ?? 2400
  const endpointOf = (b: URL) => `${b.origin}${b.pathname === '/' ? '' : b.pathname}/v1/chat/completions`
  const endpoint = endpointOf(base)
  type Target = { endpoint: string; apiKey?: string; model: string; timeoutMs: number }
  const primary: Target = { endpoint, apiKey: opts.apiKey, model, timeoutMs }
  const secondBase = opts.second ? parseBaseUrl(opts.second.baseUrl) : null
  const secondTarget: Target | null = secondBase && opts.second
    ? { endpoint: endpointOf(secondBase), apiKey: opts.second.apiKey, model: opts.second.model || (opts.second.kind === 'paddle' ? 'paddleocr-vl' : 'glm-ocr'), timeoutMs: opts.second.timeoutMs ?? timeoutMs }
    : null

  /** 发送前处理: 按 EXIF 转正、长边缩到 maxEdge、统一成 JPEG。原图不受影响(门户保存的是上传的原文件)。 */
  async function toDataUrl(image: Uint8Array): Promise<string> {
    try {
      const out = await sharp(Buffer.from(image), { failOn: 'none' }).rotate()
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
      return 'data:image/jpeg;base64,' + out.toString('base64')
    } catch {
      throw new OcrError('NO_TEXT', 'unreadable image', false) // 图片损坏: 照样入库让员工手填
    }
  }

  async function chat(dataUrl: string, prompt: string, maxTokens: number, target: Target = primary): Promise<string> {
    const body = {
      model: target.model,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: prompt }] }],
      temperature: 0.01, top_p: 0.001, max_tokens: maxTokens,
    }
    let res: Response
    try {
      res = await f(target.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(target.timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new OcrError('TIMEOUT', 'model timed out', true)
      throw new OcrError('NETWORK', e instanceof Error ? e.message : 'network error', true)
    }
    if (res.status === 401 || res.status === 403) throw new OcrError('AUTH', `HTTP ${res.status}`, false)
    if (res.status === 413) throw new OcrError('TOO_BIG', `HTTP ${res.status}`, false)
    if (res.status === 429) throw new OcrError('RATE_LIMIT', `HTTP ${res.status}`, false)
    // 出错时把服务端回的说明(llama-server 会写明原因,比如上下文超长、图片解码失败)带进错误信息,只用于服务器日志,界面不显示
    const why = async () => { try { return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300) } catch { return '' } }
    if (res.status >= 500) throw new OcrError('UPSTREAM', `HTTP ${res.status} ${await why()}`.trim(), true) // 含 llama-server 加载中的 503、隧道断开时 Cloudflare 的 530
    if (!res.ok) throw new OcrError('UPSTREAM', `HTTP ${res.status} ${await why()}`.trim(), false)
    let j: { choices?: { message?: { content?: unknown } }[] }
    try { j = (await res.json()) as typeof j } catch { throw new OcrError('UPSTREAM', 'bad response', true) }
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new OcrError('UPSTREAM', 'no content in response', true)
    return content
  }

  return {
    name: `minicpm-ocr@${base.host}`,
    maxBytes: 20 * 1024 * 1024,
    local: isLocalHost(base.hostname) && (!secondBase || isLocalHost(secondBase.hostname)),
    concurrency: opts.concurrency ?? 1, // 单卡单路: 同时发多张只会在对方排队、容易超时
    jevMode: opts.jev ?? 'off',
    async verify(image, transcript): Promise<JevScore | null> {
      // 打分失败(网关没开 Jev、超时、网络断了)一律返回 null: 验证器只是辅助信息,不能让扫描失败
      const text = transcript.trim().slice(0, 20_000)
      if (!text) return null
      try {
        const dataUrl = await toDataUrl(image)
        const res = await f(`${base.origin}${base.pathname === '/' ? '' : base.pathname}/jev/score`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
          body: JSON.stringify({ image: dataUrl.slice(dataUrl.indexOf(',') + 1), text }),
          signal: AbortSignal.timeout(opts.jevTimeoutMs ?? 120_000),
        })
        if (!res.ok) { console.warn(`[jev] 打分失败: HTTP ${res.status}(网关没开 Jev?)`); return null }
        const j = (await res.json()) as { score?: unknown; verdict?: unknown }
        const verdict = typeof j.verdict === 'string' ? j.verdict.slice(0, 40) : 'unknown'
        const score = typeof j.score === 'number' && Number.isFinite(j.score) ? j.score : null
        return { score: verdict === 'scored' ? score : null, verdict }
      } catch (e) {
        console.warn(`[jev] 打分失败: ${e instanceof Error ? e.message : e}`)
        return null
      }
    },
    async readSecond(image): Promise<StructuredOutput | null> {
      if (!secondTarget) return null
      const t0 = performance.now()
      const url = await toDataUrl(image)
      if (opts.second?.kind === 'paddle') {
        // PaddleOCR-VL: 一次 "OCR:" 整页转写 → 文字规则抽字段(商家取首行公司名、日期、总额、小计、税额、付款、找零、商品行)
        let text = ''
        try { text = (await chat(url, 'OCR:', 4096, secondTarget)).trim() } catch (e) { console.warn(`[second] OCR 失败: ${e instanceof Error ? e.message : e}`); return null }
        if (!text) return null
        const d = extractFromText(text).data
        const s = (n: number | null) => (n === null ? '###' : n.toFixed(2))
        const fields: Record<string, unknown> = {
          merchant_name: d.merchant ?? '###', date: d.date ?? '###', currency: d.currency ?? '###', subtotal: s(d.subtotal), tax_amount: s(d.tax), total: s(d.total),
          discount_amount: s(d.discount), service_charge_amount: s(d.service_charge), rounding_adjustment: s(d.rounding), amount_paid: s(d.paid), change_given: s(d.change),
        }
        const items = d.items.map((i) => ({ description: i.name, quantity: i.qty, amount: i.price }))
        return { fields, items, text, failed: [], answers: [{ name: 'second_core', raw: JSON.stringify(fields) }, { name: 'second_items', raw: JSON.stringify({ line_items: items }) }], ms: Math.round(performance.now() - t0), provider: 'paddleocr-vl' }
      }
      const failed: string[] = []
      const answers: { name: string; raw: string }[] = []
      const rawByName: Record<string, string> = {}
      const ask = async (name: string, prompt: string, tokens: number) => {
        try {
          const raw = await chat(url, prompt, tokens, secondTarget)
          rawByName[name] = raw
          answers.push({ name: `second_${name}`, raw: raw.trim().slice(0, 2000) })
          const j = parseJsonObject(raw)
          if (!j) failed.push(name)
          return j
        } catch (e) { failed.push(name); console.warn(`[second] ${name} 失败: ${e instanceof Error ? e.message : e}`); return null }
      }
      const core = await ask('core', CORE_PROMPT, 1024)
      const extra = await ask('extra', EXTRA_PROMPT, 512)
      const itemsJson = await ask('items', itemsPrompt(), 3072)
      if (!core && !extra) return null // 表头一个字段都没读到: 没有可比较的第二份读数
      let text = ''
      try { text = (await chat(url, TEXT_PROMPT, 4096, secondTarget)).trim() } catch { /* 转写只是给 Jev / Qwen 用的辅助信息 */ }
      let lines = itemsJson?.line_items
      if (!Array.isArray(lines)) { const salvaged = salvageLineItems(rawByName.items ?? ''); if (salvaged.length) lines = salvaged }
      return { fields: { ...pick(core, CORE_FIELDS), ...pick(extra, EXTRA_FIELDS) }, items: Array.isArray(lines) ? lines : [], text, failed, answers, ms: Math.round(performance.now() - t0), provider: 'glm-ocr' }
    },
    async recognize(image): Promise<OcrResult> {
      const t0 = performance.now()
      const text = (await chat(await toDataUrl(image), TEXT_PROMPT, 4096)).trim()
      if (!text) throw new OcrError('NO_TEXT', 'no text recognised', false)
      return { text, ms: Math.round(performance.now() - t0), provider: 'minicpm-ocr' }
    },
    async extract(image): Promise<StructuredOutput> {
      const t0 = performance.now()
      const url = await toDataUrl(image)
      // 第二个读取模型和第一个同时开始(通常在另一张卡/另一个服务上),出错一律吞掉: 它只是多一份参考。
      const secondRun = secondTarget && opts.second?.kind !== 'paddle' && (opts.second?.mode ?? 'all') === 'all' ? (async () => {
        const out: { name: string; raw: string }[] = []
        const tm: Record<string, number> = {}
        for (const [name, prompt, tokens] of [['second_core', CORE_PROMPT, 1024], ['second_extra', EXTRA_PROMPT, 512], ['second_items', itemsPrompt(), 3072]] as const) {
          const t = performance.now()
          try { out.push({ name, raw: (await chat(url, prompt, tokens, secondTarget)).trim().slice(0, 2000) }) } catch (e) { console.warn(`[second] ${name} 失败: ${e instanceof Error ? e.message : e}`) }
          tm[name] = Math.round((performance.now() - t) / 10) / 100
        }
        return { out, tm }
      })() : null
      const failed: string[] = []
      const answers: { name: string; raw: string }[] = []
      const timing: Record<string, number> = {}
      const rawByName: Record<string, string> = {} // 完整原文(answers 里只存前 2000 字符,兜底解析要用完整的)
      const secs = (since: number) => Math.round((performance.now() - since) / 10) / 100 // 秒,保留两位
      const ask = async (name: string, prompt: string, tokens: number) => {
        const t = performance.now()
        const raw = await chat(url, prompt, tokens)
        rawByName[name] = raw
        timing[name] = secs(t)
        answers.push({ name, raw: raw.trim().slice(0, 2000) })
        const j = parseJsonObject(raw)
        if (!j) failed.push(name)
        return j
      }
      const core = await ask('core', CORE_PROMPT, 1024)
      const extra = await ask('extra', EXTRA_PROMPT, 512)
      const itemsJson = await ask('items', itemsPrompt(), 3072)
      if (!core && !extra && !itemsJson) {
        // 日志里能看到模型到底回了什么(截断),方便判断是提示词、图片还是服务的问题
        throw new OcrError('NO_TEXT', `model returned no parseable JSON: ${answers.map((a) => a.raw.slice(0, 120)).join(' | ')}`, false)
      }

      let text = ''
      if (opts.fullText) {
        const t = performance.now()
        try { text = (await chat(url, TEXT_PROMPT, 4096)).trim() } catch { /* 只是辅助信息,失败不影响字段 */ }
        timing.text = secs(t)
      }
      let lines = itemsJson?.line_items
      if (!Array.isArray(lines)) {
        // 模型输出了明细但 JSON 不合法(多半是商品名里有没转义的引号)时,把能抓到的行救回来。
        // failed 里仍保留 'items',这张会被标成"只读到一部分",由员工对照原图确认。
        const salvaged = salvageLineItems(rawByName.items ?? '')
        if (salvaged.length) lines = salvaged
      }
      if (!Array.isArray(lines) || lines.length === 0) {
        // 还是一行都没有: 换成纯文本逐行的问法重扫一次(最多一次)。重扫失败不影响已有字段。
        // 即使重扫成功也保留 failed 里的 'items',这张仍交给员工对照原图确认。
        try {
          const t = performance.now()
          const raw = await chat(url, ITEMS_RETRY_PROMPT, 3072)
          timing.items_retry = secs(t)
          answers.push({ name: 'items_retry', raw: raw.trim().slice(0, 2000) })
          const retried = parseItemLines(raw)
          if (retried.length) lines = retried
        } catch { /* 辅助步骤 */ }
      }
      const second = secondRun ? await secondRun : null
      if (second) { answers.push(...second.out); Object.assign(timing, second.tm) }
      timing.total = secs(t0)
      return {
        fields: { ...pick(core, CORE_FIELDS), ...pick(extra, EXTRA_FIELDS) },
        items: Array.isArray(lines) ? lines : [],
        text,
        failed,
        answers,
        timing,
        ms: Math.round(performance.now() - t0),
        provider: 'minicpm-ocr',
      }
    },
  }
}
