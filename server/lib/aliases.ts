/**
 * 商家记忆表: 「模型读到的商家名 → 审核员确认的商家名」。
 *
 * 为什么: 同一家店反复犯同一个错(招牌名对公司法定名: MYDIN、FamilyMart、Morganfields…),审核员改一次,以后同一个读法直接换成确认过的名字,
 * 不需要再人工看。不用 embedding: 几百个商家,名字相似度又快又准,而且完全确定、可以在评测集里重放。
 *
 * 学习来源只有一个: 审核员逐张审核(review_mode = single)通过的收据,机器读到的商家和最终商家不一样时记一条。批量通过不学(没有逐张看过)。
 * 使用: 扫描时把模型读到的商家名查一遍表;精确匹配(去符号、大小写后相同)出现过 1 次就用,模糊匹配(相似度 ≥ 0.92)要出现过 2 次才用。
 */
import type { Database } from 'bun:sqlite'
import { nowLocal } from '../db'
import { similarity } from './truth'

/**
 * 助手代审核的审核人(claude-assist)。用户明确同意把助手看图审核的结果直接当作商家记忆表的来源:
 * 助手逐张通过的收据会学商家别名、也算「确认过的商家」。
 * 但完整标签的导出(eval/export-reviewed.ts)仍然排除助手: 那是评测用的「标准答案」,助手看错一次就会变成标准,不能自己给自己出题。
 */
export const ASSISTANT_REVIEWERS = ['claude-assist'] as const
export const isAssistantReviewer = (user: string | null | undefined) => ASSISTANT_REVIEWERS.some((u) => u === String(user ?? '').trim().toLowerCase())
/** 给 SQL 用: `AND reviewer NOT IN (...)` 的占位和参数。 */
export const ASSISTANT_SQL = `(${ASSISTANT_REVIEWERS.map(() => '?').join(',')})`

/** 去掉符号和大小写,只留字母数字,用来比较。 */
export const normName = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9一-龥]/g, '')

export const ALIAS_FUZZY = 0.92 // 模糊匹配的相似度门槛
export const ALIAS_FUZZY_MIN_HITS = 2 // 模糊匹配要出现过几次才信
const MIN_KEY_LEN = 5 // 太短的名字(如 "AEON")不做模糊匹配,免得误换

export interface AliasEntry { alias: string; canonical: string; hits: number }
/** 把模型读到的商家名换成确认过的名字;表里没有返回 null。 */
export type AliasResolver = (name: string) => string | null

/** 从若干条记录建一个解析器。同一个读法对应多个确认名时取出现次数最多的。 */
export function makeResolver(entries: readonly AliasEntry[]): AliasResolver {
  const best = new Map<string, AliasEntry>()
  for (const e of entries) {
    const k = normName(e.alias)
    if (!k || k === normName(e.canonical)) continue
    const cur = best.get(k)
    if (!cur || e.hits > cur.hits) best.set(k, e)
  }
  const list = [...best.entries()]
  return (name) => {
    const k = normName(name)
    if (!k) return null
    const exact = best.get(k)
    if (exact) return exact.canonical
    if (k.length < MIN_KEY_LEN) return null
    let hit: AliasEntry | null = null, top = 0
    for (const [key, e] of list) {
      if (e.hits < ALIAS_FUZZY_MIN_HITS || key.length < MIN_KEY_LEN) continue
      const sim = similarity(k, key)
      if (sim >= ALIAS_FUZZY && sim > top) { hit = e; top = sim }
    }
    return hit?.canonical ?? null
  }
}

export function loadAliases(db: Database): AliasEntry[] {
  return db.query<AliasEntry, []>('SELECT alias, canonical, hits FROM merchant_alias').all()
}

/** 审核员以前逐张审核通过的商家名(去符号后),用来判断「这个名字是不是他们确认过的」。 */
export function knownMerchants(db: Database): (name: string) => boolean {
  const set = new Set(
    db.query<{ merchant: string }, []>(`SELECT DISTINCT merchant FROM receipts WHERE state='approved' AND review_mode='single' AND merchant IS NOT NULL`).all().map((r) => normName(r.merchant)),
  )
  return (name) => set.has(normName(name))
}

/** 门户用的解析器: 每次扫描现建(表很小,几百行)。 */
export const aliasResolver = (db: Database): AliasResolver => makeResolver(loadAliases(db))

/**
 * 记一条: 机器读到 `machine`,审核员确认成 `final`。两者去符号后相同(只是大小写、标点不同)不记;
 * 相似度 ≥ 0.9 的小改动(OCR 错一个字母)也不记 —— 那是识别错字,不是「同一家店的另一种叫法」,记了反而会把别的店换错。
 * 返回有没有记。
 */
export function learnAlias(db: Database, machine: string | null | undefined, final: string | null | undefined): boolean {
  const a = String(machine ?? '').trim(), b = String(final ?? '').trim()
  if (!a || !b) return false
  const ka = normName(a), kb = normName(b)
  if (!ka || !kb || ka === kb || similarity(a, b) >= 0.9) return false
  db.query(
    `INSERT INTO merchant_alias(alias_norm, alias, canonical, hits, updated_at) VALUES (?,?,?,1,?)
     ON CONFLICT(alias_norm, canonical) DO UPDATE SET hits = hits + 1, alias = excluded.alias, updated_at = excluded.updated_at`,
  ).run(ka, a, b, nowLocal())
  return true
}

/**
 * 回填: 把【已经逐张通过】的收据补学进记忆表(记忆表上线之前、或助手审核之前通过的)。
 * 读法取两处: 机器读到的商家(receipt_blobs.machine)和系统清理前的原始读法(corrections 里 field = merchant 的 old);
 * 最终商家取现在的 receipts.merchant。同一条只记一次(按 收据 × 读法 去重),重复运行不会重复计数。
 * 返回新记了几条。
 */
export function backfillAliases(db: Database): { receipts: number; learned: number } {
  db.exec('CREATE TABLE IF NOT EXISTS merchant_alias_seen (receipt_id INTEGER NOT NULL, alias_norm TEXT NOT NULL, PRIMARY KEY (receipt_id, alias_norm))')
  const rows = db
    .query<{ id: number; merchant: string | null; machine: string | null; corrections: string | null }, []>(
      `SELECT r.id, r.merchant, b.machine, b.corrections FROM receipts r JOIN receipt_blobs b ON b.receipt_id = r.id
        WHERE r.state = 'approved' AND r.review_mode = 'single' AND r.merchant IS NOT NULL`,
    )
    .all()
  const seen = db.query('INSERT OR IGNORE INTO merchant_alias_seen(receipt_id, alias_norm) VALUES (?, ?)')
  let learned = 0
  db.transaction(() => {
    for (const r of rows) {
      const readings = new Set<string>()
      try { const m = JSON.parse(r.machine ?? '{}') as { merchant?: string | null }; if (m.merchant) readings.add(m.merchant) } catch { /* 坏了当没有 */ }
      try { for (const c of JSON.parse(r.corrections ?? '[]') as { field?: string; old?: unknown }[]) if (c.field === 'merchant' && typeof c.old === 'string') readings.add(c.old) } catch { /* 同上 */ }
      for (const a of readings) {
        const key = normName(a)
        if (!key || (seen.run(r.id, key) as { changes: number }).changes === 0) continue
        if (learnAlias(db, a, r.merchant)) learned++
      }
    }
  })()
  return { receipts: rows.length, learned }
}
