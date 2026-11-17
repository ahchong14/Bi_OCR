import { describe, expect, test } from 'bun:test'
import { arbitrateTotal, fromStructured, tidyMerchant } from '../lib/structured'
import { cleanData } from '../lib/clean'

// 阶段 1 的修复: 多税率发票的应付总额、商家名清理、日期兜底、负总额、币种从转写推。
const lines = (...l: string[]) => l.join('\n')
const FIELDS = { merchant_name: 'KEDAI RUNCIT MAJU SDN BHD', date: '15/08/2025', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '30.00', change_given: '3.00' }
const TEXT = lines('KEDAI RUNCIT MAJU SDN BHD', '15/08/2025', 'SUBTOTAL 27.00', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00')
const run = (over: Record<string, unknown> = {}, text = TEXT) => fromStructured({ fields: { ...FIELDS, ...over }, items: [], text, failed: [], ms: 1, provider: 'x' })

describe('多税率发票: 以「应付」标签那一行为准', () => {
  const T = lines('GARDENIA BAKERIES (KL) SDN BHD', 'Date: 21/07/2017', 'Total 6% supplies (Inc. GST): 25.44', 'Total 0% supplies: 7.61', 'Total Payable: 33.05')
  test('模型读成了某个分类小计 → 改成 Total Payable,并记成更正', () => {
    const d = cleanData({ total: 25.44 }, true)
    const r = arbitrateTotal(d, T)
    expect(d.total).toBe(33.05)
    expect(r.fixes).toEqual(['total'])
  })
  test('模型读的本来就是应付额 → 不动', () => {
    const d = cleanData({ total: 33.05 }, true)
    expect(arbitrateTotal(d, T).fixes).toEqual([])
  })
  test('规则总额不在「应付」类标签的行上(普通 Total)、也没有付款行 → 不动', () => {
    const d = cleanData({ total: 25.44 }, true)
    expect(arbitrateTotal(d, lines('SHOP', 'Item 25.44', 'Total: 33.05')).fixes).toEqual([])
    expect(d.total).toBe(25.44)
  })
  test('有付款行、而且和「应付」那一行矛盾 → 不动(付款行存在时走原来的两方一致规则)', () => {
    const d = cleanData({ total: 25.44 }, true)
    expect(arbitrateTotal(d, lines('SHOP', 'Total Payable: 33.05', 'CASH 25.44')).fixes).toEqual([])
  })
})

describe('商家名清理', () => {
  test('去掉括号里的公司注册号', () => {
    expect(tidyMerchant('99 SPEED MART S/B (519537-X)')).toBe('99 SPEED MART S/B')
    expect(tidyMerchant('VIVOPAC MARKETING SDN BHD (1070687-M)')).toBe('VIVOPAC MARKETING SDN BHD')
  })
  test('公司名后面拖着地址 → 截到公司名', () => {
    expect(tidyMerchant('SOON FATT S/B (81497-P) LUT 1504, BATU 8 1/2, JALAN KLANG LAMA, 46000 PETALING JAYA')).toBe('SOON FATT S/B')
    expect(tidyMerchant('AEON CO. (M) BHD (126926-H) 3RD FLR, AEON TAMAN MALURI SC, 55100 KUALA LUMPUR')).toBe('AEON CO. (M) BHD')
  })
  test('正常的名字原样不动(包括 (M)、(KL)、没有公司后缀的)', () => {
    for (const m of ['MR. D.I.Y. (M) SDN BHD', 'GARDENIA BAKERIES (KL) SDN BHD', 'Morganfields®', 'THE COFFEE BEAN & TEA LEAF (M) SDN. BHD.']) expect(tidyMerchant(m)).toBe(m)
  })
  test('扫描: 清理后留下更正记录和原因代码', () => {
    const e = run({ merchant_name: 'KEDAI RUNCIT MAJU SDN BHD (519537-X)' })
    expect(e.data.merchant).toBe('KEDAI RUNCIT MAJU SDN BHD')
    expect(e.reasons).toContain('merchant_tidied')
    expect(e.corrections.some((c) => c.field === 'merchant')).toBe(true)
  })
})

describe('日期: 分隔符整理、转写兜底、不可能的日期', () => {
  test('「05 02-18」「27 03 2018」这种乱分隔符也能读', () => {
    expect(run({ date: '27 03 2018' }, TEXT.replace('15/08/2025', '27/03/2018')).data.date).toBe('2018-03-27')
    expect(run({ date: '05 02-18' }, TEXT.replace('15/08/2025', '05/02/2018')).data.date).toBe('2018-02-05')
  })
  test('模型没读到日期、转写里有 → 用转写里的,记成更正,状态不是基本可信', () => {
    const e = run({ date: '###' })
    expect(e.data.date).toBe('2025-08-15')
    expect(e.reasons).toContain('auto_corrected:date')
    expect(e.corrections.some((c) => c.field === 'date' && c.new === '2025-08-15')).toBe(true)
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('模型和转写里都没有日期 → 仍然缺日期', () => {
    expect(run({ date: '###' }, lines('KEDAI RUNCIT MAJU SDN BHD', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00')).reasons).toContain('missing_date')
  })
  test('早于 2015-04 且转写里提到 GST → 日期不可能', () => {
    const e = run({ date: '17-06-13' }, TEXT.replace('15/08/2025', '17-06-13 GST Summary'))
    expect(e.reasons).toContain('date_implausible')
  })
})

describe('负总额、币种', () => {
  test('总额是负数 → 标记 total_negative', () => {
    const e = run({ total: '-9.62', subtotal: '###', amount_paid: '###', change_given: '###' }, lines('KEDAI RUNCIT MAJU SDN BHD', '15/08/2025', 'Total -9.62'))
    expect(e.reasons).toContain('total_negative')
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('币种栏读成税码(SR)→ 从转写里的 RM 推出 MYR', () => {
    const e = run({ currency: 'SR' }, TEXT.replace('SUBTOTAL 27.00', 'SUBTOTAL RM 27.00'))
    expect(e.data.currency).toBe('MYR')
  })
})

describe('第二轮: 实机 100 张暴露的总额错法', () => {
  test('单独一行 `Due 19.20`、付款 20.00 找零 0.80 → 总额 19.20(模型把实付 20 当成了总额)', () => {
    const d = cleanData({ total: 20 }, true)
    const t = lines('KING S CONFECTIONERY S/B', 'Qty 8 Rounding Adj 19.20', 'Due 19.20', 'Pay 20.00', 'Change 0.80', '(Total Included GST @ 6% : 1.09)')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(19.2)
  })
  test('`Total Amt Payable: 8.50`,「Paid Amount: 100.00」没有找零行 → 现金找零没读到,不算矛盾,采用 8.50', () => {
    const d = cleanData({ total: 8.46 }, true)
    const t = lines('SHOP', 'Total Amt Ind. GST @ 6%: 8.46', 'Rounding Adjustment: (0.02)', 'Total Amt Payable: 8.50', 'Paid Amount: 100.00')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(8.5)
  })
  test('`Total After Adj Incl GST 88.95` 算「应付」标签,而 GST 汇总里的 Total 83.93 不是总额', () => {
    const d = cleanData({ total: 83.93 }, true)
    const t = lines('SHOP', 'Sub-total 88.97', 'Rounding Adj -0.02', 'Total After Adj Incl GST 88.95', 'CASH 100.00', 'GST Summary Amount Tax', 'Total 83.93 5.04')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(88.95)
  })
  test('`TAX TOTAL: 0.69` 不是应付总额: 规则取到 TOTAL 12.15,付款 50.15 找零 38.00 → 12.15', () => {
    const d = cleanData({ total: 12.84 }, true)
    const t = lines('SHOP', 'SUB-TOTAL (GST) 12.19', 'GST 0.69', 'ROUNDING -0.04', 'TOTAL 12.15', 'CASH 50.15', 'CHANGE 38.00', 'TAX TOTAL: 0.69')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(12.15)
  })
})

describe('第三轮: 干净考试(seed 4)暴露的总额错法', () => {
  test('调整单: `Total Payable: -1.73` 是负数,模型读成了正数 → 采用 -1.73(并会因为负总额进审核)', () => {
    const d = cleanData({ total: 1.73 }, true)
    const t = lines('GARDENIA BAKERIES (KL) SDN BHD', 'TAX INVOICE / ADJUSTMENT NOTE', 'Total 6% supplies (Inc. GST): -1.73', 'Total Payable: -1.73')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(-1.73)
  })
  test('`TOTAL (651 INCL) 2.28`(OCR 把 6% 读成 651)规则也能找到总额', async () => {
    const { regexTotal } = await import('../lib/extract')
    expect(regexTotal(lines('SHOP', 'SUBTOTAL 2.28', 'TOTAL (651 INCL) 2.28', 'CASH 3.00', 'CHANGE DUE 0.70'))).toBe(2.28)
  })
  test('模型把实付抄成总额: 总额 10.00 = 实付 10.00,找零 5.00,「实付 − 找零 = 5.00」印在票上 → 5.00', () => {
    const d = cleanData({ total: 10 }, true)
    const t = lines('SHOP', 'Amount Incl. GST 5.00', 'Cash 10.00', 'Change 5.00')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(5)
  })
  test('OCR 把找零读成和实付一样(CHANGE 110.00)→ 差是 0,不能当总额', () => {
    const d = cleanData({ total: 110 }, true)
    expect(arbitrateTotal(d, lines('SHOP', 'SUB-TOTAL 103.77', 'TOTAL CASH 110.00', 'CHANGE 110.00', 'GST 0.00')).fixes).toEqual([])
    expect(d.total).toBe(110)
  })
  test('总额 = 实付但没有找零(刷卡)→ 不动', () => {
    const d = cleanData({ total: 10 }, true)
    expect(arbitrateTotal(d, lines('SHOP', 'Item 10.00', 'Visa 10.00')).fixes).toEqual([])
  })
  test('现金舍入: 印出来的 TOTAL 2.28、实付 − 找零 2.30(MYR 0.05 舍入),模型的总额 2.30 在原文里找不到 → 采用印出来的 2.28', () => {
    const d = cleanData({ total: 2.3, currency: 'MYR' }, true)
    const t = lines('SHOP', 'SUBTOTAL 2.28', 'TOTAL 2.28', 'CASH 3.00', 'CHANGE 0.70')
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(2.28)
  })
})

describe('第四轮: seed 5 暴露的写法', () => {
  test('OCR 把 S/B 读成 5/8 → 还原;括号里重复了前面的词 → 去掉;(M) (KL) 和不相干的括号不动', () => {
    expect(tidyMerchant('99 SPEED MART 5/8')).toBe('99 SPEED MART S/B')
    expect(tidyMerchant('TONYMOLY VIVA CITY (TONYMOLY SHOP)')).toBe('TONYMOLY VIVA CITY')
    for (const m of ['MR. D.I.Y. (M) SDN BHD', 'GARDENIA BAKERIES (KL) SDN BHD', 'MR. D.I.Y. (KUCHAI) SDN BHD', 'THE STORE (SRI HARTAMAS)']) expect(tidyMerchant(m)).toBe(m)
  })
  test('GST 汇总表里的 Total 不是应付总额: 规则先只看汇总表之前', async () => {
    const { regexTotal } = await import('../lib/extract')
    expect(regexTotal(lines('SHOP', 'Total RM : 11.60', 'CASH 12.00', 'GST Summary Amount Tax', 'Total 10.94 0.66'))).toBe(11.6)
    expect(regexTotal(lines('SHOP', 'GST Summary Amount Tax', 'Total 10.94 0.66'))).toBe(10.94) // 汇总表之前找不到,退回全文
  })
})

describe('第五轮: seed 6 暴露的商家误读', () => {
  test('门店代码 `词@词` 粘在公司名前 → 去掉(剩下必须带公司后缀);`NYONYA COLORS @ 1 UTAMA` 之类不动', () => {
    expect(tidyMerchant('JIMART@SP3 OGN GROUP SDN BHD')).toBe('OGN GROUP SDN BHD')
    expect(tidyMerchant('NYONYA COLORS @ 1 UTAMA')).toBe('NYONYA COLORS @ 1 UTAMA')
    expect(tidyMerchant('JIMART@SP3 TRADING')).toBe('JIMART@SP3 TRADING')
  })
  test('模型读到的商家全是小写、转写开头有带公司后缀的名字 → 用转写里的,并记原因;转写里没有公司名 → 不动', () => {
    const T = lines('BOOK TA K (TAMAN DAYA) SDN BHD', '15/08/2025', 'SUBTOTAL 27.00', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00')
    const e = run({ merchant_name: 'tan woon yann' }, T)
    expect(e.data.merchant).toBe('BOOK TA K (TAMAN DAYA) SDN BHD')
    expect(e.reasons).toContain('merchant_from_text')
    expect(e.corrections.some((c) => c.field === 'merchant' && c.old === 'tan woon yann')).toBe(true)
    const e2 = run({ merchant_name: 'tan woon yann' }, lines('hello', '15/08/2025', 'TOTAL 27.00', 'CASH 30.00', 'CHANGE 3.00'))
    expect(e2.data.merchant).toBe('tan woon yann')
    expect(e2.reasons).not.toContain('merchant_from_text')
  })
})

describe('第六轮: seed 7 暴露的总额错法', () => {
  test('`Accepted total 10.00 / Change 5.00 / Amount Incl. GST 5.00`: Accepted total 是收到的现金,不是应付总额 → 总额 5.00', async () => {
    const { regexTotal, paymentFromText } = await import('../lib/extract')
    const t = lines('Dion Realties Sdn Bhd', '010100 Pay parking ticket 5.00 RM', 'Amount Incl. GST 5.00 RM', 'Accepted total 10.00 RM', 'Change 5.00 RM')
    expect(regexTotal(t)).not.toBe(10) // Accepted total 不再被当成应付总额
    expect(paymentFromText(t, 5).paid).toBe(10)
    const d = cleanData({ total: 10 }, true)
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(5)
  })
  test('现金抄成总额、找零版式乱了(`Tendered: RM66.10` 在空的 `Change:` 上面): 「实付 − 总额」印在票上 → 采用规则总额 33.90', () => {
    const t = lines('Kedai Runcit', 'Liquid Medicine RM33.90 x1 RM33.90', 'Total Sales Incl. GST @ 6% RM33.90', 'Cash RM100.00', 'Tendered: RM66.10', 'Change:')
    const d = cleanData({ total: 100, paid: 100 }, true)
    expect(arbitrateTotal(d, t).fixes).toEqual(['total'])
    expect(d.total).toBe(33.9)
  })
  test('总额 = 现金,但「实付 − 规则总额」没有印在票上 → 不动(可能规则才是错的)', () => {
    const d = cleanData({ total: 100, paid: 100 }, true)
    expect(arbitrateTotal(d, lines('SHOP', 'Total Sales Incl. GST @ 6% RM33.90', 'Cash RM100.00')).fixes).toEqual([])
    expect(d.total).toBe(100)
  })
})
