/**
 * 收据对账算法(门户前后端共用;Kaggle 流水线里有逻辑等价的 Python 版,两边用同一份测试用例 shared/recon-cases.json 约束)。
 *
 * 要解决的现实问题:
 *  1. 含税价(马来西亚 GST、英国/欧盟 VAT、日本内税:商品价格已含税)和不含税价(美国销售税:最后才加税)并存。
 *  2. 折扣可能在小计之前(商品合计 = 小计 + 折扣),也可能小计是折扣前的数。
 *  3. 服务费、小费、外送/包装等其他费用,以及多种税率混合。
 *  4. 现金舍入(马来西亚/新加坡/澳洲 0.05、瑞士 0.05、日本韩国印尼整数等):容差必须按币种来,不能一刀切。
 *  5. 付款信息(现金 − 找零 = 总额)是独立于其他字段的最强校验。
 *  6. 缺字段时尽量推算出来给员工一键采用;对不上时指出"是哪一行多了/漏了"。
 *
 * 输出是 机器可读的检查结果(id + status + params),界面按语言翻译,不在这里写死任何一种语言的句子。
 */

export interface ReconItem { name?: string; qty: number | null; price: number | null; taxRate?: number | null; discount?: number | null }

export interface ReconInput {
  currency?: string | null
  /** YYYY-MM-DD。只用来判断税制(例如马来西亚 2018-06-01 至 08-31 GST 税率为 0%),没有就跳过这类检查。 */
  date?: string | null
  items?: ReconItem[]
  subtotal?: number | null
  discount?: number | null
  service_charge?: number | null
  tax?: number | null
  tip?: number | null
  fees?: number | null
  rounding?: number | null
  total?: number | null
  paid?: number | null
  change?: number | null
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info'
export type CheckId =
  | 'items_vs_subtotal' | 'total_formula' | 'tax_rate' | 'tax_by_rate' | 'payment_vs_total' | 'rounding_implied'
  | 'currency_missing' | 'tax_in_gst_holiday' | 'non_positive_total' | 'discount_exceeds_subtotal' | 'tax_exceeds_subtotal' | 'item_exceeds_total' | 'paid_less_than_total' | 'rounding_too_large' | 'subtotal_is_total'
export interface ReconCheck { id: CheckId; status: CheckStatus; params: Record<string, number | string | number[]> }

export type FillField = 'subtotal' | 'tax' | 'total' | 'rounding'
export type FillReason = 'items_sum' | 'implied_tax' | 'paid_minus_change' | 'implied_rounding' | 'total_before_rounding' | 'agree_payment_formula' | 'subtotal_from_total' | 'computed_by_rate'
/** 一键采用的推算值。replaces 不为空表示"建议把现有的值改成它"(两个独立来源互相印证时才给)。 */
export interface Fill { field: FillField; value: number; reason: FillReason; replaces: number | null; params: Record<string, number | string> }

export type TaxMode = 'exclusive' | 'inclusive' | 'unknown'
export interface ReconResult {
  mode: TaxMode
  checks: ReconCheck[]
  fills: Fill[]
  hasFail: boolean
  /** 与流水线原有"原因代码"对应的标记(items_sum_ne_subtotal 等),供分流使用。 */
  flags: string[]
}

// ---------------------------------------------------------------- 币种与容差
const ROUND_UNIT: Record<string, number> = {
  MYR: 0.05, SGD: 0.05, AUD: 0.05, CHF: 0.05, CAD: 0.05, BND: 0.05, NZD: 0.1, HKD: 0.1, DKK: 0.5,
  SEK: 1, NOK: 1, JPY: 1, KRW: 10, IDR: 100, INR: 1,
}
/** 销售税因地区而异的币种(美国各州、加拿大各省),税率不在常见列表里是正常的。 */
const LAX_TAX_CURRENCIES = new Set(['USD', 'CAD'])
const COMMON_RATES = [0, 1, 2, 3, 4, 5, 5.5, 6, 7, 7.5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27]
const EPS = 0.011

const SYMBOLS: Record<string, string> = { RM: 'MYR', 'S$': 'SGD', 'US$': 'USD', RP: 'IDR', '€': 'EUR', '£': 'GBP', '₩': 'KRW', '฿': 'THB' }
export function normCurrency(c: string | null | undefined): string | null {
  if (!c) return null
  const raw = c.trim().toUpperCase().replace(/\?/g, '')
  if (SYMBOLS[raw]) return SYMBOLS[raw]!
  return /^[A-Z]{3}$/.test(raw) ? raw : null
}

/** 现金舍入单位:没有现金舍入的币种返回 0.01。 */
export const roundUnit = (currency: string | null | undefined) => ROUND_UNIT[normCurrency(currency) ?? ''] ?? 0.01

const r2 = (x: number) => Math.round(x * 100) / 100
const abs = Math.abs
const n0 = (x: number | null | undefined) => x ?? 0
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// ---------------------------------------------------------------- 主算法
export function reconcile(input: ReconInput): ReconResult {
  const currency = normCurrency(input.currency)
  const unit = roundUnit(currency)
  const items = (input.items ?? []).filter((i) => i.price !== null && i.price !== undefined) as { name?: string; qty: number | null; price: number; taxRate?: number | null; discount?: number | null }[]
  const subtotal = input.subtotal ?? null
  const total = input.total ?? null
  const taxV = input.tax ?? null
  const disc = abs(n0(input.discount)), svc = n0(input.service_charge), tax = n0(taxV), tip = n0(input.tip), fees = n0(input.fees)
  const rndGiven = input.rounding !== null && input.rounding !== undefined
  const rnd = n0(input.rounding)
  const paid = input.paid ?? null
  const change = input.change ?? null

  const checks: ReconCheck[] = []
  const fills: Fill[] = []
  const flags: string[] = []
  const push = (id: CheckId, status: CheckStatus, params: ReconCheck['params'] = {}) => checks.push({ id, status, params })

  // 现金舍入造成的最大误差是 unit/2;已经写明舍入金额时只允许分位误差。
  const slackNoRnd = (unit >= 0.05 ? unit / 2 : 0) + EPS
  const slackTotal = rndGiven ? EPS : slackNoRnd

  // ---- 1. 商品行: 两种解读(price 是单价 / 价格已是行小计)
  const lineU = items.map((i) => r2(i.price * (i.qty ?? 1)))
  const lineL = items.map((i) => i.price)
  const sumL = r2(sum(lineL)), sumU = r2(sum(lineU))
  const hasQty = items.some((i) => i.qty !== null && i.qty !== 1)
  // 每行自己印着折扣时,金额可能是折扣前的,也可能已经是折扣后的: 再多试「扣掉这一行折扣」的读法(折扣为 0 / 没有时与上面相同,不重复)
  const lineDisc = items.map((i) => abs(n0(i.discount)))
  const hasLineDisc = lineDisc.some((x) => x > EPS)
  const lineLD = items.map((i, k) => r2(lineL[k]! - lineDisc[k]!))
  const lineUD = items.map((i, k) => r2(lineU[k]! - lineDisc[k]!))
  const sumLD = r2(sum(lineLD)), sumUD = r2(sum(lineUD))

  // ---- 2. 总额公式: 在"含税/不含税 × 折扣是否另算"几种假设里找最吻合的
  type Hyp = { mode: 'exclusive' | 'inclusive'; discApplied: boolean; expected: number }
  const hypsFor = (S: number): Hyp[] => {
    const out: Hyp[] = []
    for (const mode of ['exclusive', 'inclusive'] as const) {
      for (const da of disc > 0 ? [true, false] : [false]) {
        out.push({ mode, discApplied: da, expected: r2(S - (da ? disc : 0) + svc + fees + tip + rnd + (mode === 'exclusive' ? tax : 0)) })
      }
    }
    return out
  }
  const pickBest = (S: number): Hyp | null => {
    if (total === null) return null
    const hs = hypsFor(S)
    return hs.reduce((best, h) => (abs(total - h.expected) < abs(total - best.expected) - 1e-9 ? h : best), hs[0]!)
  }

  // 小计缺失、商品又带数量时,两种解读各试一次
  const candidates: { S: number; viaItems: boolean; sumItems: number }[] = []
  if (subtotal !== null) candidates.push({ S: subtotal, viaItems: false, sumItems: NaN })
  else if (items.length) {
    candidates.push({ S: sumL, viaItems: true, sumItems: sumL })
    if (hasQty) candidates.push({ S: sumU, viaItems: true, sumItems: sumU })
    if (hasLineDisc) candidates.push({ S: sumLD, viaItems: true, sumItems: sumLD })
  }
  let best: { hyp: Hyp; S: number; viaItems: boolean } | null = null
  for (const c of candidates) {
    const h = pickBest(c.S)
    if (h && (!best || abs(total! - h.expected) < abs(total! - best.hyp.expected))) best = { hyp: h, S: c.S, viaItems: c.viaItems }
  }

  let mode: TaxMode = 'unknown'
  let formulaOk: boolean | null = null
  if (best && total !== null) {
    const res = r2(total - best.hyp.expected)
    formulaOk = abs(res) <= slackTotal + 1e-9
    // 税为 0/缺失时含税与不含税无法区分
    if (formulaOk && tax > 0) {
      const other = hypsFor(best.S).filter((h) => h.mode !== best!.hyp.mode)
      const otherFits = other.some((h) => abs(total - h.expected) <= slackTotal)
      mode = otherFits && best.hyp.mode === 'inclusive' ? 'exclusive' : best.hyp.mode
    }
    if (formulaOk) {
      push('total_formula', 'ok', { mode, expected: best.hyp.expected, total, diff: res })
      if (!rndGiven && abs(res) >= 0.005 && unit >= 0.05 && abs(res) <= unit / 2 + EPS) {
        push('rounding_implied', 'info', { amount: res })
        fills.push({ field: 'rounding', value: res, reason: 'implied_rounding', replaces: null, params: {} })
      }
      if (subtotal === null && best.viaItems) fills.push({ field: 'subtotal', value: best.S, reason: 'items_sum', replaces: null, params: {} })
    } else {
      // 很常见的一种: 票上先印「含税合计 65.72」,下一行才是「舍入 −0.02」和最后的「应付 65.70」,模型把舍入之前的合计读成了总额。
      // 判断依据: 舍入已经写明、很小,而且「总额 = 公式结果 − 舍入」恰好成立 → 总额应该是公式的结果(即舍入之后的数)。
      const preRounding = rndGiven && abs(rnd) > EPS && abs(rnd) <= Math.max(unit, 0.05) + EPS && abs(total - r2(best.hyp.expected - rnd)) <= EPS
      push('total_formula', 'fail', { mode: best.hyp.mode, expected: best.hyp.expected, total, diff: res, hint: preRounding ? 'total_before_rounding' : residualHint(res, best.S, { tax, svc, tip, fees, disc }) })
      flags.push('totals_dont_add_up')
      if (preRounding) fills.push({ field: 'total', value: best.hyp.expected, reason: 'total_before_rounding', replaces: total, params: {} })
      // 缺税额:差额正好是常见税率 × 小计 → 给出可采用的税额
      if (res > 0 && taxV === null && best.S > 0) {
        const rate = matchRate(res, [best.S, best.S + svc], 1)
        if (rate !== null) fills.push({ field: 'tax', value: res, reason: 'implied_tax', replaces: null, params: { rate } })
      }
    }
  }

  // ---- 2b. 小计读成了含税合计: 小计和总额一样,可是还有税/服务费/小费要另算,总额公式又对不上。
  //      (含税价的收据里小计等于总额是正常的,但那种收据公式会通过,不会走到这里。)
  //      这条只指向"小计"一个字段,比"总额公式对不上"(总额/小计/税额都被怀疑)更具体。
  if (subtotal !== null && total !== null && formulaOk === false && abs(subtotal - total) <= slackTotal && tax + svc + fees + tip > EPS) {
    const derived = r2(total + disc - tax - svc - fees - tip - rnd) // 反推: 总额 = 小计 − 折扣 + 服务费 + 其他费 + 小费 + 舍入 + 税
    push('subtotal_is_total', 'warn', { subtotal, total, derived })
    flags.push('subtotal_is_total')
    // 有商品行、而且商品合计正好等于反推出来的小计 → 两个独立来源互相印证,才建议改
    if (derived > 0 && items.length && [sumL, sumU].some((x) => abs(x - derived) <= EPS)) {
      fills.push({ field: 'subtotal', value: derived, reason: 'subtotal_from_total', replaces: subtotal, params: {} })
    }
  }

  // ---- 3. 商品合计 vs 小计(没有小计时对照由总额反推出的小计)
  const refs: { value: number; label: string; slack: number }[] = []
  if (subtotal !== null) {
    refs.push({ value: subtotal, label: 'subtotal', slack: EPS })
    if (disc > 0) refs.push({ value: r2(subtotal + disc), label: 'subtotal_before_discount', slack: EPS })
    // 商品标价已经含税(马来西亚 GST 收据很常见): 这时商品合计等于「总额 − 服务费/其他费/小费/舍入」,而小计是不含税的,两者本来就相差税额。
    if (total !== null && tax > 0) {
      const incl = r2(total - (svc + fees + tip + rnd))
      refs.push({ value: incl, label: 'items_tax_incl', slack: slackTotal })
      if (disc > 0) refs.push({ value: r2(incl + disc), label: 'items_tax_incl', slack: slackTotal })
    }
  } else if (total !== null) {
    const rest = svc + fees + tip + rnd
    const ex = r2(total - tax - rest), inc = r2(total - rest)
    const dl = slackTotal
    refs.push({ value: ex, label: 'derived_from_total', slack: dl })
    if (tax > 0) refs.push({ value: inc, label: 'derived_from_total_incl_tax', slack: dl })
    if (disc > 0) { refs.push({ value: r2(ex + disc), label: 'derived_from_total', slack: dl }); if (tax > 0) refs.push({ value: r2(inc + disc), label: 'derived_from_total_incl_tax', slack: dl }) }
  }
  if (items.length && refs.length) {
    type LineModel = 'L' | 'U' | 'LD' | 'UD'
    let bestPair: { model: LineModel; sumItems: number; ref: (typeof refs)[number]; diff: number } | null = null
    const models: [LineModel, number][] = hasQty ? [['L', sumL], ['U', sumU]] : [['L', sumL]]
    if (hasLineDisc) models.push(['LD', sumLD], ...(hasQty ? [['UD', sumUD] as [LineModel, number]] : []))
    for (const [model, s] of models) for (const ref of refs) {
      const diff = r2(ref.value - s)
      if (!bestPair || abs(diff) < abs(bestPair.diff)) bestPair = { model, sumItems: s, ref, diff }
    }
    const p = bestPair!
    const itemSlack = p.ref.slack
    if (abs(p.diff) <= itemSlack) {
      push('items_vs_subtotal', 'ok', { itemsSum: p.sumItems, ref: p.ref.value, refLabel: p.ref.label, model: p.model })
    } else {
      const lines = p.model === 'U' ? lineU : p.model === 'LD' ? lineLD : p.model === 'UD' ? lineUD : lineL
      const extra = lines.map((l, i) => (abs(r2(p.sumItems - l) - p.ref.value) <= itemSlack ? i : -1)).filter((i) => i >= 0)
      const params: ReconCheck['params'] = { itemsSum: p.sumItems, ref: p.ref.value, refLabel: p.ref.label, diff: p.diff, model: p.model }
      if (extra.length) params.extraItems = extra          // 去掉其中任意一行就能对上: 很可能是多出来的/重复的行
      else if (p.diff > 0) params.missingAmount = p.diff   // 合计偏小: 可能漏了一行,金额正好是差额
      push('items_vs_subtotal', 'fail', params)
      flags.push('items_sum_ne_subtotal')
    }
  }

  // ---- 3b. 按税率分组独立算税(每一行都标了税率时才做)
  //      税额 = 每个税率组「不含税金额 × 税率」之和,不能拿总额统一乘一个税率: 零税率和标准税率混在一张单上时(如马来西亚 GST 的 SR 6% 加 ZRL 0%),统一反推会错。
  //      行金额的两种解读(单价/行小计)、含税/不含税、整单折扣先扣还是不扣,各试一遍,取「算出的总额能对上」的那个——
  //      对得上才算数,所以这个值有商品行+税率、总额两个来源互相印证,可以放心建议采用。
  if (items.length && total !== null && items.every((i) => typeof i.taxRate === 'number' && i.taxRate >= 0 && i.taxRate <= 30)) {
    const gross = (lines: number[]) => lines.reduce((a, b) => a + b, 0)
    type Cand = { model: 'L' | 'U'; mode: 'exclusive' | 'inclusive'; discApplied: boolean; groups: { rate: number; base: number; tax: number }[]; taxSum: number; subtotal: number; expected: number }
    const cands: Cand[] = []
    for (const [model, lines] of (hasQty ? [['L', lineL], ['U', lineU]] : [['L', lineL]]) as ['L' | 'U', number[]][]) {
      const byRate = new Map<number, number>()
      items.forEach((it, i) => byRate.set(it.taxRate!, (byRate.get(it.taxRate!) ?? 0) + lines[i]!))
      const g = gross(lines)
      for (const mode of ['exclusive', 'inclusive'] as const) for (const discApplied of disc > 0 ? [true, false] : [false]) {
        const d = discApplied ? disc : 0
        const groups = [...byRate.entries()].map(([rate, amt0]) => {
          const amt = g > 0 ? amt0 * (1 - d / g) : amt0 // 整单折扣按各组金额的比例分摊
          const tax = r2(mode === 'inclusive' ? amt - amt / (1 + rate / 100) : (amt * rate) / 100)
          return { rate, base: r2(mode === 'inclusive' ? amt - tax : amt), tax }
        })
        const taxSum = r2(sum(groups.map((x) => x.tax)))
        const netSum = r2(sum(groups.map((x) => x.base)))
        const expected = r2(netSum + taxSum + svc + fees + tip + rnd)
        cands.push({ model, mode, discApplied, groups, taxSum, subtotal: r2(netSum + d), expected })
      }
    }
    const slack = slackTotal + 0.01 * new Set(items.map((i) => i.taxRate)).size
    const fitting = cands.filter((c) => abs(total - c.expected) <= slack)
    const taxFits = (c: Cand) => taxV !== null && abs(c.taxSum - tax) <= 0.01 * c.groups.length + EPS
    // 优先: 税额也对得上的 > 不含折扣假设的(更简单) > 单价/行小计里行小计优先
    const chosen = fitting.length ? [...fitting].sort((a, b) => Number(taxFits(b)) - Number(taxFits(a)) || Number(a.discApplied) - Number(b.discApplied) || Number(a.model === 'U') - Number(b.model === 'U'))[0]! : null
    if (chosen) {
      const flat = chosen.groups.flatMap((x) => [x.rate, x.base, x.tax])
      const common = { mode: chosen.mode, computed: chosen.taxSum, groups: flat }
      if (taxV !== null && taxFits(chosen)) push('tax_by_rate', 'ok', common)
      else if (taxV !== null) {
        push('tax_by_rate', 'warn', { ...common, tax })
        flags.push('tax_differs_by_rate')
        fills.push({ field: 'tax', value: chosen.taxSum, reason: 'computed_by_rate', replaces: taxV, params: {} })
      } else if (chosen.taxSum > 0) {
        push('tax_by_rate', 'info', common)
        fills.push({ field: 'tax', value: chosen.taxSum, reason: 'computed_by_rate', replaces: null, params: {} })
      }
      if (subtotal === null) {
        // 含税价时「商品合计」不是小计,这里给的小计是不含税的;盖过上面「商品合计即小计」那条更粗糙的推算
        for (let k = fills.length - 1; k >= 0; k--) if (fills[k]!.field === 'subtotal' && fills[k]!.reason === 'items_sum') fills.splice(k, 1)
        fills.push({ field: 'subtotal', value: chosen.subtotal, reason: 'computed_by_rate', replaces: null, params: {} })
      }
    }
  }

  // ---- 4. 税率合理性: 含税价用 tax/(含税额-tax),不含税价用 tax/税基
  if (taxV !== null && tax > 0 && best && best.S > 0) {
    const S = best.S
    const bases = uniq([S, r2(S - disc), r2(S + svc), r2(S - disc + svc), r2(S + svc + fees), r2(S - disc + svc + fees)]).filter((b) => b > 0)
    const wantInclusive = mode === 'inclusive'
    const tryModes: boolean[] = mode === 'unknown' ? [false, true] : [wantInclusive]
    const perLine = 0.01 * Math.max(1, items.length) + EPS
    let matched: { rate: number; base: number } | null = null
    let firstRate: number | null = null
    for (const inc of tryModes) {
      const bs = inc ? bases.map((b) => r2(b - tax)).filter((b) => b > 0) : bases
      for (const b of bs) {
        firstRate ??= (tax / b) * 100
        for (const r of COMMON_RATES) if (r > 0 && abs(tax - (r / 100) * b) <= perLine && !matched) matched = { rate: r, base: b }
      }
    }
    if (matched) push('tax_rate', 'ok', { rate: matched.rate, base: matched.base })
    else {
      const rate = r2(firstRate ?? 0)
      if (rate > 30 || rate < 0) { push('tax_rate', 'warn', { rate }); flags.push('tax_rate_odd') }
      else if (LAX_TAX_CURRENCIES.has(currency ?? '')) push('tax_rate', 'info', { rate, kind: 'local' })
      else push('tax_rate', 'info', { rate, kind: 'mixed' })       // 多种税率混合或非常规税率,不算错
    }
  }

  // ---- 5. 付款核对(独立于其他字段):付款 − 找零 = 总额
  if (paid !== null && change !== null) {
    const implied = r2(paid - change)
    if (total !== null) {
      const diff = r2(implied - total)
      if (abs(diff) <= slackNoRnd) push('payment_vs_total', 'ok', { paid, change, implied, total })
      else {
        push('payment_vs_total', 'fail', { paid, change, implied, total, diff })
        flags.push('payment_mismatch')
        // 付款推算值和对账公式算出的总额互相印证,而与现有总额不同 → 建议改
        if (best && formulaOk === false && abs(implied - best.hyp.expected) <= slackNoRnd) {
          fills.push({ field: 'total', value: implied, reason: 'agree_payment_formula', replaces: total, params: {} })
        }
      }
    } else fills.push({ field: 'total', value: implied, reason: 'paid_minus_change', replaces: null, params: {} })
  } else if (paid !== null && total !== null && paid + slackNoRnd < total) {
    push('paid_less_than_total', 'warn', { paid, total })
    flags.push('paid_less_than_total')
  }

  // ---- 6. 常识检查
  if (total !== null && total <= 0) push('non_positive_total', 'warn', { total })
  if (subtotal !== null && subtotal > 0 && disc > subtotal + EPS) { push('discount_exceeds_subtotal', 'warn', { discount: disc, subtotal }); flags.push('discount_exceeds_subtotal') }
  if (subtotal !== null && subtotal > 0 && tax > subtotal + EPS) { push('tax_exceeds_subtotal', 'warn', { tax, subtotal }); flags.push('tax_exceeds_subtotal') }
  if (total !== null && total > 0 && items.length > 1) {
    const big = items.findIndex((i) => i.price > total + slackNoRnd)
    if (big >= 0) { push('item_exceeds_total', 'warn', { index: big, price: items[big]!.price, total }); flags.push('item_exceeds_total') }
  }
  // 现金舍入只会把总额调到最近的舍入单位,所以调整额最大是 unit/2(马币 0.05 → 最多 ±0.02;总额按分计,0.025 取不到)。没有现金舍入的币种,舍入一栏本来就不该出现,超过 0.05 就算大。
  // 分两档: 超过 unit/2 但没到 0.05,只提示「不在标准范围」(现实里有的店不按最近的 0.05 舍,而是一律进位/舍去,所以不能拦住自动通过);超过 0.05 才是警告。
  const roundLimit = unit >= 0.05 ? unit / 2 : 0.05
  if (rndGiven && abs(rnd) > Math.max(unit, 0.05) + EPS) { push('rounding_too_large', 'warn', { rounding: rnd }); flags.push('rounding_too_large') }
  else if (rndGiven && abs(rnd) > roundLimit + 1e-9) push('rounding_too_large', 'info', { rounding: rnd, limit: roundLimit })
  // 马来西亚 2018-06-01 至 2018-08-31: GST 税率调为 0%,而 SST 要到 9 月 1 日才开始,这段时间收据上不该有税额
  if (currency === 'MYR' && taxV !== null && tax > 0 && input.date && input.date >= '2018-06-01' && input.date <= '2018-08-31') {
    push('tax_in_gst_holiday', 'warn', { tax, date: input.date })
    flags.push('tax_in_gst_holiday')
  }
  // 币种没读出来: 现金舍入的容差用不上,小的舍入差会被当成对不上。提示一下,让员工补上
  if (!currency && total !== null) push('currency_missing', 'info', {})

  // 去重(同一字段同一原因只留一条建议)
  const seen = new Set<string>()
  const uniqueFills = fills.filter((f) => { const k = `${f.field}:${f.value}`; if (seen.has(k)) return false; seen.add(k); return true })
  return { mode, checks, fills: uniqueFills, hasFail: checks.some((c) => c.status === 'fail'), flags: [...new Set(flags)] }
}

// ---------------------------------------------------------------- 辅助
const uniq = (xs: number[]) => [...new Set(xs)]

/** 差额正好是某个常见税率 × 税基 → 返回该税率(百分比),否则 null。 */
function matchRate(amount: number, bases: number[], lines: number): number | null {
  const tol = 0.01 * Math.max(1, lines) + EPS
  for (const b of bases) for (const r of COMMON_RATES) if (r > 0 && abs(amount - (r / 100) * b) <= tol) return r
  return null
}

/** 总额对不上时,猜一猜差额是什么造成的(只做提示,不改数据)。 */
function residualHint(res: number, S: number, c: { tax: number; svc: number; tip: number; fees: number; disc: number }): string {
  const a = abs(res)
  if (res > 0) {
    if (c.tax === 0 && S > 0 && matchRate(a, [S], 1) !== null) return 'tax_missing'
    return 'amount_missing'            // 总额比各部分之和大:漏了一项费用/小费/税
  }
  if (c.tax > 0 && abs(a - c.tax) <= EPS) return 'tax_already_included'
  if (c.disc > 0 && abs(a - c.disc) <= EPS) return 'discount_double'
  if (c.svc > 0 && abs(a - c.svc) <= EPS) return 'service_double'
  if (c.tip > 0 && abs(a - c.tip) <= EPS) return 'tip_double'
  return 'amount_extra'                // 总额比各部分之和小:某个金额多算了或折扣没填
}
