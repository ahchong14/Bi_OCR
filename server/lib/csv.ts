import type { Database } from 'bun:sqlite'
import type { FieldKey, Lang, ReceiptQuery } from '../../shared/types'
import { CSV_HEADERS, fieldLabel, listSep, stateLabel, yesNo } from './i18n'
import { selectAll } from './receipts'

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // 防 CSV 注入: 以 = + - @ 开头的文本在 Excel 里会被当成公式(数字不处理)
  const safe = typeof v === 'string' && /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
const line = (cols: unknown[]) => cols.map(cell).join(',')
const withBom = (s: string) => new TextEncoder().encode('﻿' + s) // BOM: Excel 直接打开不乱码

export function receiptsCsv(db: Database, q: ReceiptQuery, lang: Lang = 'zh'): Uint8Array {
  const out = [line(CSV_HEADERS[lang].receipts)]
  for (const r of selectAll(db, q)) {
    const edited = JSON.parse(r.edited_fields) as FieldKey[]
    out.push(
      line([
        r.file, r.merchant, r.date, r.currency, r.subtotal, r.discount, r.service_charge, r.tax, r.tip, r.fees, r.rounding, r.total, r.paid, r.change,
        (JSON.parse(r.items) as unknown[]).length, stateLabel(lang, r.state), r.reviewer, r.reviewed_at, yesNo(lang, edited.length > 0),
        edited.map((f) => fieldLabel(lang, f)).join(listSep(lang)), r.pipeline_status, r.note,
      ]),
    )
  }
  return withBom(out.join('\r\n') + '\r\n')
}

export function itemsCsv(db: Database, q: ReceiptQuery, lang: Lang = 'zh'): Uint8Array {
  const out = [line(CSV_HEADERS[lang].items)]
  for (const r of selectAll(db, q)) {
    for (const it of JSON.parse(r.items) as { name: string; qty: number | null; price: number | null; uom?: string; discount?: number; taxRate?: number }[]) {
      out.push(line([r.file, r.merchant, r.date, r.currency, it.name, it.qty, it.uom ?? '', it.discount ?? '', it.taxRate ?? '', it.price]))
    }
  }
  return withBom(out.join('\r\n') + '\r\n')
}
