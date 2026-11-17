/**
 * 「模型读到的整份文档信息」夹具(MODEL_DOC_SCHEMA 的形状): 缺失值是空字符串,不是 null(见 docPrompt.ts 文件头)。
 * 基础版是一张金额自洽的现金小票,转写里能找到它的证据和每一个金额,所以走完整个流水线能得到「基本可信」。
 */
export const party = (name: string, extra: Record<string, string> = {}) => ({ name, reg_no: '', tax_id: '', address: '', phone: '', email: '', ...extra })

export const TRANSCRIPT = 'ACME TRADING SDN BHD\nTAX INVOICE\nInvoice No: INV-1023\nBill To: XYZ SDN BHD\n17/10/2018\nCOFFEE 2 5.00 10.00\nSUBTOTAL 10.00\nSST 0.60\nTOTAL 10.60\nCASH 20.00\nCHANGE 9.40'

export const modelDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  document_type: 'receipt', confidence: 0.93, alternatives: [], evidence: ['CASH', 'CHANGE'], title_printed: 'TAX INVOICE', language: 'en',
  title: 'ACME TRADING SDN BHD receipt INV-1023 (2018-10-17)', keywords: ['acme trading', 'coffee', 'cash'],
  issuer: party('ACME TRADING SDN BHD'), counterparty: party(''),
  doc_no: 'INV-1023', doc_date: '2018-10-17', due_date: '', valid_until: '', currency: 'MYR', reference: '', customer_po_no: '', terms: '',
  supplier_invoice_no: '', delivery_address: '',
  subtotal: '10.00', discount_amount: '', service_charge_amount: '', tax_amount: '0.60', rounding_adjustment: '', total: '10.60', amount_paid: '20.00', change_given: '9.40',
  payment_method: 'cash', payment_reference: '', card_last4: '',
  original_invoice_no: '', related_po_no: '', related_so_no: '', related_do_no: '', reason: '',
  line_items: [{ description: 'COFFEE', item_code: '', quantity: '2', unit_price: '5.00', amount: '10.00', uom: '', discount: '', tax: '' }],
  ...over,
})
