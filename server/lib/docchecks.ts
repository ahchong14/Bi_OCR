/**
 * 分类流程用到的纯函数检查(不碰网络、不碰数据库,都有测试)。每一条都对应 P0 在真实接口上看到的一个具体问题:
 *   - evidenceCheck:   模型给的分类证据必须是图上真有的字(能在转写里找到),编造的不算(D5,也挡一部分提示注入);
 *   - isWalkInName:    客户名被读成 "CASH" 这类付款方式 → 当成没有客户;
 *   - sanitizeTitle / sanitizeKeywords: 标题和关键词里不能出现金额、电话、邮箱、长数字(证件 / 银行卡)(C5);
 *   - dateSanity:      日期格式读反(22-04-16 读成 2022-04-16)靠「GST 时代」这类确定性规则兜底;
 *   - idIssues:        税号 / 注册号位数不对(P0 里同一个 12 位 GST 号被读成 13 位、少一位)→ 标「需检查」。
 */
import type { DocParty } from '../../shared/doc'

/** 比较用的规整: 大写、去标点、空白压成一个空格。 */
export const normText = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const LEGAL = /\b(?:SDN|BHD|BERHAD|PLT|LLP|PTE|LTD|INC)\b/g
/** 公司名的匹配键: 规整后去掉 SDN BHD 这类法律后缀。 */
export const partyKey = (name: string | null | undefined): string => normText(name ?? '').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- 证据
export interface EvidenceResult { checked: boolean; found: string[]; missing: string[] }

/** 证据是否出现在整页转写里。规整后做包含比较,再退一步忽略空格(OCR 常把 "TAX INVOICE" 读成 "TAXINVOICE")。没有转写就没法核对(checked = false)。 */
export function evidenceCheck(evidence: string[], transcript: string): EvidenceResult {
  if (!transcript.trim()) return { checked: false, found: [...evidence], missing: [] }
  const t = normText(transcript)
  const tc = t.replace(/ /g, '')
  const found: string[] = []
  const missing: string[] = []
  for (const e of evidence) {
    const n = normText(e)
    if (n.length < 3) { missing.push(e); continue } // 太短的片段("A"、"-")什么也证明不了
    if (t.includes(n) || tc.includes(n.replace(/ /g, ''))) found.push(e)
    else missing.push(e)
  }
  return { checked: true, found, missing }
}

// ---------------------------------------------------------------- 对方名
const WALK_IN = /^(?:CASH(?: SALES?| CUSTOMER| A C| ACCOUNT)?|WALK ?IN(?: CUSTOMER)?|TUNAI|PELANGGAN TUNAI|CUSTOMER|CUST|N ?A|NIL)$/

/** 对方栏读成了付款方式 / 占位词(CASH、WALK-IN、CUSTOMER …)→ 其实没有客户。 */
export const isWalkInName = (name: string | null | undefined): boolean => WALK_IN.test(normText(name ?? ''))

// ---------------------------------------------------------------- 标题和关键词
const CUR_AMOUNT = /\(?(?:\b(?:RM|MYR|SGD|USD|IDR)|S\$|US\$|\$)\s?\d[\d,]*(?:\.\d{1,2})?\)?/gi
const BARE_AMOUNT = /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const URL = /https?:\/\/\S+/gi
const PHONE_LIKE = /(?<![\w-])\+?\d{1,4}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?![\w-])/g
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/

function scrub(s: string): string {
  let t = s.replace(URL, ' ').replace(EMAIL, ' ').replace(CUR_AMOUNT, ' ').replace(BARE_AMOUNT, ' ')
  // 电话 / 长数字: 数字合计 ≥ 9 位才去掉,而且日期(11-04-2018)不能误伤
  t = t.replace(PHONE_LIKE, (m) => (m.replace(/\D/g, '').length >= 9 && !DATE_LIKE.test(m.trim()) ? ' ' : m))
  t = t.replace(/\d{9,}/g, ' ')
  t = t.replace(/\(\s*\)/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,;:\-–—|/]+|[\s,;:\-–—|/]+$/g, '')
  return t.trim()
}

/** 标题 ≤ 80 字符,去掉金额 / 电话 / 邮箱 / 长数字;清洗后太短就用 fallback(由代码拼的)。 */
export function sanitizeTitle(title: string | null | undefined, fallback = ''): string | null {
  const t = scrub(title ?? '')
  const out = t.length >= 3 ? t : scrub(fallback)
  if (!out) return null
  if (out.length <= 80) return out
  const cut = out.slice(0, 80)
  const sp = cut.lastIndexOf(' ')
  return (sp >= 50 ? cut.slice(0, sp) : cut).trim()
}

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** 关键词: 小写、去重、最多 10 个、每个 ≤ 40;丢掉纯数字 / 金额 / 邮箱 / 长数字(除非就是单据号)和证件号。 */
export function sanitizeKeywords(list: readonly string[], opts: { forbidden?: readonly (string | null | undefined)[]; docNo?: string | null } = {}): string[] {
  const forbidden = new Set((opts.forbidden ?? []).filter((x): x is string => !!x).map(alnum).filter(Boolean))
  const docNo = opts.docNo ? alnum(opts.docNo) : ''
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const k = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40).trim()
    if (k.length < 2) continue
    const isDocNo = docNo !== '' && alnum(k) === docNo
    if (!isDocNo && /^[\d\s.,]+$/.test(k)) continue // 纯数字 / 金额(纯数字的单据号除外)
    if (k.includes('@') || /https?:\/\//.test(k)) continue
    if (new RegExp(CUR_AMOUNT.source, 'i').test(k)) continue
    if (/\d{9,}/.test(k) && !isDocNo) continue
    if (forbidden.has(alnum(k))) continue
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= 10) break
  }
  return out
}

// ---------------------------------------------------------------- 日期
const MALAYSIA_HINT = /\bSDN\.?\s*BHD\b|\bRM\s?\d|\bMYR\b|\bMALAYSIA\b|\bSELANGOR\b|\bKUALA\s+LUMPUR\b|\bJOHOR\b|\bPENANG\b/i
const DAY = 86_400_000

/**
 * 日期的确定性合理性检查(不改日期,只给原因代码):
 *   date_in_future        晚于今天 3 天以上;
 *   date_too_old          早于 2000 年;
 *   date_gst_era_mismatch 马来西亚单据印着 GST,而日期不在 GST 时期(2015-04-01 到 2018-12-31;
 *                         P0 里 `22-04-16`(= 2016-04-22)被读成 2022-04-16 就是这样被抓到的)。新加坡等地的 GST 至今有效,所以必须有马来西亚的线索才检查。
 */
export function dateSanity(iso: string | null | undefined, transcript: string, now: Date = new Date()): string[] {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return []
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(t)) return []
  const out: string[] = []
  if (t > now.getTime() + 3 * DAY) out.push('date_in_future')
  if (iso < '2000-01-01') out.push('date_too_old')
  if (/\bGST\b/i.test(transcript) && MALAYSIA_HINT.test(transcript) && (iso < '2015-04-01' || iso > '2018-12-31')) out.push('date_gst_era_mismatch')
  return out
}

// ---------------------------------------------------------------- 税号 / 注册号
/**
 * 位数不对的税号 / 注册号(模型会把长数字多读一位、少读一位)。只拦「肯定不对」的,不认识的格式放过:
 *   税号: 纯数字必须正好 12 位(GST / SST 登记号);字母开头的(TIN: C1234567890、SST: W10-1808-32000123)不检查。
 *   注册号: 纯数字必须正好 12 位(新格式);「数字 + 字母」(1072825-A、1030214K)不检查位数。
 */
export function idIssues(p: Pick<DocParty, 'tax_id' | 'reg_no'> | null | undefined): string[] {
  if (!p) return []
  const out: string[] = []
  const tax = (p.tax_id ?? '').trim()
  if (tax) {
    const s = tax.replace(/[\s-]/g, '')
    if (/^\d+$/.test(s) && s.length !== 12) out.push('tax_id_format')
  }
  const reg = (p.reg_no ?? '').trim()
  if (reg) {
    const s = reg.replace(/[\s-]/g, '')
    if (/^\d+$/.test(s) && s.length !== 12) out.push('reg_no_format')
  }
  return out
}
