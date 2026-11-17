import type { Database } from 'bun:sqlite'
import { toPublic, toPublicReconciliation, PUBLIC_SCHEMA_VERSION, type PublicReceipt, type PublicReconciliation, type PublicTax } from '../../shared/public'
import { reconcile, type ReconInput } from '../../shared/reconcile'
import { getDetail } from './receipts'

const r2 = (x: number) => Math.round(x * 100) / 100

export interface ValidateRequest extends ReconInput {
  taxes?: PublicTax[]
}
export interface ValidateResponse extends PublicReconciliation {
  schema_version: string
  warnings: string[]
}

/**
 * 同步对账: 不需要 GPU,也不碰数据库。
 * 多税率: 只给了 taxes[] 没给 tax 时,用各行税额之和;两者都给且对不上、或某行 税率×税基 对不上税额时,只发警告,不擅自改数据。
 */
export function validateReceipt(req: ValidateRequest): ValidateResponse {
  const warnings: string[] = []
  const input: ReconInput = { ...req }
  const taxes = (req.taxes ?? []).filter((t) => t.amount !== null)
  if (taxes.length) {
    const sum = r2(taxes.reduce((a, t) => a + (t.amount ?? 0), 0))
    if (input.tax === null || input.tax === undefined) input.tax = sum
    else if (Math.abs(sum - input.tax) > 0.011) warnings.push('taxes_sum_ne_tax')
    taxes.forEach((t, i) => {
      if (t.rate !== null && t.base !== null && t.amount !== null && Math.abs(r2((t.rate / 100) * t.base) - t.amount) > 0.02) warnings.push(`tax_line_mismatch:${i}`)
    })
  }
  return { schema_version: PUBLIC_SCHEMA_VERSION, ...toPublicReconciliation(reconcile(input)), warnings }
}

export function getPublicReceipt(db: Database, id: number): PublicReceipt {
  const d = getDetail(db, id)
  return toPublic(d, reconcile({ ...d.data }))
}
