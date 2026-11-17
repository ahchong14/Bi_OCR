/**
 * 把外面传进来的「文档信息」(模型输出 / 导入文件)整理成 StoredDoc: 只认约定的键,枚举不合法就丢,字符串截断,
 * 日期不是 YYYY-MM-DD 就丢。输入是不可信的(来自图片和模型),所以这里是唯一的入库关口。
 * 内容层面的清洗(去掉标题 / 关键词里的金额、证件号等)是 P2 的事,这里只保证形状和长度。
 */
import { isDirection, isDocLanguage, isDocType, isTypeVerdict } from '../../shared/doctypes'
import { PAYMENT_METHODS, type DocAlternative, type DocParty, type StoredDoc } from '../../shared/doc'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const DOC_LIMITS = { title: 80, keyword: 40, keywords: 10, evidence: 120, evidenceCount: 5, reference: 20 } as const

type Mask = (s: string) => string

export function cleanDoc(raw: unknown, mask: Mask = (s) => s): StoredDoc | null {
  if (!isObj(raw)) return null
  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null
    const s = mask(v.replace(/\s+/g, ' ').trim()).slice(0, max).trim()
    return s || null
  }
  const date = (v: unknown): string | null => (typeof v === 'string' && DATE.test(v.trim()) ? v.trim() : null)
  const num01 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 1000) / 1000)) : null)

  const c = isObj(raw.classification) ? raw.classification : {}
  const documentType = isDocType(c.document_type) ? c.document_type : null
  const alternatives: DocAlternative[] = []
  if (Array.isArray(c.alternatives)) {
    for (const a of c.alternatives) {
      if (alternatives.length >= 2) break
      if (isObj(a) && isDocType(a.document_type) && a.document_type !== documentType) {
        const conf = num01(a.confidence)
        if (conf !== null) alternatives.push({ document_type: a.document_type, confidence: conf })
      }
    }
  }
  const evidence = Array.isArray(c.evidence)
    ? c.evidence.map((e) => str(e, DOC_LIMITS.evidence)).filter((e): e is string => !!e).slice(0, DOC_LIMITS.evidenceCount)
    : []
  const verdict = isTypeVerdict(c.type_verdict) ? c.type_verdict : documentType ? 'unverified' : 'unclassified'

  const keywords: string[] = []
  if (Array.isArray(raw.keywords)) {
    const seen = new Set<string>()
    for (const k of raw.keywords) {
      const s = str(k, DOC_LIMITS.keyword)
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); keywords.push(s) }
      if (keywords.length >= DOC_LIMITS.keywords) break
    }
  }

  const h = isObj(raw.header) ? raw.header : {}
  const party = (v: unknown): DocParty | null => {
    if (!isObj(v)) return null
    const p: DocParty = {
      name_as_printed: str(v.name_as_printed, 200), name_normalized: str(v.name_normalized, 200), reg_no: str(v.reg_no, 40),
      tax_id: str(v.tax_id, 40), address: str(v.address, 300), phone: str(v.phone, 40), email: str(v.email, 100),
    }
    return Object.values(p).some((x) => x !== null) ? p : null
  }
  const ps = isObj(raw.parties) ? raw.parties : {}
  const pay = isObj(raw.payment) ? raw.payment : {}
  const rel = isObj(raw.relations) ? raw.relations : {}
  const last4 = typeof pay.card_last4 === 'string' && /^\d{4}$/.test(pay.card_last4.trim()) ? pay.card_last4.trim() : null

  return {
    prompt_version: str(raw.prompt_version, 40),
    classification: { document_type: documentType, confidence: num01(c.confidence), alternatives, evidence, title_printed: str(c.title_printed, 60), type_verdict: verdict },
    direction: isDirection(raw.direction) ? raw.direction : 'unknown',
    title: str(raw.title, DOC_LIMITS.title),
    keywords,
    language: isDocLanguage(raw.language) ? raw.language : null,
    header: {
      doc_no: str(h.doc_no, 40), due_date: date(h.due_date), valid_until: date(h.valid_until), reference: str(h.reference, DOC_LIMITS.reference),
      customer_po_no: str(h.customer_po_no, 40), terms: str(h.terms, 60), supplier_invoice_no: str(h.supplier_invoice_no, 40), delivery_address: str(h.delivery_address, 200),
    },
    parties: { issuer: party(ps.issuer), counterparty: party(ps.counterparty) },
    payment: {
      method: typeof pay.method === 'string' && (PAYMENT_METHODS as readonly string[]).includes(pay.method) ? (pay.method as StoredDoc['payment']['method']) : null,
      reference: str(pay.reference, 60), card_last4: last4,
    },
    relations: {
      original_invoice_no: str(rel.original_invoice_no, 40), related_po_no: str(rel.related_po_no, 40), related_so_no: str(rel.related_so_no, 40),
      related_do_no: str(rel.related_do_no, 40), reason: str(rel.reason, 200),
    },
  }
}
