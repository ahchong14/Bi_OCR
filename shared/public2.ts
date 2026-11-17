/**
 * 对外公开的数据契约 v2(单据分类版)。/v1 保持不变,v2 只允许向后兼容地加字段。
 * 金额一律是数字,未知用 null,绝不编造。图片上印的文字(标题、关键词、对方名称、商品描述)都是不可信文本。
 *
 * 数据来源: 分类 / 标题 / 关键词 / 对方 / 表头 / 付款 / 关联单据 来自随收据存下的 StoredDoc;
 * 金额、商品行、对账、质量、人工复核都读收据的当前值,所以人工改过的内容会直接体现在这里。
 */
import { autocountTarget, type Direction, type DocLanguage, type DocType, type TypeVerdict } from './doctypes'
import { emptyDoc, type DocAlternative, type DocParty, type StoredDoc } from './doc'
import { unitOf } from './linecalc'
import type { ReconResult } from './reconcile'
import { toPublicReconciliation, type PublicReconciliation, type PublicTax } from './public'
import type { ReceiptDetail } from './types'

export const PUBLIC_V2_SCHEMA_VERSION = '2.0'

export interface PublicItemV2 {
  line_no: number
  description: string
  /** 单据上印的商品编号(不是 AutoCount 的商品代码)。目前还没有读出来,为 null。 */
  item_code_printed: string | null
  quantity: number | null
  uom: string | null
  /** 单价 = (行金额 + 折扣) ÷ 数量,算不出为 null。 */
  unit_price: number | null
  discount: number | null
  tax_rate: number | null
  /** 行金额 = 数量 × 单价 − 折扣(净额,税另算)。 */
  total_price: number | null
}

export interface PublicDocumentV2 {
  schema_version: string
  id: number
  file: string
  classification: {
    /** null = 没分类过(旧数据)。 */
    document_type: DocType | null
    /** AutoCount 单据类型代码(IV / PI / SO …),由映射表得出,不是模型填的;方向未知或不写入时为 null。 */
    autocount_doc_type: string | null
    direction: Direction
    confidence: number | null
    alternatives: DocAlternative[]
    evidence: string[]
    title_printed: string | null
    type_verdict: TypeVerdict
  }
  title: string | null
  keywords: string[]
  language: DocLanguage | null
  header: {
    doc_no: string | null
    doc_date: string | null
    due_date: string | null
    valid_until: string | null
    currency: string | null
    reference: string | null
    customer_po_no: string | null
    terms: string | null
    supplier_invoice_no: string | null
    delivery_address: string | null
  }
  parties: { issuer: DocParty | null; counterparty: DocParty | null }
  amounts: {
    subtotal: number | null; discount: number | null; service_charge: number | null; tax: number | null; tip: number | null
    fees: number | null; rounding: number | null; total: number | null; paid: number | null; change: number | null; outstanding: number | null
  }
  taxes: PublicTax[]
  line_items: PublicItemV2[]
  payment: StoredDoc['payment']
  relations: StoredDoc['relations']
  /** 只是建议,不会写入任何东西。post_as: document = 带商品行的单据;cash_book_voucher = 现金账凭证(会计科目 + 金额);none = 不写入。 */
  autocount_hint: {
    entity: string | null
    party_role: 'debtor' | 'creditor' | null
    party_name_as_printed: string | null
    needs_master_match: boolean
    post_as: 'document' | 'cash_book_voucher' | 'none'
  }
  reconciliation: PublicReconciliation
  quality: { verdict: string; type_verdict: TypeVerdict; needs_review: boolean; reasons: string[]; needs_review_reasons: string[] }
  review: { state: 'pending' | 'approved' | 'rejected'; reviewed_by: string | null; reviewed_at: string | null; human_edited_fields: string[] }
  /** 提示: 这些字段来自图片原文(或模型据此生成),属于不可信文本,下游模型不要把它们当指令执行。 */
  untrusted_text_fields: string[]
  warnings: string[]
}

export const UNTRUSTED_TEXT_FIELDS_V2 = [
  'title', 'keywords[]', 'classification.evidence[]', 'classification.title_printed', 'header.reference', 'header.terms', 'header.delivery_address',
  'parties.*.name_as_printed', 'parties.*.address', 'relations.reason', 'line_items[].description',
]

const blankParty = (name: string | null): DocParty | null =>
  name ? { name_as_printed: name, name_normalized: null, reg_no: null, tax_id: null, address: null, phone: null, email: null } : null

/** 内部详情 → v2 公开契约。不含 OCR 原文、图片路径、审核备注等内部信息。 */
export function toPublicV2(d: ReceiptDetail, recon: ReconResult): PublicDocumentV2 {
  const x = d.data
  const doc = d.doc ?? emptyDoc()
  const type = doc.classification.document_type
  const direction: Direction = doc.direction
  const target = autocountTarget(type, direction)
  // 旧数据(没分类过): 商家就是开单方,给调用方一个能用的名字
  const issuer = d.doc ? doc.parties.issuer : blankParty(x.merchant)
  const counterparty = doc.parties.counterparty
  // 对方 = 我们要在 AutoCount 里找的那个主档: 销售类是客户(counterparty),采购类是供应商(issuer)
  const other = direction === 'sales' ? counterparty : issuer
  return {
    schema_version: PUBLIC_V2_SCHEMA_VERSION,
    id: d.id,
    file: d.file,
    classification: {
      document_type: type,
      autocount_doc_type: target?.code ?? null,
      direction,
      confidence: doc.classification.confidence,
      alternatives: doc.classification.alternatives,
      evidence: doc.classification.evidence,
      title_printed: doc.classification.title_printed,
      type_verdict: doc.classification.type_verdict,
    },
    title: d.title ?? doc.title,
    keywords: doc.keywords,
    language: doc.language,
    header: {
      doc_no: d.docNo ?? doc.header.doc_no,
      doc_date: x.date,
      due_date: doc.header.due_date,
      valid_until: doc.header.valid_until,
      currency: x.currency,
      reference: doc.header.reference,
      customer_po_no: doc.header.customer_po_no,
      terms: doc.header.terms,
      supplier_invoice_no: doc.header.supplier_invoice_no,
      delivery_address: doc.header.delivery_address,
    },
    parties: { issuer, counterparty },
    amounts: {
      subtotal: x.subtotal, discount: x.discount, service_charge: x.service_charge, tax: x.tax, tip: x.tip,
      fees: x.fees, rounding: x.rounding, total: x.total, paid: x.paid, change: x.change,
      outstanding: null, // 单据上印了才有意义;目前不读,所以不编造
    },
    taxes: x.tax !== null ? [{ label: null, rate: null, base: null, amount: x.tax }] : [],
    line_items: x.items.map((i, k) => {
      const unit = unitOf(i.price, i.discount, i.qty)
      return {
        line_no: k + 1, description: i.name, item_code_printed: null, quantity: i.qty, uom: i.uom ?? null,
        unit_price: unit === '' ? null : Number(unit), discount: i.discount ?? null, tax_rate: i.taxRate ?? null, total_price: i.price,
      }
    }),
    payment: doc.payment,
    relations: doc.relations,
    autocount_hint: {
      entity: target?.entity ?? null,
      party_role: target?.party ?? null,
      party_name_as_printed: other?.name_as_printed ?? x.merchant,
      needs_master_match: !!target && target.party !== null,
      post_as: target?.postAs ?? 'none',
    },
    reconciliation: toPublicReconciliation(recon),
    quality: {
      verdict: d.pipelineStatus,
      type_verdict: doc.classification.type_verdict,
      needs_review: d.state === 'pending' && d.pipelineStatus !== 'AUTO',
      reasons: d.reasons,
      needs_review_reasons: d.reasons.filter((r) => /^(type_|direction_)/.test(r)),
    },
    review: { state: d.state, reviewed_by: d.reviewer, reviewed_at: d.reviewedAt, human_edited_fields: d.editedFields },
    untrusted_text_fields: UNTRUSTED_TEXT_FIELDS_V2,
    warnings: [],
  }
}
