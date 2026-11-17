/**
 * 单据类型清单 + 到 AutoCount 的映射。这是「单一数据源」: 提示词、校验、界面下拉、AutoCount 映射、/v2/types 都从这里生成,
 * 加一个类型只改这一处。
 *
 * 首版启用 8 个类型(IMPLEMENTATION-PLAN D9)。方向 direction 表示「我们是开单方(sales)还是收单方(purchase)」,
 * 由代码按「我方身份」判定,没配置就是 unknown(D4),不是模型猜的。
 */

export const DOC_TYPES = [
  'receipt', 'invoice', 'sales_invoice', 'purchase_invoice', 'sales_order', 'quotation', 'delivery_order', 'credit_note', 'other',
] as const
export type DocType = (typeof DOC_TYPES)[number]

/**
 * 模型能输出的类型。销售发票和采购发票在图上长得一模一样(都印 TAX INVOICE),模型没法分,所以只让它判断「发票」(invoice);
 * 是销售还是采购由代码根据「我方身份」决定(specificType);没配置我方身份就保持 invoice(方向未定),不硬猜(P0 的发现)。
 */
export const MODEL_DOC_TYPES = DOC_TYPES.filter((t) => t !== 'sales_invoice' && t !== 'purchase_invoice') as readonly Exclude<DocType, 'sales_invoice' | 'purchase_invoice'>[]
export type ModelDocType = (typeof MODEL_DOC_TYPES)[number]

export const DIRECTIONS = ['sales', 'purchase', 'unknown'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** 分类可信度的判定。unclassified = 旧数据 / 没做过分类。 */
export const TYPE_VERDICTS = ['ok', 'low_confidence', 'direction_unknown', 'evidence_missing', 'conflict', 'unverified', 'unclassified'] as const
export type TypeVerdict = (typeof TYPE_VERDICTS)[number]

export const DOC_LANGUAGES = ['en', 'ms', 'zh', 'mixed'] as const
export type DocLanguage = (typeof DOC_LANGUAGES)[number]

export const isDocType = (x: unknown): x is DocType => typeof x === 'string' && (DOC_TYPES as readonly string[]).includes(x)
export const isDirection = (x: unknown): x is Direction => typeof x === 'string' && (DIRECTIONS as readonly string[]).includes(x)
export const isTypeVerdict = (x: unknown): x is TypeVerdict => typeof x === 'string' && (TYPE_VERDICTS as readonly string[]).includes(x)
export const isDocLanguage = (x: unknown): x is DocLanguage => typeof x === 'string' && (DOC_LANGUAGES as readonly string[]).includes(x)

/** 写入 AutoCount 时落到哪个实体。verified = 字段要求已用 describe_entity 核对过;false 的在 P6 开始前必须先核对。 */
export interface AutoCountTarget {
  entity: string
  /** AutoCount 单据类型代码(IV / PI / SO …);现金账凭证用 PV。 */
  code: string
  /** 对方主档: 客户 debtor / 供应商 creditor;现金账凭证没有对方主档(payTo 只是名字)。 */
  party: 'debtor' | 'creditor' | null
  /** document = 带商品行(itemCode);cash_book_voucher = 会计科目 + 金额。 */
  postAs: 'document' | 'cash_book_voucher'
  verified: boolean
}

type Need = 'required' | 'recommended' | 'optional' | 'none'

export interface DocTypeInfo {
  id: DocType
  zh: string
  en: string
  /** 没配置「我方身份」时的默认方向。null = 不能默认,保持 unknown。 */
  defaultDirection: Direction | null
  /** 这个类型对各块数据的要求,送人工 / 校验时用。 */
  needs: { doc_no: Need; counterparty: Need; amounts: Need; line_items: Need; payment: Need }
  /** 是否做金额对账(送货单、收货单只管数量,不对账金额)。 */
  reconcileAmounts: boolean
  /** 能不能写进 AutoCount。 */
  postable: boolean
  /** 按方向给出 AutoCount 目标;没有映射 = 不写入。 */
  autocount: Partial<Record<'sales' | 'purchase', AutoCountTarget>>
}

const doc = (entity: string, code: string, party: 'debtor' | 'creditor', verified: boolean): AutoCountTarget => ({ entity, code, party, postAs: 'document', verified })

export const DOC_TYPE_INFO: Record<DocType, DocTypeInfo> = {
  receipt: {
    id: 'receipt', zh: '收据 / 小票', en: 'Receipt', defaultDirection: 'purchase',
    needs: { doc_no: 'optional', counterparty: 'none', amounts: 'required', line_items: 'optional', payment: 'optional' },
    reconcileAmounts: true, postable: true,
    // 零售小票没有商品代码,所以记成现金账付款凭证(PV): 行是「会计科目 + 金额」。
    // 如果这张小票是我们自己开出去的(开单方是我方),就是现金销售(CS): 现金付款又开了抬头的 TAX INVOICE 在 AutoCount 里就是 Cash Sale(P0 的发现)。
    autocount: {
      purchase: { entity: 'gl.cash_book', code: 'PV', party: null, postAs: 'cash_book_voucher', verified: true },
      sales: doc('sales.cash_sale', 'CS', 'debtor', true),
    },
  },
  invoice: {
    id: 'invoice', zh: '发票(方向未定)', en: 'Invoice (direction not set)', defaultDirection: null,
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'required', line_items: 'recommended', payment: 'optional' },
    // 方向没定就不知道该写销售发票还是采购发票,所以不能写入;配置了我方身份后会被解析成 sales_invoice / purchase_invoice
    reconcileAmounts: true, postable: false, autocount: {},
  },
  sales_invoice: {
    id: 'sales_invoice', zh: '销售发票', en: 'Sales invoice', defaultDirection: 'sales',
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'required', line_items: 'recommended', payment: 'optional' },
    reconcileAmounts: true, postable: true,
    autocount: { sales: doc('sales.invoice', 'IV', 'debtor', true) },
  },
  purchase_invoice: {
    id: 'purchase_invoice', zh: '采购发票', en: 'Purchase invoice', defaultDirection: 'purchase',
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'required', line_items: 'recommended', payment: 'optional' },
    reconcileAmounts: true, postable: true,
    autocount: { purchase: doc('purchase.invoice', 'PI', 'creditor', true) },
  },
  sales_order: {
    id: 'sales_order', zh: '销售订单', en: 'Sales order', defaultDirection: 'sales',
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'optional', line_items: 'required', payment: 'none' },
    reconcileAmounts: true, postable: true,
    autocount: { sales: doc('sales.order', 'SO', 'debtor', true) },
  },
  quotation: {
    id: 'quotation', zh: '报价单', en: 'Quotation', defaultDirection: 'sales',
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'optional', line_items: 'required', payment: 'none' },
    reconcileAmounts: true, postable: true,
    autocount: { sales: doc('sales.quotation', 'QT', 'debtor', false) },
  },
  delivery_order: {
    id: 'delivery_order', zh: '送货单', en: 'Delivery order', defaultDirection: null,
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'none', line_items: 'required', payment: 'none' },
    reconcileAmounts: false, postable: true,
    autocount: { sales: doc('sales.delivery_order', 'DO', 'debtor', false), purchase: doc('purchase.goods_received', 'GR', 'creditor', false) },
  },
  credit_note: {
    id: 'credit_note', zh: '贷项通知单', en: 'Credit note', defaultDirection: null,
    needs: { doc_no: 'required', counterparty: 'required', amounts: 'required', line_items: 'recommended', payment: 'none' },
    reconcileAmounts: true, postable: true,
    autocount: { sales: doc('sales.credit_note', 'CN', 'debtor', true), purchase: doc('ap.credit_note', 'CN', 'creditor', false) },
  },
  other: {
    id: 'other', zh: '其他 / 无法判断', en: 'Other', defaultDirection: null,
    needs: { doc_no: 'optional', counterparty: 'optional', amounts: 'optional', line_items: 'optional', payment: 'optional' },
    reconcileAmounts: true, postable: false,
    autocount: {},
  },
}

export const docTypeLabel = (t: DocType, lang: 'zh' | 'en'): string => DOC_TYPE_INFO[t][lang === 'zh' ? 'zh' : 'en']

/** 这个类型 + 方向对应的 AutoCount 目标;方向未知 / 没有映射 → null(不写入)。 */
export function autocountTarget(type: DocType | null | undefined, direction: Direction | null | undefined): AutoCountTarget | null {
  if (!type || !direction || direction === 'unknown') return null
  return DOC_TYPE_INFO[type].autocount[direction] ?? null
}

/** 没有「我方身份」时的方向: 只有收据这类天然只有一个方向的类型才能默认。 */
export const defaultDirectionOf = (type: DocType | null | undefined): Direction => (type ? DOC_TYPE_INFO[type].defaultDirection ?? 'unknown' : 'unknown')

/** 模型判断的是「发票」时,按方向落成具体类型: 开单方是我方 → 销售发票;收单方是我方 → 采购发票;方向未定 → 仍是 invoice。其他类型原样返回。 */
export const specificType = (type: DocType, direction: Direction): DocType =>
  type === 'invoice' ? (direction === 'sales' ? 'sales_invoice' : direction === 'purchase' ? 'purchase_invoice' : 'invoice') : type

/** 批准一张单据时要不要求有总额。旧数据(没分类过)和需要金额的类型要求;送货单、订单、报价单、other 不要求。 */
export const amountsRequired = (type: string | null | undefined): boolean => !isDocType(type) || DOC_TYPE_INFO[type].needs.amounts === 'required'
