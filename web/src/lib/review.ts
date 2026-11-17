/**
 * 审核页的"该看哪里"规则(纯函数,不依赖界面,可以单独测试)。
 *
 * 背景: 「需检查」的收据以前一次点击就能通过,系统标出来的字段没有任何人必须处理。
 * 这里的规则决定: 哪些提示要求审核员逐项确认、哪些只是提示,以及队列里每一行显示哪几个字段标签。
 */
import type { FieldKey } from '../../../shared/types'

/** 只是提示、不要求逐项确认的原因代码。「商品明细没读出来」在门户扫描的收据里几乎每张都有,逐张确认只会让人麻木。 */
export const SOFT_CODES: ReadonlySet<string> = new Set(['items_not_extracted'])

/** 一条提示里和规则有关的部分(explain() 的返回值满足它)。 */
export interface AlertLike { level: 'warn' | 'info'; code: string; fields: FieldKey[] }

/** 需要审核员确认的字段: 级别是 warn、不是 SOFT 的提示所指向的字段,去重,保持出现顺序。 */
export function fieldsToConfirm(alerts: readonly AlertLike[]): FieldKey[] {
  const out: FieldKey[] = []
  for (const a of alerts) {
    if (a.level !== 'warn' || SOFT_CODES.has(a.code)) continue
    for (const f of a.fields) if (!out.includes(f)) out.push(f)
  }
  return out
}

/**
 * 还没处理的字段 = 需要确认的 − 点过「已核对」的 − 值已经被审核员改过的。
 * 改过值本身就说明看过了(要么改对了,要么确认原值是错的),不必再点一次。
 */
export function pendingConfirm(need: readonly FieldKey[], acked: ReadonlySet<FieldKey>, changed: ReadonlySet<FieldKey>): FieldKey[] {
  return need.filter((f) => !acked.has(f) && !changed.has(f))
}

/** 提示按严重度排序: 需要处理的(warn)在前,说明性的(info)在后;同一级别保持原来的顺序。 */
export function sortAlerts<T extends { level: 'warn' | 'info' }>(alerts: readonly T[]): T[] {
  return [...alerts.filter((a) => a.level === 'warn'), ...alerts.filter((a) => a.level !== 'warn')]
}

/** 队列里一行要显示的字段标签(最多 max 个,多的合并成 +N)。没有指向具体字段的提示返回空数组,界面改显示文字摘要。 */
export function queueTags(alerts: readonly AlertLike[], max = 3): { tags: FieldKey[]; more: number } {
  const all = fieldsToConfirm(alerts)
  return { tags: all.slice(0, max), more: Math.max(0, all.length - max) }
}

/** 更正记录里的值显示成人看的样子: 数字按金额格式(6.6 → 6.60),空值用 empty 文案。 */
export function fmtCorrection(v: unknown, money: (n: number) => string, empty: string): string {
  if (v === null || v === undefined || v === '') return empty
  return typeof v === 'number' ? money(v) : String(v)
}

/** 往表单里恢复原值时用的文本: 数字固定两位小数,与表单里其他金额格式一致。 */
export const restoreText = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : String(v))
