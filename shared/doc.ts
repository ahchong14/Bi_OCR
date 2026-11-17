/**
 * 随收据一起存下来的「文档信息」(分类、标题、关键词、对方、表头、付款、关联单据)。
 * 存在 receipt_blobs.doc(JSON),旧的列(merchant / date / 金额 / 商品行)继续是通用的扁平视图,所以旧界面、导出、分析都不受影响。
 * 金额和商品行不在这里: 它们以 receipts 的列为准(人工改过的值会直接体现在 v2 输出里)。
 */
import type { Direction, DocLanguage, DocType, TypeVerdict } from './doctypes'

/** 单据上印的一方(开单方或对方)。name_as_printed 是原文,name_normalized 是归一化后用来匹配的。图片原文属于不可信文本。 */
export interface DocParty {
  name_as_printed: string | null
  name_normalized: string | null
  reg_no: string | null
  tax_id: string | null
  address: string | null
  phone: string | null
  email: string | null
}

export interface DocAlternative { document_type: DocType; confidence: number }

export interface StoredDoc {
  /** 生成这份数据的提示词版本,模型输出漂移时用来追溯。 */
  prompt_version: string | null
  classification: {
    /** null = 没分类过(旧数据)。 */
    document_type: DocType | null
    confidence: number | null
    alternatives: DocAlternative[]
    /** 图上印的、支持这个判断的原文片段;已校验存在于转写里(P2)。 */
    evidence: string[]
    /** 单据上印的标题,如 "TAX INVOICE"。 */
    title_printed: string | null
    type_verdict: TypeVerdict
  }
  direction: Direction
  /** 模型生成的一句话标题,≤ 80 字符(对应 AutoCount 的抬头描述字段)。 */
  title: string | null
  keywords: string[]
  language: DocLanguage | null
  header: {
    doc_no: string | null
    due_date: string | null
    valid_until: string | null
    /** ≤ 20 字符(对应 AutoCount 的参考号)。 */
    reference: string | null
    customer_po_no: string | null
    terms: string | null
    supplier_invoice_no: string | null
    delivery_address: string | null
  }
  parties: { issuer: DocParty | null; counterparty: DocParty | null }
  payment: { method: 'cash' | 'card' | 'bank_transfer' | 'ewallet' | 'cheque' | 'credit' | 'unknown' | null; reference: string | null; card_last4: string | null }
  relations: { original_invoice_no: string | null; related_po_no: string | null; related_so_no: string | null; related_do_no: string | null; reason: string | null }
}

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'ewallet', 'cheque', 'credit', 'unknown'] as const

/** 空的文档信息(没分类过的状态)。 */
export const emptyDoc = (): StoredDoc => ({
  prompt_version: null,
  classification: { document_type: null, confidence: null, alternatives: [], evidence: [], title_printed: null, type_verdict: 'unclassified' },
  direction: 'unknown',
  title: null,
  keywords: [],
  language: null,
  header: { doc_no: null, due_date: null, valid_until: null, reference: null, customer_po_no: null, terms: null, supplier_invoice_no: null, delivery_address: null },
  parties: { issuer: null, counterparty: null },
  payment: { method: null, reference: null, card_last4: null },
  relations: { original_invoice_no: null, related_po_no: null, related_so_no: null, related_do_no: null, reason: null },
})
