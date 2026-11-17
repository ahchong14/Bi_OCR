import { join, resolve } from 'node:path'
import { createApp } from './app'
import { openDb } from './db'
import { claudeProvider, CLAUDE_DEFAULT_MODEL, type ClaudeEffort } from './lib/claude'
import { classifyOpts } from './lib/classify'
import { envFlag } from './lib/minicpm'
import { ourCompanyOpts, parseOurCompany } from './lib/ourCompany'
import { DOC_TYPES, isDocType, type DocType } from '../shared/doctypes'
import type { OcrProvider } from './lib/ocr'
import { initSecond, secondOpts } from './lib/second'
import { triageOpts } from './lib/extract'
import { hybridOpts } from './lib/hybrid'

/** 配置来源: 命令行参数 > 环境变量 > 默认值。 */
const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const host = flag('host') ?? process.env.HOST ?? '127.0.0.1'
const port = Number(flag('port') ?? process.env.PORT ?? 8080)
const token = flag('token') ?? process.env.PORTAL_TOKEN ?? ''
const root = join(import.meta.dir, '..')
const dataDir = resolve(process.env.PORTAL_DATA ?? join(root, 'data'))
const localOnly = host === '127.0.0.1' || host === 'localhost'

if (!localOnly && !token) {
  console.error('对局域网开放时必须设置口令:  bun run start --host 0.0.0.0 --token 你的口令')
  process.exit(1)
}

// 这份副本的识别器是 Claude(Anthropic API),取代了原来的 MiniCPM-OCR + Qwen + Jev + 第二模型。
//   ANTHROPIC_API_KEY      你自己的 Anthropic 密钥(只放在环境变量里,不要写进代码或截图)。没设就不开扫描,其余功能照常
//   CLAUDE_MODEL           模型,默认 claude-haiku-5-5
//   CLAUDE_EFFORT          思考深度 low(默认)/ medium / high。读票是抄写,low 通常够;读不准的多了再试 medium
//   CLAUDE_THINKING        设成 1 开启自适应思考。默认 0(读票不需要推理,关掉更快更便宜)
//   CLAUDE_FULLTEXT        默认开。多问一次整页转写: 放进审核页的「识别出的原始文字」,并用它交叉验证读到的金额 / 日期(在原文里找不到就标「需检查」)。设成 0 可省一次调用,但失去交叉验证
//   CLAUDE_ITEM_DETAILS    默认开。商品明细多读每行的单位 / 折扣 / 税。设成 0 关掉
//   CLAUDE_TIMEOUT_MS      单次请求超时,默认 120000;CLAUDE_CONCURRENCY 同时识别几张,默认 4;CLAUDE_MAX_EDGE 发送前图片长边像素,默认 1568
//   CLAUDE_CLASSIFY        默认开。一次调用同时判断单据类型(收据 / 发票 / 销售订单 / 报价单 / 送货单 / 贷项通知单 / 其他)、读全部字段、给标题和关键词。设成 0 回到「只读收据字段」
//   CLAUDE_STRUCTURED      默认开。分类用结构化输出(JSON Schema);API 拒绝 Schema 时自动退回仅提示词
//   OUR_COMPANY_NAMES / OUR_COMPANY_REG_NOS / OUR_COMPANY_TAX_IDS   (可选,多个值用 | 隔开)「我方身份」: 用来判断单据是我们开出去的(销售)还是别人开给我们的(采购)。
//                          不配置也能跑 —— 方向保持 unknown(收据除外),开单方和对方照常输出,由调用方决定
//   CLASSIFY_TRUSTED_TYPES 默认 receipt。分类结果被信任到「可以自动放行」的类型(逗号分隔)。其余类型没有真实样本验证过,一律转人工;有了标定数据再放宽
//   CLASSIFY_MIN_CONFIDENCE 默认 0.8。分类把握度低于它就转人工(占位值,要用真实样本标定)
//   TRIAGE_RELAX_DETAIL    默认 1: 总额已被「付款 − 找零」独立印证时,小计 / 税额 / 商品行对不上不再拦人工,收据会带「明细未核对」提示。设成 0 恢复旧行为
// 图片会发送到 Anthropic。PORTAL_SCAN=off 完全关闭扫描(图片不会发给任何第三方)。
const scanOff = (process.env.PORTAL_SCAN ?? '').toLowerCase() === 'off'
const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim()
const effortRaw = (process.env.CLAUDE_EFFORT ?? 'low').trim().toLowerCase()
if (!['low', 'medium', 'high'].includes(effortRaw)) { console.error(`CLAUDE_EFFORT 只能是 low / medium / high,收到: ${effortRaw}`); process.exit(1) }

// 原来那套多模型流程(MiniCPM / Qwen / Jev / 第二读取模型)在这份副本里全部关闭: 入口不再读它们的环境变量,
// 代码还在(测试里用),但没有任何地方会去开它们。shell 里残留的旧变量只会被忽略,这里提醒一句免得误会。
const legacyEnv = ['MINICPM_URL', 'MINICPM2_URL', 'QWEN_URL', 'OCR_SPACE_KEY', 'HYBRID_DETAIL', 'MINICPM_JEV', 'SECOND_MODE'].filter((k) => (process.env[k] ?? '').trim() !== '')
if (legacyEnv.length) console.warn(`提示: 检测到旧的环境变量 ${legacyEnv.join(', ')},这份副本不使用它们(识别只走 Claude)。`)
hybridOpts.enabled = false
ourCompanyOpts.company = parseOurCompany(process.env)
const trustedRaw = (process.env.CLASSIFY_TRUSTED_TYPES ?? 'receipt').split(',').map((x) => x.trim()).filter(Boolean)
const badTrusted = trustedRaw.filter((x) => !isDocType(x))
if (badTrusted.length) { console.error(`CLASSIFY_TRUSTED_TYPES 里有不认识的类型: ${badTrusted.join(', ')}(可用: ${DOC_TYPES.join(', ')})`); process.exit(1) }
classifyOpts.trusted = new Set(trustedRaw as DocType[])
const minConf = process.env.CLASSIFY_MIN_CONFIDENCE === undefined || process.env.CLASSIFY_MIN_CONFIDENCE.trim() === '' ? 0.8 : Number(process.env.CLASSIFY_MIN_CONFIDENCE)
if (!(minConf >= 0 && minConf <= 1)) { console.error('CLASSIFY_MIN_CONFIDENCE 必须是 0 到 1 之间的数'); process.exit(1) }
classifyOpts.minConfidence = minConf
secondOpts.mode = 'off'
secondOpts.upgrade = false
secondOpts.demoteOn = []
secondOpts.qwen = null
triageOpts.relaxDetail = envFlag(process.env.TRIAGE_RELAX_DETAIL, true) // 总额有付款印证时,小计/税额/商品行对不上不再拦(默认开;设 0 恢复旧行为)

let ocr: OcrProvider | null = null
if (!scanOff && apiKey) {
  ocr = claudeProvider({
    apiKey,
    model: process.env.CLAUDE_MODEL?.trim() || CLAUDE_DEFAULT_MODEL,
    effort: effortRaw as ClaudeEffort,
    thinking: envFlag(process.env.CLAUDE_THINKING, false),
    fullText: envFlag(process.env.CLAUDE_FULLTEXT, true),
    classify: envFlag(process.env.CLAUDE_CLASSIFY, true),
    structured: envFlag(process.env.CLAUDE_STRUCTURED, true),
    itemDetails: envFlag(process.env.CLAUDE_ITEM_DETAILS, true),
    timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS) || undefined,
    concurrency: Number(process.env.CLAUDE_CONCURRENCY) || undefined,
    maxEdge: Number(process.env.CLAUDE_MAX_EDGE) || undefined,
  })
}

const db = openDb(dataDir)
const app = createApp({ db, dataDir, token, localOnly, webDir: join(root, 'web-dist'), ocr, ocrSharedKey: false })
const resumed = ocr ? initSecond(db, dataDir, ocr) : 0
app.listen({ port, hostname: host })
console.log(`收据审核门户已启动: http://${localOnly ? '127.0.0.1' : host === '0.0.0.0' ? '本机IP' : host}:${port}   (Ctrl+C 停止)`)
console.log(`数据目录: ${dataDir}`)
if (scanOff) console.log('扫描: 已关闭(PORTAL_SCAN=off)')
else if (!ocr) console.log('扫描: 未开启 —— 没有设置 ANTHROPIC_API_KEY(设置后重启即可;审核、导出等其他功能不受影响)')
else {
  console.log(`扫描: 已开启(${ocr.name},公网 API,图片会发送到 Anthropic)`)
  console.log(`思考深度 ${effortRaw},自适应思考 ${envFlag(process.env.CLAUDE_THINKING, false) ? '开' : '关'};交叉验证(整页转写): ${envFlag(process.env.CLAUDE_FULLTEXT, true) ? '开(每张多问一次模型,读出的金额必须能在原文里找到)' : '关(CLAUDE_FULLTEXT=0): 更快更省,但没有交叉验证'}`)
  console.log(`单据分类: ${envFlag(process.env.CLAUDE_CLASSIFY, true) ? `开(结构化输出 ${envFlag(process.env.CLAUDE_STRUCTURED, true) ? '开' : '关'});信任可自动放行的类型: ${[...classifyOpts.trusted].join(', ') || '无'};把握度低于 ${classifyOpts.minConfidence} 转人工` : '关(CLAUDE_CLASSIFY=0),只读收据字段'}`)
  console.log(`我方身份: ${ourCompanyOpts.company ? `已配置(${ourCompanyOpts.company.names.length} 个名字 / ${ourCompanyOpts.company.regNos.length} 个注册号 / ${ourCompanyOpts.company.taxIds.length} 个税号),可以判断销售 / 采购方向` : '未配置 —— 方向为 unknown(收据除外),开单方和对方照常输出'}`)
  if (resumed) console.log(`上次没做完的 ${resumed} 张已重新入队`)
}
