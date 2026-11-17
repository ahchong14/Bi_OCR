import { describe, expect, test } from 'bun:test'
import { isIsoDate, parseLooseDate } from '../../web/src/lib/dates'

describe('宽松日期解析(前端输入框用)', () => {
  test('标准写法与常见分隔符', () => {
    expect(parseLooseDate('2018-02-14')).toEqual({ iso: '2018-02-14', assumed: false })
    expect(parseLooseDate('2018/2/4')).toEqual({ iso: '2018-02-04', assumed: false })
    expect(parseLooseDate('14/02/2018')).toEqual({ iso: '2018-02-14', assumed: false }) // 日大于 12,只可能是 日/月/年
    expect(parseLooseDate('02/14/2018')).toEqual({ iso: '2018-02-14', assumed: false }) // 第二位大于 12,只可能是 月/日/年
    expect(parseLooseDate('14.2.18')).toEqual({ iso: '2018-02-14', assumed: false })
  })
  test('日/月都不超过 12 时按日在前理解,并标记为"猜的"', () => {
    expect(parseLooseDate('03/04/2018')).toEqual({ iso: '2018-04-03', assumed: true })
    expect(parseLooseDate('05/05/2018')).toEqual({ iso: '2018-05-05', assumed: false }) // 两种理解一样
  })
  test('不存在的日期和乱写一律拒绝', () => {
    for (const bad of ['31/02/2018', '2018-13-01', '2018-02-30', 'tomorrow', '14-02', '', '2018']) expect(parseLooseDate(bad)).toBeNull()
    expect(isIsoDate('2018-02-14')).toBe(true)
    expect(isIsoDate('2018-2-14')).toBe(false)
    expect(isIsoDate('14/02/2018')).toBe(false)
  })
})
