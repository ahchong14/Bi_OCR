/**
 * v2 示例夹具: 首版 8 个类型各一份「入库用的结果」(和 /api/import/json、扫描入库用的是同一个形状)。
 * 数值是演示用的,但每一份的金额都是自洽的(小计 + 税 + 舍入 = 总额;商品行合计 = 小计),所以对账不会报错。
 * 方向约定(D2): 旧列 merchant 永远是「对方」—— 采购类取开单方,销售类取客户,收据取商家。
 */
import type { PipelineStatus } from '../../../shared/types'
import { emptyData } from '../../lib/clean'

const party = (name: string, extra: Record<string, string | null> = {}) => ({
  name_as_printed: name, name_normalized: name.toLowerCase().replace(/\b(sdn\.?\s*bhd\.?|bhd\.?)\b/g, '').replace(/\s+/g, ' ').trim(),
  reg_no: null, tax_id: null, address: null, phone: null, email: null, ...extra,
})
const blankHeader = { doc_no: null, due_date: null, valid_until: null, reference: null, customer_po_no: null, terms: null, supplier_invoice_no: null, delivery_address: null }
const noPayment = { method: null, reference: null, card_last4: null }
const noRel = { original_invoice_no: null, related_po_no: null, related_so_no: null, related_do_no: null, reason: null }

export interface Fixture { file: string; status: PipelineStatus; reasons: string[]; data: ReturnType<typeof emptyData>; ocr_text: string; doc: Record<string, unknown> }

const fx = (f: Fixture): Fixture => f
const OUR = 'OUR TRADING SDN BHD'

export const FIXTURES: Record<string, Fixture> = {
  receipt: fx({
    file: 'receipt-0007.jpg', status: 'AUTO', reasons: [],
    data: { ...emptyData(), merchant: 'SYARIKAT RUNCIT MAJU SDN BHD', date: '2025-08-15', currency: 'MYR', subtotal: 26.2, tax: 1.57, rounding: -0.03, total: 27.74, paid: 30, change: 2.26,
      items: [{ name: 'GARDENIA BREAD', qty: 2, price: 8.4 }, { name: 'MILO 1KG', qty: 1, price: 17.8 }] },
    ocr_text: 'SYARIKAT RUNCIT MAJU SDN BHD\nCASH 30.00\nCHANGE 2.26',
    doc: {
      prompt_version: 'fx-1', direction: 'purchase', title: 'SYARIKAT RUNCIT MAJU 收据(2025-08-15)RM 27.74', keywords: ['syarikat runcit maju', 'groceries', 'cash'], language: 'ms',
      classification: { document_type: 'receipt', confidence: 0.94, alternatives: [{ document_type: 'sales_invoice', confidence: 0.03 }], evidence: ['CASH', 'CHANGE'], title_printed: null, type_verdict: 'unverified' },
      header: blankHeader, parties: { issuer: party('SYARIKAT RUNCIT MAJU SDN BHD'), counterparty: null }, payment: { method: 'cash', reference: null, card_last4: null }, relations: noRel,
    },
  }),
  sales_invoice: fx({
    file: 'iv-2001.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    data: { ...emptyData(), merchant: 'XYZ SDN BHD', date: '2026-11-10', currency: 'MYR', subtotal: 1000, tax: 60, total: 1060,
      items: [{ name: 'A4 PAPER 80GSM', qty: 10, price: 1000, uom: 'BOX' }] },
    ocr_text: 'TAX INVOICE\nOUR TRADING SDN BHD\nBill To: XYZ SDN BHD\nTerms: Net 30',
    doc: {
      prompt_version: 'fx-1', direction: 'sales', title: 'XYZ SDN BHD 销售发票 IV-2001(2026-11-10)', keywords: ['xyz', 'iv-2001', 'a4 paper', 'net 30'], language: 'en',
      classification: { document_type: 'sales_invoice', confidence: 0.96, alternatives: [], evidence: ['TAX INVOICE', 'Bill To'], title_printed: 'TAX INVOICE', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'IV-2001', due_date: '2026-12-10', terms: 'Net 30', customer_po_no: 'PO-7001' },
      parties: { issuer: party(OUR, { reg_no: '201901000001' }), counterparty: party('XYZ SDN BHD') }, payment: noPayment, relations: noRel,
    },
  }),
  purchase_invoice: fx({
    file: 'pi-1023.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    data: { ...emptyData(), merchant: 'ACME TRADING SDN BHD', date: '2026-11-10', currency: 'MYR', subtotal: 1000, tax: 60, total: 1060,
      items: [{ name: 'OFFICE CHAIR', qty: 5, price: 1000, uom: 'PCS' }] },
    ocr_text: 'TAX INVOICE\nACME TRADING SDN BHD\nInvoice No: INV-1023\nTo: OUR TRADING SDN BHD',
    doc: {
      prompt_version: 'fx-1', direction: 'purchase', title: 'ACME TRADING SDN BHD 采购发票 INV-1023(2026-11-10)', keywords: ['acme trading', 'inv-1023', 'office chair'], language: 'en',
      classification: { document_type: 'purchase_invoice', confidence: 0.95, alternatives: [{ document_type: 'receipt', confidence: 0.03 }], evidence: ['TAX INVOICE', 'Invoice No'], title_printed: 'TAX INVOICE', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'INV-1023', due_date: '2026-12-10', terms: 'Net 30', supplier_invoice_no: 'INV-1023', reference: 'PO-5521' },
      parties: { issuer: party('ACME TRADING SDN BHD', { tax_id: 'C1234567890' }), counterparty: party(OUR) }, payment: noPayment, relations: { ...noRel, related_po_no: 'PO-5521' },
    },
  }),
  sales_order: fx({
    file: 'so-88.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    data: { ...emptyData(), merchant: 'XYZ SDN BHD', date: '2026-11-12', currency: 'MYR', subtotal: 500, tax: 30, total: 530,
      items: [{ name: 'WIDGET A', qty: 50, price: 500, uom: 'PCS' }] },
    ocr_text: 'SALES ORDER\nSO-88\nCustomer: XYZ SDN BHD',
    doc: {
      prompt_version: 'fx-1', direction: 'sales', title: 'XYZ SDN BHD 销售订单 SO-88(2026-11-12)', keywords: ['xyz', 'so-88', 'widget a'], language: 'en',
      classification: { document_type: 'sales_order', confidence: 0.91, alternatives: [{ document_type: 'quotation', confidence: 0.07 }], evidence: ['SALES ORDER'], title_printed: 'SALES ORDER', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'SO-88', customer_po_no: 'PO-7001', terms: 'Net 30' },
      parties: { issuer: party(OUR), counterparty: party('XYZ SDN BHD') }, payment: noPayment, relations: noRel,
    },
  }),
  quotation: fx({
    file: 'qt-31.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    data: { ...emptyData(), merchant: 'XYZ SDN BHD', date: '2026-11-01', currency: 'MYR', subtotal: 300, tax: 18, total: 318,
      items: [{ name: 'WIDGET B', qty: 30, price: 300, uom: 'PCS' }] },
    ocr_text: 'QUOTATION\nQT-31\nValid until 2026-11-30',
    doc: {
      prompt_version: 'fx-1', direction: 'sales', title: 'XYZ SDN BHD 报价单 QT-31(2026-11-01)', keywords: ['xyz', 'qt-31', 'widget b'], language: 'en',
      classification: { document_type: 'quotation', confidence: 0.9, alternatives: [], evidence: ['QUOTATION', 'Valid until'], title_printed: 'QUOTATION', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'QT-31', valid_until: '2026-11-30' },
      parties: { issuer: party(OUR), counterparty: party('XYZ SDN BHD') }, payment: noPayment, relations: noRel,
    },
  }),
  delivery_order: fx({
    file: 'do-55.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    // 送货单只管数量,没有价格和金额
    data: { ...emptyData(), merchant: 'XYZ SDN BHD', date: '2026-11-13',
      items: [{ name: 'WIDGET A', qty: 50, price: null, uom: 'PCS' }, { name: 'WIDGET B', qty: 30, price: null, uom: 'PCS' }] },
    ocr_text: 'DELIVERY ORDER\nDO-55\nReceived by:',
    doc: {
      prompt_version: 'fx-1', direction: 'sales', title: 'XYZ SDN BHD 送货单 DO-55(2026-11-13)', keywords: ['xyz', 'do-55', 'delivery'], language: 'en',
      classification: { document_type: 'delivery_order', confidence: 0.92, alternatives: [], evidence: ['DELIVERY ORDER', 'Received by'], title_printed: 'DELIVERY ORDER', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'DO-55', delivery_address: '12 Jalan Maju, 50000 KL' },
      parties: { issuer: party(OUR), counterparty: party('XYZ SDN BHD') }, payment: noPayment, relations: { ...noRel, related_so_no: 'SO-88' },
    },
  }),
  credit_note: fx({
    file: 'cn-9.jpg', status: 'REVIEW', reasons: ['type_unverified'],
    // 供应商开给我们的贷项通知单(采购方向): 对方 = 开单方
    data: { ...emptyData(), merchant: 'ACME TRADING SDN BHD', date: '2026-11-15', currency: 'MYR', subtotal: 100, tax: 6, total: 106,
      items: [{ name: 'OFFICE CHAIR (RETURNED)', qty: 1, price: 100, uom: 'PCS' }] },
    ocr_text: 'CREDIT NOTE\nCN-9\nAgainst Invoice INV-1023\nReason: damaged goods',
    doc: {
      prompt_version: 'fx-1', direction: 'purchase', title: 'ACME TRADING SDN BHD 贷项通知单 CN-9(2026-11-15)', keywords: ['acme trading', 'cn-9', 'inv-1023', 'damaged'], language: 'en',
      classification: { document_type: 'credit_note', confidence: 0.93, alternatives: [{ document_type: 'purchase_invoice', confidence: 0.05 }], evidence: ['CREDIT NOTE', 'Against Invoice'], title_printed: 'CREDIT NOTE', type_verdict: 'unverified' },
      header: { ...blankHeader, doc_no: 'CN-9' },
      parties: { issuer: party('ACME TRADING SDN BHD'), counterparty: party(OUR) }, payment: noPayment, relations: { ...noRel, original_invoice_no: 'INV-1023', reason: 'damaged goods' },
    },
  }),
  other: fx({
    file: 'misc-1.jpg', status: 'REVIEW', reasons: ['type_low_confidence'],
    data: { ...emptyData(), date: '2026-11-02' },
    ocr_text: 'STATEMENT OF ACCOUNT',
    doc: {
      prompt_version: 'fx-1', direction: 'unknown', title: null, keywords: ['statement'], language: 'en',
      classification: { document_type: 'other', confidence: 0.4, alternatives: [], evidence: [], title_printed: 'STATEMENT OF ACCOUNT', type_verdict: 'low_confidence' },
      header: blankHeader, parties: { issuer: null, counterparty: null }, payment: noPayment, relations: noRel,
    },
  }),
}
