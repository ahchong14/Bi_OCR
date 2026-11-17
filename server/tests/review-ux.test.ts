import { describe, expect, test } from 'bun:test'
import { explain } from '../../web/src/lib/explain'
import { fieldsToConfirm, fmtCorrection, pendingConfirm, queueTags, restoreText, sortAlerts, SOFT_CODES, type AlertLike } from '../../web/src/lib/review'
import type { FieldKey } from '../../shared/types'

const A = (code: string, fields: FieldKey[], level: 'warn' | 'info' = 'warn'): AlertLike => ({ code, fields, level })
const set = (...f: FieldKey[]) => new Set<FieldKey>(f)

describe('哪些字段需要审核员确认', () => {
  test('warn 级别的提示指向的字段需要确认,去重并保持出现顺序', () => {
    const alerts = [A('date_ambiguous', ['date']), A('tax_not_in_text', ['tax']), A('total_conflicts_with_text_rule', ['total']), A('totals_dont_add_up', ['total', 'subtotal', 'tax'])]
    expect(fieldsToConfirm(alerts)).toEqual(['date', 'tax', 'total', 'subtotal'])
  })
  test('info 级别(说明性的)不要求确认', () => {
    expect(fieldsToConfirm([A('card_number_masked', ['merchant'], 'info'), A('rotated', [], 'info')])).toEqual([])
  })
  test('「商品明细没读出来」只是提示,不要求逐项确认(门户扫描几乎每张都有)', () => {
    expect(SOFT_CODES.has('items_not_extracted')).toBe(true)
    expect(fieldsToConfirm([A('items_not_extracted', ['items'])])).toEqual([])
    expect(fieldsToConfirm([A('items_not_extracted', ['items']), A('items_sum_ne_subtotal', ['items'])])).toEqual(['items']) // 但明细对不上是要确认的
  })
  test('没有指向具体字段的提示不产生确认项', () => {
    expect(fieldsToConfirm([A('ocr_bad', []), A('extract_failed', [])])).toEqual([])
  })
})

describe('还有哪些没处理', () => {
  test('点过「已核对」的、值被改过的都算处理了;其余还在待处理', () => {
    const need: FieldKey[] = ['date', 'tax', 'total']
    expect(pendingConfirm(need, set(), set())).toEqual(['date', 'tax', 'total'])
    expect(pendingConfirm(need, set('date'), set())).toEqual(['tax', 'total'])
    expect(pendingConfirm(need, set(), set('tax'))).toEqual(['date', 'total']) // 改过值本身就说明看过了
    expect(pendingConfirm(need, set('date'), set('tax', 'total'))).toEqual([])
  })
  test('点了「已核对」但不在需要确认的列表里,不影响结果', () => {
    expect(pendingConfirm(['date'], set('tax'), set())).toEqual(['date'])
    expect(pendingConfirm([], set(), set())).toEqual([])
  })
})

describe('提示排序和队列标签', () => {
  test('需要处理的(warn)排在说明性的(info)前面,同级别保持原顺序', () => {
    const list = [{ level: 'info' as const, n: 1 }, { level: 'warn' as const, n: 2 }, { level: 'info' as const, n: 3 }, { level: 'warn' as const, n: 4 }]
    expect(sortAlerts(list).map((x) => x.n)).toEqual([2, 4, 1, 3])
    expect(sortAlerts([])).toEqual([])
  })
  test('队列标签: 最多 3 个,多的合并成 +N;没有字段时为空(界面改显示文字摘要)', () => {
    const alerts = [A('date_ambiguous', ['date']), A('totals_dont_add_up', ['total', 'subtotal', 'tax']), A('merchant_unsure', ['merchant'])]
    expect(queueTags(alerts)).toEqual({ tags: ['date', 'total', 'subtotal'], more: 2 })
    expect(queueTags(alerts, 5)).toEqual({ tags: ['date', 'total', 'subtotal', 'tax', 'merchant'], more: 0 })
    expect(queueTags([A('ocr_bad', [])])).toEqual({ tags: [], more: 0 })
  })
})

describe('更正记录的显示格式', () => {
  const money = (n: number) => n.toFixed(2)
  test('数字按金额格式(以前显示成 6.6),空值用文案', () => {
    expect(fmtCorrection(6.6, money, '(empty)')).toBe('6.60')
    expect(fmtCorrection(22, money, '(empty)')).toBe('22.00')
    expect(fmtCorrection(null, money, '(empty)')).toBe('(empty)')
    expect(fmtCorrection('', money, '(empty)')).toBe('(empty)')
    expect(fmtCorrection('abc', money, '(empty)')).toBe('abc')
  })
  test('恢复原值写回表单的文本: 数字固定两位小数', () => {
    expect(restoreText(6.6)).toBe('6.60')
    expect(restoreText('2018-03-20')).toBe('2018-03-20')
  })
})

describe('explain: 自动更正要求确认,并指向被更正的字段', () => {
  const t = ((k: string, p?: Record<string, unknown>) => (k === 'reason.auto_corrected' ? `corrected:${p?.arg}` : k)) as never
  const field = ((k: string) => `F(${k})`) as never
  test('auto_corrected:total,subtotal → warn 级别,字段是 total 和 subtotal(以前是 info 且没有字段)', () => {
    const e = explain('auto_corrected:total,subtotal', t, field)
    expect(e).toMatchObject({ level: 'warn', code: 'auto_corrected', fields: ['total', 'subtotal'], text: 'corrected:F(total) / F(subtotal)' })
  })
  test('被清空的服务费 / 中文字段名也能识别', () => {
    expect(explain('auto_corrected:service_charge', t, field).fields).toEqual(['service_charge'])
    expect(explain('auto_corrected:总额', t, field).fields).toEqual(['total'])
  })
  test('不认识的字段名被忽略,不会冒出奇怪的字段', () => {
    expect(explain('auto_corrected:nonsense,tax', t, field).fields).toEqual(['tax'])
  })
  test('其他提示仍带着归并后的 code;扫描说明仍是 info', () => {
    expect(explain('ocr_too_little_text', t, field).code).toBe('ocr_bad')
    expect(explain('scanned_in_portal', t, field)).toMatchObject({ level: 'info', code: 'scanned_in_portal', fields: [] })
    expect(explain('date_day_month_swapped', t, field)).toMatchObject({ code: 'date_ambiguous', fields: ['date'], level: 'warn' })
    expect(explain('verifier_disagrees:date,total', t, field)).toMatchObject({ code: 'verifier_disagrees', fields: ['date', 'total'] })
  })
})
