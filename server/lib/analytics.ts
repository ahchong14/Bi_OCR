import type { Database } from 'bun:sqlite'
import { PIPELINE_STATUSES, type Analytics, type AnalyticsQuery, type FieldKey, type PipelineStatus, type ProviderStat } from '../../shared/types'

type Args = (string | number | null)[]

/**
 * 从批次名判断这批收据是谁识别的:
 *   门户扫描的批次名是 "scan 时间 · 识别服务名"(MiniCPM 的服务名带主机,如 minicpm-ocr@xxx.trycloudflare.com,每次隧道不同,所以只取 @ 前面);
 *   以前的扫描批次没记录识别服务(当时用的是 OCR.space),归为 scan;zip / json 是流水线导入。
 */
export function providerOf(batch: string | null): string {
  if (!batch) return 'other'
  const i = batch.indexOf(' · ')
  if (i >= 0) return batch.slice(i + 3).trim().split('@')[0] || 'other'
  if (batch.startsWith('scan ')) return 'scan'
  if (batch.startsWith('zip ')) return 'zip'
  if (batch.startsWith('json ')) return 'json'
  return 'other'
}
const INFO_CODES = new Set(['audit_sample', 'auto_corrected', 'fix_suggested', 'items_reextracted', 'very_tall_image'])

/**
 * 统计分析。时间范围按"收据日期"过滤(没有日期的用导入日期),这样口径对财务最直观。
 * 所有聚合都在 SQLite 里完成,依赖 receipts 表里的"当前值"列和 JSON1 函数。
 */
export function getAnalytics(db: Database, q: AnalyticsQuery): Analytics {
  const from = q.from || null
  const to = q.to || null
  const dateExpr = "COALESCE(date, substr(imported_at, 1, 10))"
  const rangeParts: string[] = []
  const rangeArgs: Args = []
  if (from) { rangeParts.push(`${dateExpr} >= ?`); rangeArgs.push(from) }
  if (to) { rangeParts.push(`${dateExpr} <= ?`); rangeArgs.push(to) }
  const R = rangeParts.length ? rangeParts.join(' AND ') : '1=1'
  const all = <T>(sql: string, ...extra: Args) => db.query<T, Args>(sql).all(...extra)

  // 按状态计数
  const byState = all<{ state: string; n: number }>(`SELECT state, COUNT(*) AS n FROM receipts WHERE ${R} GROUP BY state`, ...rangeArgs)
  const cnt = (s: string) => byState.find((x) => x.state === s)?.n ?? 0

  // 已通过的金额(按币种分开,不同币种不能直接相加)
  const approvedAmounts = all<{ currency: string | null; count: number; sum: number; avg: number }>(
    `SELECT currency, COUNT(*) AS count, COALESCE(SUM(total), 0) AS sum, COALESCE(AVG(total), 0) AS avg
       FROM receipts WHERE state = 'approved' AND total IS NOT NULL AND ${R} GROUP BY currency ORDER BY sum DESC`,
    ...rangeArgs,
  )
  const currencies = approvedAmounts.map((a) => a.currency).filter((c): c is string => !!c)
  const currency = q.currency && currencies.includes(q.currency) ? q.currency : (currencies[0] ?? null)

  // 趋势
  const g = q.granularity ?? 'month'
  const periodExpr = g === 'day' ? 'substr(date, 1, 10)' : g === 'week' ? "strftime('%Y-W%W', date)" : 'substr(date, 1, 7)'
  const series = all<{ period: string; count: number; sum: number }>(
    `SELECT ${periodExpr} AS period, COUNT(*) AS count, COALESCE(SUM(total), 0) AS sum FROM receipts
      WHERE state = 'approved' AND date IS NOT NULL AND total IS NOT NULL AND currency IS ? AND ${R}
      GROUP BY period ORDER BY period`,
    currency, ...rangeArgs,
  )

  // 商家排行
  const topMerchants = all<{ merchant: string; count: number; sum: number }>(
    `SELECT MIN(merchant) AS merchant, COUNT(*) AS count, COALESCE(SUM(total), 0) AS sum FROM receipts
      WHERE state = 'approved' AND merchant IS NOT NULL AND total IS NOT NULL AND currency IS ? AND ${R}
      GROUP BY lower(trim(merchant)) ORDER BY sum DESC LIMIT 10`,
    currency, ...rangeArgs,
  )

  // 系统初判 vs 人工结果: 系统的"可信"到底有多可信
  // 批量通过的收据没有逐张看过,不能算"人工确认系统是对的"——否则乱点批量通过会让系统看起来 100% 准确。
  // 凡是衡量「系统准不准」的指标,都只用逐张审核(single)的;批量(bulk)的单独计数。
  const cal = all<{ pipeline_status: PipelineStatus; state: string; edited: number; bulk: number; n: number }>(
    `SELECT pipeline_status, state, CASE WHEN edited_fields != '[]' THEN 1 ELSE 0 END AS edited, CASE WHEN review_mode = 'bulk' THEN 1 ELSE 0 END AS bulk, COUNT(*) AS n
       FROM receipts WHERE ${R} GROUP BY pipeline_status, state, edited, bulk`,
    ...rangeArgs,
  )
  const calibration = PIPELINE_STATUSES.map((status) => {
    const rows = cal.filter((c) => c.pipeline_status === status)
    const sum = (f: (c: (typeof cal)[number]) => boolean) => rows.filter(f).reduce((a, c) => a + c.n, 0)
    return {
      status,
      approvedUnchanged: sum((c) => c.state === 'approved' && !c.bulk && !c.edited),
      approvedEdited: sum((c) => c.state === 'approved' && !c.bulk && !!c.edited),
      approvedBulk: sum((c) => c.state === 'approved' && !!c.bulk),
      rejected: sum((c) => c.state === 'rejected'),
      pending: sum((c) => c.state === 'pending'),
    }
  })

  // 按识别来源对比: 同一套指标,按批次名里的来源分组。样本少的组只供参考,界面会标出样本量
  const byBatch = all<{ batch: string | null; pipeline_status: PipelineStatus; state: string; edited: number; bulk: number; n: number }>(
    `SELECT batch, pipeline_status, state, CASE WHEN edited_fields != '[]' THEN 1 ELSE 0 END AS edited, CASE WHEN review_mode = 'bulk' THEN 1 ELSE 0 END AS bulk, COUNT(*) AS n
       FROM receipts WHERE ${R} GROUP BY batch, pipeline_status, state, edited, bulk`,
    ...rangeArgs,
  )
  const timed = all<{ batch: string | null; avg: number; c: number }>(
    `SELECT r.batch AS batch, AVG(json_extract(b.timing, '$.total')) AS avg, COUNT(json_extract(b.timing, '$.total')) AS c
       FROM receipts r JOIN receipt_blobs b ON b.receipt_id = r.id
      WHERE b.timing IS NOT NULL AND json_extract(b.timing, '$.total') IS NOT NULL AND ${R} GROUP BY r.batch`,
    ...rangeArgs,
  )
  const groups = new Map<string, ProviderStat & { _secSum: number }>()
  const grp = (p: string) => {
    let g = groups.get(p)
    if (!g) groups.set(p, (g = { provider: p, count: 0, pending: 0, approved: 0, rejected: 0, autoShare: 0, reviewShare: 0, editRate: null, editSample: 0, avgSeconds: null, timedCount: 0, _secSum: 0 }))
    return g
  }
  const autoN = new Map<string, number>(), reviewN = new Map<string, number>(), editedN = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n)
  for (const r of byBatch) {
    const p = providerOf(r.batch), g = grp(p)
    g.count += r.n
    if (r.state === 'pending') g.pending += r.n
    if (r.state === 'rejected') g.rejected += r.n
    if (r.state === 'approved') {
      g.approved += r.n
      if (!r.bulk) { g.editSample += r.n; if (r.edited) bump(editedN, p, r.n) } // 批量通过的没有逐张看过,不算"人工确认过"
    }
    if (r.pipeline_status === 'AUTO' || r.pipeline_status === 'AUTO_VERIFIED') bump(autoN, p, r.n)
    if (r.pipeline_status === 'REVIEW') bump(reviewN, p, r.n)
  }
  for (const t of timed) { const g = grp(providerOf(t.batch)); g.timedCount += t.c; g._secSum += t.avg * t.c }
  const providers: ProviderStat[] = [...groups.values()]
    .map(({ _secSum, ...g }) => ({
      ...g,
      autoShare: g.count ? (autoN.get(g.provider) ?? 0) / g.count : 0,
      reviewShare: g.count ? (reviewN.get(g.provider) ?? 0) / g.count : 0,
      editRate: g.editSample ? (editedN.get(g.provider) ?? 0) / g.editSample : null,
      avgSeconds: g.timedCount ? _secSum / g.timedCount : null,
    }))
    .sort((a, b) => b.count - a.count)

  const approved = cnt('approved')
  const bulkApproved = cal.filter((c) => c.state === 'approved' && c.bulk).reduce((a, c) => a + c.n, 0)
  const humanReviewed = approved - bulkApproved // 逐张审核通过的数量: 所有"准确率"类指标的样本
  const editedApproved = cal.filter((c) => c.state === 'approved' && !c.bulk && c.edited).reduce((a, c) => a + c.n, 0)

  // 哪些字段最常被人工改
  const fieldCorrections = all<{ field: FieldKey; count: number }>(
    `SELECT j.value AS field, COUNT(*) AS count FROM receipts r, json_each(r.edited_fields) j
      WHERE r.state = 'approved' AND r.review_mode IS NOT 'bulk' AND ${R} GROUP BY j.value ORDER BY count DESC`,
    ...rangeArgs,
  ).map((f) => ({ field: f.field, count: f.count, rate: humanReviewed ? f.count / humanReviewed : 0 }))

  // 系统给出的提示(原因)里,有多少最后确实被人工改了 —— 用来判断哪些规则靠谱、哪些在乱报
  const flagStats = all<{ code: string; flagged: number; edited: number }>(
    `SELECT CASE WHEN instr(j.value, ':') > 0 THEN substr(j.value, 1, instr(j.value, ':') - 1) ELSE j.value END AS code,
            COUNT(*) AS flagged, SUM(CASE WHEN r.edited_fields != '[]' THEN 1 ELSE 0 END) AS edited
       FROM receipts r, json_each(r.reasons) j WHERE r.state = 'approved' AND r.review_mode IS NOT 'bulk' AND ${R}
      GROUP BY code ORDER BY flagged DESC LIMIT 30`,
    ...rangeArgs,
  )
    .filter((f) => !INFO_CODES.has(f.code) && !f.code.startsWith('rotated_')) // 纯提示性的代码(抽检、自动更正…)不属于"规则",不参与可靠度统计
    .map((f) => ({ ...f, rate: f.flagged ? f.edited / f.flagged : 0 }))

  const reviewers = all<{ reviewer: string; approved: number; rejected: number; edited: number; bulk: number }>(
    `SELECT reviewer, SUM(state = 'approved') AS approved, SUM(state = 'rejected') AS rejected,
            SUM(CASE WHEN state = 'approved' AND edited_fields != '[]' THEN 1 ELSE 0 END) AS edited,
            SUM(CASE WHEN state = 'approved' AND review_mode = 'bulk' THEN 1 ELSE 0 END) AS bulk
       FROM receipts WHERE reviewer IS NOT NULL AND ${R} GROUP BY reviewer ORDER BY approved + rejected DESC`,
    ...rangeArgs,
  )

  const daily = all<{ day: string; approved: number; rejected: number }>(
    `SELECT substr(reviewed_at, 1, 10) AS day, SUM(state = 'approved') AS approved, SUM(state = 'rejected') AS rejected
       FROM receipts WHERE reviewed_at IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30`,
  ).reverse()

  const auto = cal.filter((c) => (c.pipeline_status === 'AUTO' || c.pipeline_status === 'AUTO_VERIFIED') && c.state === 'approved' && !c.bulk)
  const autoTotal = auto.reduce((a, c) => a + c.n, 0)
  const autoClean = auto.filter((c) => !c.edited).reduce((a, c) => a + c.n, 0)
  const avgHours = db
    .query<{ h: number | null }, Args>(
      `SELECT AVG((julianday(reviewed_at) - julianday(imported_at)) * 24) AS h FROM receipts WHERE reviewed_at IS NOT NULL AND ${R}`,
    )
    .get(...rangeArgs)!.h

  return {
    range: { from, to },
    currencies,
    currency,
    kpis: {
      total: byState.reduce((a, s) => a + s.n, 0),
      pending: cnt('pending'),
      approved,
      rejected: cnt('rejected'),
      approvedAmounts,
      editRate: humanReviewed ? editedApproved / humanReviewed : null,
      editSample: humanReviewed,
      bulkApproved,
      autoPrecision: autoTotal ? autoClean / autoTotal : null,
      autoSample: autoTotal,
      avgReviewHours: avgHours,
    },
    series, topMerchants, calibration, fieldCorrections, flagStats, reviewers, daily, providers,
  }
}
