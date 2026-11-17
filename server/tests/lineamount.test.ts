import { describe, expect, test } from 'bun:test'
import { amountSet, amountWithCode, enrichRows, itemAmountSet, lineAmount, parseTaxCodes, qtyNumber, type ModelItemRow } from '../../shared/items'
import { fromStructured, printedBeforeDiscount } from '../lib/structured'

describe('一行商品的金额: 读到的和 数量 × 单价 对得上就用读到的;没读到就算;对不上看转写里哪个真的印在票上', () => {
  test('读到的金额和 数量 × 单价 一致 → 用读到的,不冲突', () => {
    expect(lineAmount({ quantity: '2', unit_price: '8.50', amount: '17.00' })).toMatchObject({ value: 17, computed: false, conflict: false })
  })
  test('没读到金额 → 用 数量 × 单价 算(折扣前,折扣另列)', () => {
    expect(lineAmount({ quantity: '2', unit_price: '10.00', discount: '1.50', amount: '' })).toMatchObject({ value: 20, computed: true, gross: 20, conflict: false })
  })
  test('读到的金额等于折扣后的数 → 也算对得上(有的票印的是折扣后的金额)', () => {
    expect(lineAmount({ quantity: '2', unit_price: '10.00', discount: '1.50', amount: '18.50' })).toMatchObject({ value: 18.5, computed: false, conflict: false })
  })
  test('对不上且没有转写佐证 → 用算出来的,标冲突', () => {
    expect(lineAmount({ quantity: '2', unit_price: '10.00', amount: '10.00' })).toMatchObject({ value: 20, computed: true, read: 10, conflict: true })
  })
  test('对不上,转写里只有读到的金额印在票上 → 信读到的(数量读错了,例如模型把每一行都读成 2pc)', () => {
    const ev = new Set([2990, 4099]) // 转写里出现过 29.90,没有 59.80
    expect(lineAmount({ quantity: '2', unit_price: '29.90', amount: '29.90 T' }, ev)).toMatchObject({ value: 29.9, computed: false, conflict: true, code: 'T' })
  })
  test('对不上,转写里只有算出来的印在票上 → 用算出来的', () => {
    expect(lineAmount({ quantity: '2', unit_price: '10.00', amount: '10.00' }, new Set([2000]))).toMatchObject({ value: 20, computed: true })
  })
  test('数量读不成数字(1K)→ 用读到的金额,不猜;没有单价退到读到的', () => {
    expect(lineAmount({ quantity: '1K', unit_price: '16.85', amount: '22.91' })).toMatchObject({ value: 22.91, computed: false, conflict: false })
    expect(lineAmount({ quantity: '', unit_price: '5.00', amount: '' }).value).toBe(5)
    expect(lineAmount({}).value).toBeNull()
  })
  test('金额后面跟的税码不挡数字: 2.30 T → 2.30,税码 T', () => {
    expect(amountWithCode('2.30 T')).toEqual({ value: 2.3, code: 'T' })
    expect(amountWithCode('29.90 Z')).toEqual({ value: 29.9, code: 'Z' })
    expect(amountWithCode('5.00 SR')).toEqual({ value: 5, code: 'SR' })
    expect(amountWithCode('RM 5.00')).toEqual({ value: 5, code: null })
    expect(amountWithCode('5.00 RM')).toEqual({ value: 5, code: null })
    expect(amountWithCode('###')).toEqual({ value: null, code: null })
  })
  test('qtyNumber: 2x / 2 pcs / 2pc 取数字,1K 不是数量', () => {
    expect(qtyNumber('2x')).toBe(2)
    expect(qtyNumber('3 pcs')).toBe(3)
    expect(qtyNumber('2pc')).toBe(2)
    expect(qtyNumber('1K')).toBeNull()
  })
  test('amountSet: 转写里的金额(含小数点后带空格的 27. 00)', () => {
    expect(amountSet('TOTAL RM 27. 00\nCASH 50.00\nDisc -0.24').has(2700)).toBe(true)
    expect([...amountSet('a 0.24 b 50.00')].sort((x, y) => x - y)).toEqual([24, 5000])
  })
})

// 用户那张 Popular 的票(转写原文,商品下面一行是 Member Discount,金额后带 T / Z 税码,底部有 GST 汇总)
const POPULAR = `[full text]
POPULAR BOOK
CO. (M) SDN BHD
Description Amount
DOCUMENT HOL A4 1486A-Tra
2pc × 1.15 2.30 T
Member Discount -0.24
PB PVC A4 L-FLD PBA4L25
2pc × 3.90 7.80 T
Member Discount -0.78
Canon Cal AS120V Grey 29.90 T
Member Discount -2.99
Nasi 'APRi6/Seashore [BK] 5.00 Z
Total RM Incl. of GST 40.99
Rounding Adj 0.01
Total RM 41.00
Cash -51.00
CHANGE 10.00
Item Count 6
GST Summary Amount (RM) Tax (RM)
T @ 6% 33.95 2.04
Z @ 0% 5.00 0.00
Total Savings -4.01
BE A POPULAR CARD MEMBER`
const row = (description: string, quantity: string, unit_price: string, amount: string): ModelItemRow => ({ description, quantity, unit_price, amount })

describe('从整页转写补每一行的单位 / 折扣 / 税率(模型默认只问 4 项)', () => {
  test('税率汇总: T @ 6% / Z @ 0% / SR (@ 6%)', () => {
    expect(Object.fromEntries(parseTaxCodes('T @ 6% 33.95 2.04\nZ @ 0% 5.00 0.00'))).toEqual({ T: 6, Z: 0 })
    expect(parseTaxCodes('SR (@ 6%) 62.00 3.72').get('SR')).toBe(6)
  })
  test('单位从数量后缀取(2pc → 数量 2、单位 pc);1K 这种不认识的不拆', () => {
    const r = enrichRows([row('DOCUMENT HOL A4 1486A-Tra', '2pc', '1.15', '2.30 T'), row('KNORR', '1K', '16.85', '22.91')], POPULAR)
    expect(r[0]).toMatchObject({ quantity: '2', uom: 'pc' })
    expect(r[1]).toMatchObject({ quantity: '1K' })
    expect(r[1]!.uom ?? '').toBe('')
  })
  test('税码: 金额后的 T → 6%,Z → 0%(用底部税率汇总对应,不猜)', () => {
    const r = enrichRows([row('DOCUMENT HOL A4 1486A-Tra', '2pc', '1.15', '2.30 T'), row("Nasi 'APRi6/Seashore [BK]", '1', '5.00', '5.00 Z')], POPULAR)
    expect(r.map((x) => x.tax)).toEqual(['6', '0'])
  })
  test('税码在汇总里找不到、也不是明确的零税率代码 → 不填', () => {
    expect(enrichRows([row('X ITEM', '1', '1.00', '1.00 S')], POPULAR + '\n')[0]!.tax ?? '').toBe('')
  })
  test('这一行的折扣: 紧跟在商品下面的 Member Discount 行', () => {
    const r = enrichRows([row('DOCUMENT HOL A4 1486A-Tra', '2pc', '1.15', '2.30 T'), row('PB PVC A4 L-FLD PBA4L25', '2pc', '3.90', '7.80 T'), row('Canon Cal AS120V Grey', '1', '29.90', '29.90 T')], POPULAR)
    expect(r.map((x) => x.discount)).toEqual(['0.24', '0.78', '2.99'])
  })
  test('最后一个商品下面没有折扣行时,不会把汇总里的 Total Savings 当成它的折扣', () => {
    expect(enrichRows([row("Nasi 'APRi6/Seashore [BK]", '1', '5.00', '5.00 Z')], POPULAR)[0]!.discount ?? '').toBe('')
  })
  test('模型已经读到的单位 / 折扣 / 税率不被覆盖;没有整页转写就不补折扣和税率', () => {
    const r = enrichRows([{ ...row('DOCUMENT HOL A4 1486A-Tra', '2pc', '1.15', '2.30 T'), uom: 'box', discount: '9.99', tax: '8' }], POPULAR)[0]!
    expect(r).toMatchObject({ uom: 'box', discount: '9.99', tax: '8' })
    const bare = enrichRows([row('DOCUMENT HOL A4 1486A-Tra', '2pc', '1.15', '2.30 T')], '')[0]!
    expect(bare).toMatchObject({ quantity: '2', uom: 'pc' }) // 单位来自数量后缀,不需要转写
    expect((bare.discount ?? '') + (bare.tax ?? '')).toBe('') // 折扣和税率要靠转写,没有就不补
  })
})

describe('扫描: 商品行入库', () => {
  const F = { merchant_name: 'POPULAR BOOK CO. (M) SDN BHD', date: '27/02/18', currency: 'RM', subtotal: '40.99', tax_amount: '2.04', total: '41.00' }
  const POPULAR_TEXT = POPULAR.replace('[full text]\n', '')
  const run = (line_items: unknown[], text = POPULAR_TEXT) => fromStructured({ fields: F, items: line_items, text, failed: [], ms: 1, provider: 'x' })

  test('单位、折扣、税率都从转写补上;对账对不上折扣时金额不动(票上印的)', () => {
    const e = run([
      { description: 'DOCUMENT HOL A4 1486A-Tra', quantity: '2pc', unit_price: '1.15', amount: '2.30 T' },
      { description: 'Canon Cal AS120V Grey', quantity: '1', unit_price: '29.90', amount: '29.90 T' },
      { description: "Nasi 'APRi6/Seashore [BK]", quantity: '1', unit_price: '5.00', amount: '5.00 Z' },
    ])
    expect(e.data.items).toEqual([
      { name: 'DOCUMENT HOL A4 1486A-Tra', qty: 2, price: 2.3, uom: 'pc', discount: 0.24, taxRate: 6 },
      { name: 'Canon Cal AS120V Grey', qty: 1, price: 29.9, discount: 2.99, taxRate: 6 },
      { name: "Nasi 'APRi6/Seashore [BK]", qty: 1, price: 5, taxRate: 0 },
    ])
  })
  test('模型把每一行数量都读成 2pc: 金额冲突,转写里只有 29.90 → 信读到的金额,并提示', () => {
    const e = run([{ description: 'Canon Cal AS120V Grey', quantity: '2pc', unit_price: '29.90', amount: '29.90 T' }])
    expect(e.data.items[0]!.price).toBe(29.9)
    expect(e.reasons).toContain('items_amount_recomputed')
  })
  test('没有转写、金额读错(读成单价)→ 用算出来的,并提示', () => {
    const e = run([{ description: 'A', quantity: '2', unit_price: '10.00', amount: '10.00' }], '')
    expect(e.data.items[0]!.price).toBe(20)
    expect(e.reasons).toContain('items_amount_recomputed')
  })
  test('数量是 1K → 保留读到的金额,没有提示', () => {
    const e = run([{ description: 'KNORR CHICKEN STOCK', quantity: '1K', unit_price: '16.85', amount: '22.91' }], '')
    expect(e.data.items[0]).toMatchObject({ qty: null, price: 22.91 })
    expect(e.reasons).not.toContain('items_amount_recomputed')
  })
})

describe('数量读错但金额跟着数量一起算错(整张票都读成 2pc)→ 靠整页转写发现', () => {
  const ev = itemAmountSet(POPULAR) // 商品区(第一个 Total 之前)有 29.90、5.00、2.30、7.80,没有 59.80、10.00(10.00 在下面的 CHANGE 行,不算)
  test('金额和 数量 × 单价 一致,但转写里没有这个金额、有单价 → 标冲突(unseen),值不改', () => {
    expect(lineAmount({ quantity: '2pc', unit_price: '29.90', amount: '59.80' }, ev)).toMatchObject({ value: 59.8, conflict: true, unseen: true })
    expect(lineAmount({ quantity: '2pc', unit_price: '5.00', amount: '10.00' }, ev)).toMatchObject({ conflict: true, unseen: true })
  })
  test('真的两件: 金额(2.30)印在转写里 → 不冲突', () => {
    expect(lineAmount({ quantity: '2pc', unit_price: '1.15', amount: '2.30' }, ev)).toMatchObject({ conflict: false, unseen: false })
  })
  test('数量是 1、或没有转写 → 不判', () => {
    expect(lineAmount({ quantity: '1', unit_price: '29.90', amount: '29.90' }, ev).conflict).toBe(false)
    expect(lineAmount({ quantity: '2pc', unit_price: '29.90', amount: '59.80' }).conflict).toBe(false)
  })
})

describe('行金额 = 数量 × 单价 − 折扣(对账引擎裁判)', () => {
  const mk = (fields: Record<string, unknown>, items: unknown[], text = '') => fromStructured({ fields: { merchant_name: 'TONYMOLY VIVA CITY SDN BHD', date: '29/03/2018', currency: 'RM', ...fields }, items, text, failed: [], ms: 1, provider: 'x' })
  test('票上印折扣前金额、折扣另算(含税价): 合计 − 折扣才对得上总额 → 金额减去折扣', () => {
    // 69.90 − 20.97 = 48.93(含税)+ 舍入 0.02 = 48.95
    const e = mk({ total: '48.95', rounding_adjustment: '0.02', tax_amount: '2.77', subtotal: '46.16', amount_paid: '48.95' },
      [{ description: 'WONDER CHEESE FIRMING CREAM EAC [SR]', quantity: '1', unit_price: '69.90', amount: '69.90', discount: '20.97' }])
    expect(e.data.items[0]).toMatchObject({ qty: 1, price: 48.93, discount: 20.97 })
    expect(e.reasons).not.toContain('items_sum_ne_subtotal')
  })
  test('票上印的已经是折扣后的金额(合计直接对得上): 金额不动,不会减两次', () => {
    const e = mk({ total: '47.70', subtotal: '47.70' }, [{ description: 'HERBY PIPA GAO', quantity: '2', unit_price: '26.50', amount: '47.70', discount: '5.30' }])
    expect(e.data.items[0]!.price).toBe(47.7)
  })
  test('折扣已经单独成了一行(Item promo −3.86): 这一行上重复记录的折扣去掉', () => {
    const e = mk({ total: '11.13', subtotal: '11.13' }, [
      { description: 'PREMIER 4X200S', quantity: '1', unit_price: '14.99', amount: '14.99', discount: '3.86' },
      { description: 'Item promo @10', quantity: '1', unit_price: '-3.86', amount: '-3.86' },
    ])
    expect(e.data.items[0]!.price).toBe(14.99)
    expect(e.data.items[0]!.discount).toBeUndefined()
  })
})

describe('行金额: 小计读错时也能判断票上印的是折扣前', () => {
  const base = { merchant: 'X', date: '2018-03-29', currency: 'MYR', subtotal: 48.95 /* 读成了总额 */, discount: 20.97, service_charge: null, tax: 2.77, tip: null, fees: null, rounding: 0.02, total: 48.95, paid: 48.95, change: null }
  test('各行金额 − 折扣 = 总额 − 舍入(含税价)→ 折扣前', () => {
    expect(printedBeforeDiscount({ ...base, items: [{ name: 'WONDER CHEESE', qty: 1, price: 69.9, discount: 20.97 }] })).toBe(true)
  })
  test('各行金额本身就对得上 → 已经是折扣后,不动', () => {
    expect(printedBeforeDiscount({ ...base, subtotal: 47.7, total: 47.7, rounding: null, tax: null, items: [{ name: 'HERBY', qty: 2, price: 47.7, discount: 5.3 }] })).toBe(false)
  })
  test('没有行折扣 → 不动', () => {
    expect(printedBeforeDiscount({ ...base, items: [{ name: 'A', qty: 1, price: 48.93 }] })).toBe(false)
  })
})
