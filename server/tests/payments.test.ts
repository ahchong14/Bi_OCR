import { describe, expect, test } from 'bun:test'
import { paymentFromText, regexPayment } from '../lib/extract'
import { fromStructured } from '../lib/structured'

// 用户给的这张: 付款方式那一行(CASH RM 50.00)就是实付,CHANGE 是找零;小数点后有空格(27. 00)是常见的 OCR 毛病
const RECEIPT = `Table : T. AWAY 1
ITEM QTY U/P(RM) DISC(%) Amt(RM)
Butter Cream Chicken Rice
3 9. 00 0. 00 27. 00
Sub Total Before Discount RM 27. 00
Service Charge RM 0. 00
Total Sales RM 27. 00
Rounding Adjustment RM 0. 00
TOTAL RM 27. 00
CASH RM 50. 00
CHANGE RM 23. 00`

describe('付款方式行当实付', () => {
  test('CASH RM 50.00 → 实付 50,CHANGE → 找零 23(小数点后带空格也认)', () => {
    expect(paymentFromText(RECEIPT, 27)).toEqual({ paid: 50, change: 23, methods: ['CASH'] })
  })
  test('刷卡/电子钱包: 付款方式行的金额就是实付,没有找零', () => {
    expect(paymentFromText('TOTAL 27.00\nVISA 27.00', 27)).toMatchObject({ paid: 27, change: null, methods: ['VISA'] })
    expect(paymentFromText('TOTAL RM 27.00\nTNG E-WALLET RM 27.00', 27).paid).toBe(27)
    expect(paymentFromText('Total 27.00\nGrabPay 27.00', 27).paid).toBe(27)
    expect(paymentFromText('Total 27.00\nDuitNow QR 27.00', 27).paid).toBe(27)
    expect(paymentFromText('Total 27.00\nTouch \'n Go 27.00', 27).paid).toBe(27)
  })
  test('分开付: 现金 20 + 刷卡 10 = 总额 30 → 实付 30', () => {
    expect(paymentFromText('TOTAL 30.00\nCASH 20.00\nVISA 10.00', 30).paid).toBe(30)
  })
  test('同一行印了两遍(付款明细里又印一次)只算一次,不会翻倍', () => {
    expect(paymentFromText('TOTAL 50.00\nPayment Summary: CASH 50.00\nCASH 50.00\nCHANGE 0.00', 50).paid).toBe(50)
  })
  test('「CASH SALE」「CASHIER」「Card No」不是付款行', () => {
    const t = 'CASH SALE 27.00\nCASHIER 113\nCard No 4111 1111 1111 1111\nTOTAL 27.00'
    expect(paymentFromText(t, 27).paid).toBeNull()
    expect(paymentFromText(t + '\nVISA 27.00', 27).paid).toBe(27)
  })
  test('付款表头那一行(Payment Mode Amount)后面没有金额,不会读出东西', () => {
    expect(paymentFromText('Payment Mode Amount\nTotal 27.00', 27).paid).toBeNull()
  })
  test('regexPayment 的老写法不变', () => {
    expect(regexPayment('CASH 50.00\nCHANGE 19.70')).toEqual({ paid: 50, change: 19.7 })
  })
})

describe('扫描: 模型没读到实付/找零时用转写里的付款行补上', () => {
  const FIELDS = { merchant_name: 'FAMILY RESTAURANT SDN BHD', date: '12/04/2019', currency: 'RM', subtotal: '27.00', tax_amount: '###', total: '27.00', discount_amount: '###', service_charge_amount: '###', rounding_adjustment: '###', amount_paid: '###', change_given: '###' }
  const run = (over: Record<string, unknown> = {}) => fromStructured({ fields: { ...FIELDS, ...over }, items: [], text: RECEIPT, failed: [], ms: 1, provider: 'x' })
  test('实付、找零都补上,并留下「从文字里取的」提示', () => {
    const e = run()
    expect(e.data.paid).toBe(50)
    expect(e.data.change).toBe(23)
    expect(e.reasons).toContain('paid_from_text')
    expect(e.reasons).toContain('change_from_text')
  })
  test('补上之后付款核对能通过(50 − 23 = 27)', () => {
    expect(run().reasons).not.toContain('payment_mismatch')
  })
  test('模型已经读到的实付不会被覆盖', () => {
    const e = run({ amount_paid: '27.00', change_given: '0.00' })
    expect(e.data.paid).toBe(27)
    expect(e.reasons).not.toContain('paid_from_text')
  })
  test('没有整页转写时不补(不凭空造)', () => {
    const e = fromStructured({ fields: FIELDS, items: [], text: '', failed: [], ms: 1, provider: 'x' })
    expect(e.data.paid).toBeNull()
  })
})
