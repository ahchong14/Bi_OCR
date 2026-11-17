import { parseAmount, type AmountError } from '../../../shared/amount'
import type { Lang } from '../../../shared/types'
import type { T } from '../i18n'

let nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 切换语言时按对应地区习惯格式化数字(1,234.56 两种语言一样,但分组与符号随地区)。 */
export function setFormatLocale(lang: Lang) {
  nf = new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf.format(n))
export const moneyC = (n: number | null | undefined, c?: string | null) => (n === null || n === undefined ? '—' : `${c ?? ''} ${nf.format(n)}`.trim())
export const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`)
export const stamp = (s: string | null | undefined) => (s ? s.replace('T', ' ').slice(0, 16) : '—')

/** 审计记录里的系统用户(导入)用语言无关的 'system' 保存;旧数据里是中文"系统",也一并识别。 */
export const isSystemUser = (u: string) => u === 'system' || u === '系统'

/** 小时数 → "12 分钟 / 3.5 小时 / 2 天"。 */
export function duration(h: number | null, t: T): string {
  if (h === null) return '—'
  if (h < 1) return t('an.minutes', { n: Math.max(1, Math.round(h * 60)) })
  if (h < 48) return t('an.hours', { n: h.toFixed(1) })
  return t('an.days', { n: (h / 24).toFixed(1) })
}

/** 解析表单里的金额文本(规则在 shared/amount.ts,与服务端同一份)。空 → null;无法解析 → NaN。 */
export function parseNum(v: string): number | null {
  const r = parseAmount(v)
  return r.ok ? r.value : Number.NaN
}

/** 金额文本有问题时返回原因(格式不对 / 写法有歧义 / 大得不合理),没问题返回 null。 */
export const amountError = (v: string): AmountError | null => { const r = parseAmount(v); return r.ok ? null : r.error }
