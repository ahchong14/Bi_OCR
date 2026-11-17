import { describe, expect, test } from 'bun:test'
import { cleanData } from '../lib/clean'
import { arbitrateTotal, fromStructured, repairAmounts } from '../lib/structured'

const TEXT = `KEDAI RUNCIT MAJU SDN BHD
15/08/2025
SUBTOTAL 27.00
TOTAL 27.00
CASH 30.00
CHANGE 3.00`
const FIELDS = { merchant_name: 'KEDAI RUNCIT MAJU SDN BHD', date: '15/08/2025', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '30.00', change_given: '3.00' }
const run = (over: Record<string, unknown> = {}, text = TEXT) => fromStructured({ fields: { ...FIELDS, ...over }, items: [], text, failed: [], ms: 1, provider: 'x' })
const data = (o: Record<string, unknown>) => cleanData(o, true)

describe('基线: 一张干净的票自动通过', () => {
  test('字段齐全、付款对得上、转写里都有 → 基本可信', () => {
    const e = run()
    expect(e.status).toBe('AUTO_VERIFIED')
    expect(e.reasons.filter((r) => r !== 'scanned_in_portal' && r !== 'items_not_extracted')).toEqual([])
  })
})

describe('总额仲裁: 转写里「总额」和「付款行」两个独立读数一致,而模型读的不一样', () => {
  const T = 'SHOP SDN BHD\nTotal Incl. of GST 65.72\nRounding Adj -0.02\nTotal After Rounding 65.70\nCASH 65.70'
  test('改用转写里的总额,并记成更正', () => {
    const d = data({ merchant: 'SHOP SDN BHD', total: 65.72 })
    const r = arbitrateTotal(d, T)
    expect(d.total).toBe(65.7)
    expect(r.fixes).toEqual(['total'])
    expect(r.corrections[0]).toMatchObject({ field: 'total', old: 65.72, new: 65.7 })
  })
  test('模型读的本来就对 → 不动', () => {
    const d = data({ total: 65.7 })
    expect(arbitrateTotal(d, T).fixes).toEqual([])
    expect(d.total).toBe(65.7)
  })
  test('只有一个来源(没有付款行),模型的总额也印在票上 → 不动', () => {
    const d = data({ total: 65.72 })
    expect(arbitrateTotal(d, 'SHOP\nSUBTOTAL 65.72\nTOTAL: 65.70').fixes).toEqual([])
    expect(d.total).toBe(65.72)
  })
  test('只有一个来源,但模型的总额在原文里根本找不到(凭空的数)→ 采用规则读到的', () => {
    const d = data({ total: 65.72 })
    expect(arbitrateTotal(d, 'SHOP\nTOTAL: 65.70').fixes).toEqual(['total'])
    expect(d.total).toBe(65.7)
  })
  test('两个来源互相矛盾(总额 65.70、付款算出 60.00)→ 不动', () => {
    const d = data({ total: 65.72 })
    expect(arbitrateTotal(d, 'SHOP\nSUBTOTAL 65.72\nTOTAL: 65.70\nCASH 60.00').fixes).toEqual([])
  })
  test('没有转写 → 不动', () => {
    expect(arbitrateTotal(data({ total: 1 }), '').fixes).toEqual([])
  })
  test('扫描: 模型总额读错,但「转写里的总额」和「付款行」两个独立读数一致 → 改正并记录,证据和一张本来就读对的票一样强,可以基本可信', () => {
    const e = run({ total: '99.99' })
    expect(e.data.total).toBe(27)
    expect(e.status).toBe('AUTO_VERIFIED')
    expect(e.reasons).toContain('auto_corrected:total')
    expect(e.corrections.some((c) => c.field === 'total' && c.old === 99.99 && c.new === 27)).toBe(true)
  })
  test('不是仲裁、而是别的「更正」(没有转写时服务费抄了税额)→ 仍然最高「已更正」,要人确认', () => {
    const e = run({ subtotal: '25.38', tax_amount: '1.62', service_charge_amount: '1.62', total: '27.00' }, '')
    expect(e.reasons).toContain('auto_corrected:service_charge')
    expect(e.status).toBe('CORRECTED')
  })
})

describe('次要字段没有依据 → 清掉(不压低状态)', () => {
  test('转写里没有带「服务费」标签的一行 → 清空,记成 auto_cleared,这张照样自动通过', () => {
    const e = run({ service_charge_amount: '5.57' })
    expect(e.data.service_charge).toBeNull()
    expect(e.reasons).toContain('auto_cleared:service_charge')
    expect(e.reasons.some((r) => r.startsWith('auto_corrected'))).toBe(false)
    expect(e.status).toBe('AUTO_VERIFIED')
    expect(e.corrections.some((c) => c.field === 'service_charge' && c.old === 5.57 && c.new === null)).toBe(true)
  })
  test('转写里有带标签的那一行、金额对得上 → 是真的,保留', () => {
    const e = run({ subtotal: '24.38', service_charge_amount: '2.62', total: '27.00' }, TEXT.replace('SUBTOTAL 27.00', 'SUBTOTAL 24.38\nService Charge 10% 2.62'))
    expect(e.data.service_charge).toBe(2.62)
  })
  test('折扣、舍入同理;几分钱的小数不动(可能是真的现金舍入)', () => {
    expect(run({ discount_amount: '3.00' }).data.discount).toBeNull()
    expect(run({ rounding_adjustment: '1.76' }).data.rounding).toBeNull()
    expect(run({ rounding_adjustment: '0.02' }).data.rounding).toBe(0.02)
  })
  test('没有转写时回到老规则: 只有「抄了别的字段」才清,并且仍按「已更正」处理', () => {
    const r = repairAmounts(data({ subtotal: 20, tax: 1.2, tip: 1.2, total: 21.2 }), '')
    expect(r.d.tip).toBeNull()
    expect(r.fixes).toContain('tip')
    expect(r.cleanups).toEqual([])
  })
  test('税额和总额/小计/实付一样(不可能)→ 清空', () => {
    const e = run({ tax_amount: '27.00' })
    expect(e.data.tax).toBeNull()
    expect(e.reasons).toContain('auto_cleared:tax')
    expect(e.status).toBe('AUTO_VERIFIED')
  })
  test('找零 ≥ 实付(不可能)→ 清空找零,记成清理', () => {
    const r = repairAmounts(data({ total: 29.24, paid: 29.24, change: 29.24 }), '')
    expect(r.d.change).toBeNull()
    expect(r.cleanups).toContain('change')
  })
})

describe('实付/找零: 模型读的对不上、转写里的付款行对得上 → 用转写里的', () => {
  test('模型把实付读成了总额、找零读成了别的数', () => {
    const e = run({ amount_paid: '27.00', change_given: '0.99' })
    expect(e.data.paid).toBe(30)
    expect(e.data.change).toBe(3)
    expect(e.reasons).toContain('paid_from_text')
    expect(e.corrections.some((c) => c.field === 'paid' && c.old === 27 && c.new === 30)).toBe(true)
  })
  test('模型读的已经对得上 → 不动', () => {
    const e = run()
    expect(e.data.paid).toBe(30)
    expect(e.reasons).not.toContain('paid_from_text')
  })
  test('转写里的付款行也对不上总额 → 不动', () => {
    const e = run({ amount_paid: '27.00', change_given: '0.99' }, TEXT.replace('CHANGE 3.00', 'CHANGE 12.00'))
    expect(e.data.paid).toBe(27)
  })
})

describe('日期不可能 / 商家法定名', () => {
  test('票上有 GST 登记号,日期早于 2015-04-01 → 标记(两次读取都读错同一位数也能发现)', () => {
    const e = run({ date: '17-06-13' }, TEXT.replace('15/08/2025', '17-06-13\n(GST ID No :000306020352)'))
    expect(e.reasons).toContain('date_implausible')
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('日期在未来 → 标记', () => {
    const next = new Date().getFullYear() + 1
    expect(run({ date: `15/08/${next}` }, TEXT.replace('15/08/2025', `15/08/${next}`)).reasons).toContain('date_implausible')
  })
  test('没有 GST 登记号的老票不乱标', () => {
    expect(run({ date: '17-06-13' }, TEXT.replace('15/08/2025', '17-06-13')).reasons).not.toContain('date_implausible')
  })
  test('模型读的是品牌名,转写开头是带 SDN BHD 的法定名 → 标记,不自动通过', () => {
    const e = run({ merchant_name: 'MYNEWS' })
    expect(e.reasons).toContain('merchant_legal_name_differs')
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('模型读的本来就带公司后缀 → 不标', () => {
    expect(run().reasons).not.toContain('merchant_legal_name_differs')
  })
})

describe('通过率优化: 评测集上有证据的几条规则', () => {
  test('税额等于找零,而转写里没有带「税」标签的这一行 → 清空税额(清理,不压低状态)', () => {
    const t = 'SHOP SDN BHD\n15/08/2025\nTOTAL 159.00\nCASH 200.00\nCHANGE 41.00'
    const e = run({ subtotal: '###', tax_amount: '41.00', total: '159.00', amount_paid: '200.00', change_given: '41.00' }, t)
    expect(e.data.tax).toBeNull()
    expect(e.reasons).toContain('auto_cleared:tax')
  })
  test('税额等于找零,但转写里确有带「GST」标签的这一行 → 是真的,保留', () => {
    const t = 'SHOP SDN BHD\n15/08/2025\nGST 6% 3.00\nTOTAL 53.00\nCASH 56.00\nCHANGE 3.00'
    const e = run({ subtotal: '50.00', tax_amount: '3.00', total: '53.00', amount_paid: '56.00', change_given: '3.00' }, t)
    expect(e.data.tax).toBe(3)
  })
  test('小计没有依据: 总额有付款佐证、小计+税算不到总额、转写里没有「小计」行 → 清空小计', () => {
    const t = 'SHOP SDN BHD\n15/08/2025\n1 Meat + 3 Veggie 7.10\nAdd Vegetable 0.50\nTotal Amount: $7.60\nGST @6%: $0.43\nNett Total: $7.60\nCASH $7.60\nChange $0.00'
    const e = run({ subtotal: '7.10', tax_amount: '0.43', total: '7.60', amount_paid: '7.60', change_given: '0.00' }, t)
    expect(e.data.subtotal).toBeNull()
    expect(e.reasons).toContain('auto_cleared:subtotal')
  })
  test('小计有「Sub Total」那一行 → 不清(即使算不平,留给对账提示)', () => {
    const t = 'SHOP SDN BHD\n15/08/2025\nSub Total 7.10\nGST 0.43\nTOTAL 7.60\nCASH 7.60'
    const e = run({ subtotal: '7.10', tax_amount: '0.43', total: '7.60', amount_paid: '7.60', change_given: '0.00' }, t)
    expect(e.data.subtotal).toBe(7.1)
  })
  test('舍入只差 1 分钱: 25.44 + 舍入 0.01 = 实付 − 找零 25.45 → 总额改成 25.45', () => {
    const d = data({ total: 25.44, rounding: 0.01, paid: 25.5, change: 0.05 })
    const r = repairAmounts(d, '')
    expect(r.d.total).toBe(25.45)
    expect(r.fixes).toContain('total')
  })
  test('商品行里的合计行(STTL / TOTAL)和重复抄的行(描述里没有字母)被去掉,并留下原因代码', () => {
    const e = fromStructured({
      fields: { ...FIELDS }, text: TEXT, failed: [], ms: 1, provider: 'x',
      items: [
        { description: 'CAFE LATTE', quantity: '1', unit_price: '27.00', amount: '27.00' },
        { description: 'STTL', quantity: '1', unit_price: '27.00', amount: '27.00' },
        { description: '1512 2 10.60', quantity: '2', unit_price: '10.60', amount: '27.00' },
      ],
    })
    expect(e.data.items.map((i) => i.name)).toEqual(['CAFE LATTE'])
    expect(e.reasons).toContain('items_rows_dropped')
  })
  test('含税价的商品行: 单价 65.00 (不含税)、金额 68.90 (含税 ×1.06) 一致,不当成冲突', () => {
    const e = fromStructured({
      fields: { ...FIELDS }, text: TEXT, failed: [], ms: 1, provider: 'x',
      items: [{ description: 'PASIR HALUS', quantity: '1', unit_price: '65.00', amount: '68.90' }],
    })
    expect(e.data.items[0]!.price).toBe(68.9)
    expect(e.reasons).not.toContain('items_amount_recomputed')
  })
  test('商家栏里混进地址(邮编 / 路名 / 太长)→ 当成没取干净,不自动通过', () => {
    const e = run({ merchant_name: 'FRESH MART NO 12 TAMAN BESAR, 46000 PETALING JAYA SELANGOR' })
    expect(e.reasons).toContain('merchant_unsure')
    expect(e.status).not.toBe('AUTO_VERIFIED')
  })
  test('规则找的总额和模型不同,但付款行(实付 − 找零)等于模型的总额、且这个总额印在票上 → 规则是离群的,不算冲突', () => {
    const t = ['SHOP SDN BHD', '15/08/2025', 'Items Total 30.00', 'Total Incl. GST 27.00', 'CASH 30.00', 'CHANGE 3.00', 'Total Qty 30.00'].join('\n')
    const e = run({ total: '27.00' }, t)
    expect(e.reasons).not.toContain('total_conflicts_with_text_rule')
  })
})
