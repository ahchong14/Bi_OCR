import { describe, expect, test } from 'bun:test'
import labels from './fixtures/ocrspace-labels.json'
import samples from './fixtures/ocrspace-samples.json'
import { extractFromText, tidyName } from '../lib/extract'
import { similarity, truthAmount, COMPANY_MATCH } from '../lib/truth'

type Sample = { file: string; text: string }
type Label = { company: string; date: string; total: string }
const S = samples as Sample[]
const L = labels as Record<string, Label>

/**
 * 用 Voxel51/scanned_receipts(SROIE)自带的标准答案,逐张核对「提取规则」读对了没有。
 * 这 10 张是真实 OCR.space 的识别文字。注意:样本很小,而且规则是对着其中几张调过的,所以这是回归保护,不是准确率结论。
 */
describe('提取规则 vs 标准答案(10 张真实 OCR 文字)', () => {
  test('总额 10/10 对', () => {
    for (const s of S) expect(extractFromText(s.text).data.total, s.file).toBe(truthAmount(L[s.file]!.total))
  })

  test('商家名: 至少 7/10 与标准答案相似度 ≥ 0.9(整理注册号和公司后缀之后的杂字前是 4/10)', () => {
    const ok = S.filter((s) => similarity(extractFromText(s.text).data.merchant, L[s.file]!.company) >= COMPANY_MATCH)
    expect(ok.length).toBeGreaterThanOrEqual(7)
  })

  test('读错的商家名必须落到「需检查」,不能是「基本可信」(读错了还说可信是最糟的)', () => {
    for (const s of S) {
      const e = extractFromText(s.text)
      if (similarity(e.data.merchant, L[s.file]!.company) < COMPANY_MATCH) expect(e.status, `${s.file} 商家=${e.data.merchant}`).toBe('REVIEW')
    }
  })

  test('注册号括号和公司后缀之后的杂字被去掉', () => {
    expect(tidyName('GARDENIA BAKERIES (KL) SDN BHD (139386 X)')).toBe('GARDENIA BAKERIES (KL) SDN BHD')
    expect(tidyName('AEON CO. (M) BHD (126926-H) N05024')).toBe('AEON CO. (M) BHD')
    expect(tidyName('ANN GIAP TRADING SDN BHD T33L')).toBe('ANN GIAP TRADING SDN BHD')
    expect(tidyName('TONYMOLY VIVA CITY')).toBe('TONYMOLY VIVA CITY') // 没有后缀的店名原样保留
  })
})
