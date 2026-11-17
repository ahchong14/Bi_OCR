import { AccuracyCard } from '../components/AccuracyCard'
import { DateInput } from '../components/DateInput'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Analytics, FieldKey, Granularity } from '../../../shared/types'
import { api } from '../api'
import { Card, Empty, Kpi, Loading, Segmented } from '../components/ui'
import { useI18n, type Key, type T } from '../i18n'
import { codeName } from '../lib/explain'
import { duration, money, moneyC, pct } from '../lib/format'

type Preset = 'all' | '30' | '90' | 'year' | 'custom'
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

function rangeOf(p: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const today = new Date()
  if (p === 'all') return {}
  if (p === 'custom') return { from: custom.from || undefined, to: custom.to || undefined }
  if (p === 'year') return { from: `${today.getFullYear()}-01-01`, to: iso(today) }
  const from = new Date(today)
  from.setDate(from.getDate() - Number(p))
  return { from: iso(from), to: iso(today) }
}

const short = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const compact = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n)))

const axis = { stroke: 'var(--muted)', fontSize: 12, tickLine: false } as const
const tip = { contentStyle: { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }, cursor: { fill: 'var(--panel2)' } }

/** 根据数据自动给出几句人话结论,帮管理者快速抓住重点。 */
/** 样本太少时,百分比没有统计意义: 不下结论,只提醒"样本不足"。 */
export const MIN_SAMPLE = 30

function insights(a: Analytics, t: T, field: (k: FieldKey) => string): { tone: 'good' | 'warn' | 'bad'; text: string }[] {
  const out: { tone: 'good' | 'warn' | 'bad'; text: string }[] = []
  const k = a.kpis
  const enough = k.editSample >= MIN_SAMPLE
  if (!enough) out.push({ tone: 'warn', text: t('an.ins.fewSamples', { n: k.editSample, min: MIN_SAMPLE }) })
  if (k.bulkApproved > 0) out.push({ tone: 'warn', text: t('an.ins.bulk', { n: k.bulkApproved }) })
  if (k.autoPrecision !== null && k.autoSample >= MIN_SAMPLE) {
    out.push(k.autoPrecision >= 0.95
      ? { tone: 'good', text: t('an.ins.autoGood', { p: pct(k.autoPrecision), n: k.autoSample }) }
      : { tone: 'bad', text: t('an.ins.autoBad', { p: pct(k.autoPrecision), n: k.autoSample }) })
  }
  const top = a.fieldCorrections[0]
  if (enough && top && top.rate >= 0.1) out.push({ tone: 'warn', text: t('an.ins.topField', { field: field(top.field), p: pct(top.rate) }) })
  const noisy = enough ? a.flagStats.find((f) => f.flagged >= 10 && f.rate < 0.2) : undefined
  if (noisy) out.push({ tone: 'warn', text: t('an.ins.noisy', { name: codeName(noisy.code, t), n: noisy.flagged, p: pct(noisy.rate) }) })
  const review = a.calibration.find((c) => c.status === 'REVIEW')
  if (review) {
    const done = review.approvedUnchanged + review.approvedEdited
    if (done >= MIN_SAMPLE && review.approvedUnchanged / done > 0.6) out.push({ tone: 'warn', text: t('an.ins.strict', { p: pct(review.approvedUnchanged / done) }) })
  }
  if (k.pending > 0) out.push({ tone: 'warn', text: t('an.ins.pending', { n: k.pending }) })
  return out
}

/** 识别来源的显示名。minicpm-ocr / ocr.space 是识别服务;scan 是以前没记录来源的门户扫描批次;zip / json 是流水线导入。 */
function providerLabel(p: string, t: T): string {
  if (p === 'minicpm-ocr') return 'MiniCPM-OCR'
  if (p === 'claude-haiku-5-5') return 'Claude Haiku 5.5'
  if (p === 'ocr.space') return 'OCR.space'
  const k = `an.p.${p}` as Key
  const s = t(k)
  return s === k ? p : s
}

export default function AnalyticsPage() {
  const { t, field } = useI18n()
  const [preset, setPreset] = useState<Preset>('all')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [currency, setCurrency] = useState('')
  const [granularity, setGranularity] = useState<Granularity>('month')
  const range = useMemo(() => rangeOf(preset, custom), [preset, custom])

  const q = useQuery({
    queryKey: ['analytics', range, currency, granularity],
    queryFn: () => api.analytics({ ...range, currency: currency || undefined, granularity }),
    placeholderData: keepPreviousData,
  })
  const a = q.data
  if (!a) return <div className="page"><Loading text={t('an.computing')} /></div>
  if (a.kpis.total === 0) return <div className="page"><Empty icon="📊" title={t('an.empty.title')}>{t('an.empty.body')}</Empty></div>

  const k = a.kpis
  const cur = a.currency
  const curLabel = cur ? `(${cur})` : ''
  const main = k.approvedAmounts.find((x) => x.currency === cur)
  const others = k.approvedAmounts.filter((x) => x.currency !== cur && x.currency !== null)
  const tips = insights(a, t, field)

  const calData = a.calibration.map((c) => ({ name: t(`status.${c.status}` as Key), [t('an.c.unchanged')]: c.approvedUnchanged, [t('an.c.edited')]: c.approvedEdited, [t('an.c.rejected')]: c.rejected, [t('an.c.pending')]: c.pending }))
  const calHasData = a.calibration.some((c) => c.approvedUnchanged + c.approvedEdited + c.rejected + c.pending > 0)
  const ChartEmpty = () => <div className="chart-empty">{t('an.noData')}</div>

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('an.title')}</h1>
          <p className="muted">{t('an.subtitle')}{q.isFetching && ` ${t('common.updating')}`}</p>
        </div>
        <div className="row gap wrap">
          <Segmented<Preset> value={preset} onChange={setPreset} options={[{ value: 'all', label: t('an.range.all') }, { value: '30', label: t('an.range.30') }, { value: '90', label: t('an.range.90') }, { value: 'year', label: t('an.range.year') }, { value: 'custom', label: t('an.range.custom') }]} />
          {preset === 'custom' && (
            <div className="daterange" role="group"><DateInput label={t('data.f.dateFrom')} value={custom.from} onChange={(v) => setCustom({ ...custom, from: v })} /> – <DateInput label={t('data.f.dateTo')} value={custom.to} onChange={(v) => setCustom({ ...custom, to: v })} /></div>
          )}
          {a.currencies.length > 1 && (
            <select value={cur ?? ''} onChange={(e) => setCurrency(e.target.value)} aria-label={t('col.currency')}>{a.currencies.map((c) => <option key={c}>{c}</option>)}</select>
          )}
        </div>
      </div>

      <div className="kpis">
        <Kpi label={t('an.kpi.approved')} value={k.approved} sub={t('an.kpi.approvedSub', { total: k.total, rejected: k.rejected })} />
        <Kpi label={t('an.kpi.amount', { cur: curLabel })} value={main ? money(main.sum) : '—'}
          sub={main ? t('an.kpi.amountSub', { avg: money(main.avg) }) + (others.length ? t('an.kpi.amountOthers', { others: others.map((o) => moneyC(o.sum, o.currency)).join(', ') }) : '') : t('an.kpi.noAmount')} />
        <Kpi label={t('an.kpi.pending')} value={k.pending} tone={k.pending ? 'warn' : 'good'} sub={k.pending ? t('an.kpi.pendingSub') : t('an.kpi.pendingDone')} />
        <Kpi label={t('an.kpi.editRate')} value={pct(k.editRate)} sub={t('an.kpi.editRateSub', { n: k.editSample })} tone={k.editSample >= MIN_SAMPLE && k.editRate !== null && k.editRate > 0.3 ? 'warn' : undefined} />
        <Kpi label={t('an.kpi.autoPrecision')} value={pct(k.autoPrecision)} sub={t('an.kpi.autoPrecisionSub', { n: k.autoSample }) + (k.autoSample < MIN_SAMPLE ? ' ' + t('an.fewTag') : '')} tone={k.autoPrecision === null || k.autoSample < MIN_SAMPLE ? undefined : k.autoPrecision >= 0.95 ? 'good' : 'bad'} />
        <Kpi label={t('an.kpi.avgTime')} value={duration(k.avgReviewHours, t)} sub={t('an.kpi.avgTimeSub')} />
      </div>

      {tips.length > 0 && (
        <section className="insights">
          <h3>{t('an.insights')}</h3>
          <ul>{tips.map((x) => <li key={x.text} className={x.tone}>{x.text}</li>)}</ul>
        </section>
      )}

      <div className="charts">
        <Card className="span2" title={t('an.c.spend', { cur: curLabel })} hint={t('an.c.spendHint')}
          right={<Segmented<Granularity> value={granularity} onChange={setGranularity} options={[{ value: 'day', label: t('an.gran.day') }, { value: 'week', label: t('an.gran.week') }, { value: 'month', label: t('an.gran.month') }]} />}>
          {a.series.length === 0 ? <ChartEmpty /> : (
            <ResponsiveContainer role="img" aria-label={t('an.chartAria')} width="100%" height={280}>
              <BarChart data={a.series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="period" {...axis} /><YAxis {...axis} tickFormatter={compact} width={48} />
                <Tooltip {...tip} formatter={(v, name) => [name === 'sum' ? money(Number(v)) : v, name === 'sum' ? t('an.c.amount') : t('an.c.count')]} />
                <Bar dataKey="sum" name="sum" fill="var(--c1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title={t('an.c.merchants')} hint={t('an.c.merchantsHint')}>
          {a.topMerchants.length === 0 ? <ChartEmpty /> : (
            <ResponsiveContainer role="img" aria-label={t('an.chartAria')} width="100%" height={Math.max(240, a.topMerchants.length * 34)}>
              <BarChart data={a.topMerchants.map((m) => ({ ...m, name: short(m.merchant) }))} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} />
                <XAxis type="number" {...axis} tickFormatter={compact} /><YAxis type="category" dataKey="name" {...axis} width={190} />
                <Tooltip {...tip} formatter={(v) => [money(Number(v)), t('an.c.amount')]} labelFormatter={(_, p) => (p?.[0]?.payload as { merchant?: string } | undefined)?.merchant ?? ''} />
                <Bar dataKey="sum" fill="var(--c2)" radius={[0, 4, 4, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title={t('an.c.calib')} hint={t('an.c.calibHint')}>
          {!calHasData ? <ChartEmpty /> : (
            <ResponsiveContainer role="img" aria-label={t('an.chartAria')} width="100%" height={280}>
              <BarChart data={calData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="name" {...axis} /><YAxis {...axis} allowDecimals={false} width={32} />
                <Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey={t('an.c.unchanged')} stackId="a" fill="var(--good)" /><Bar dataKey={t('an.c.edited')} stackId="a" fill="var(--warn)" />
                <Bar dataKey={t('an.c.rejected')} stackId="a" fill="var(--bad)" /><Bar dataKey={t('an.c.pending')} stackId="a" fill="var(--c5)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {a.providers.length > 0 && (
          <Card className="span2" title={t('an.c.providers')} hint={t('an.c.providersHint')}>
            <table className="mini wide">
              <thead><tr><th>{t('an.p.source')}</th><th className="num">{t('an.p.count')}</th><th className="num">{t('an.p.states')}</th><th className="num">{t('an.p.auto')}</th><th className="num">{t('an.p.review')}</th><th className="num">{t('an.p.edit')}</th><th className="num">{t('an.p.secs')}</th></tr></thead>
              <tbody>
                {a.providers.map((p) => (
                  <tr key={p.provider}>
                    <td title={p.provider}>{providerLabel(p.provider, t)}</td><td className="num">{p.count}</td>
                    <td className="num">{p.pending} / {p.approved} / {p.rejected}</td>
                    <td className="num">{pct(p.autoShare)}</td><td className="num">{pct(p.reviewShare)}</td>
                    <td className="num" title={p.editSample > 0 && p.editSample < MIN_SAMPLE ? t('an.p.fewSamples', { n: MIN_SAMPLE }) : undefined}>
                      {p.editRate === null ? '—' : `${pct(p.editRate)} (n=${p.editSample})`}{p.editSample > 0 && p.editSample < MIN_SAMPLE ? ' ⚠' : ''}
                    </td>
                    <td className="num">{p.avgSeconds === null ? '—' : `${p.avgSeconds.toFixed(1)}s (n=${p.timedCount})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <AccuracyCard />

        <Card title={t('an.c.fields')} hint={t('an.c.fieldsHint')}>
          {a.fieldCorrections.length === 0 ? <ChartEmpty /> : (
            <ResponsiveContainer role="img" aria-label={t('an.chartAria')} width="100%" height={Math.max(220, a.fieldCorrections.length * 36)}>
              <BarChart data={a.fieldCorrections.map((f) => ({ ...f, name: field(f.field), percent: Math.round(f.rate * 100) }))} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} />
                <XAxis type="number" {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} /><YAxis type="category" dataKey="name" {...axis} width={90} />
                <Tooltip {...tip} formatter={(v, _n, p) => [t('an.c.fieldTip', { p: Number(v), n: (p.payload as { count: number }).count }), t('an.c.editedRate')]} />
                <Bar dataKey="percent" fill="var(--c3)" radius={[0, 4, 4, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title={t('an.c.daily')} hint={t('an.c.dailyHint')}>
          {a.daily.length === 0 ? <ChartEmpty /> : (
            <ResponsiveContainer role="img" aria-label={t('an.chartAria')} width="100%" height={240}>
              <BarChart data={a.daily} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} /><YAxis {...axis} allowDecimals={false} width={32} />
                <Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="approved" name={t('an.c.approve')} stackId="d" fill="var(--good)" /><Bar dataKey="rejected" name={t('an.c.reject')} stackId="d" fill="var(--bad)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="span2" title={t('an.c.flags')} hint={t('an.c.flagsHint')}>
          {a.flagStats.length === 0 ? <ChartEmpty /> : (
            <table className="mini wide">
              <thead><tr><th>{t('an.c.flag')}</th><th className="num">{t('an.c.flagged')}</th><th className="num">{t('an.c.flagEdited')}</th><th style={{ width: '32%' }}>{t('an.c.flagRate')}</th></tr></thead>
              <tbody>
                {a.flagStats.map((f) => (
                  <tr key={f.code}>
                    <td title={f.code}>{codeName(f.code, t)}</td><td className="num">{f.flagged}</td><td className="num">{f.edited}</td>
                    <td><div className="bar"><div className={f.rate >= 0.5 ? 'good' : f.rate >= 0.2 ? 'warn' : 'bad'} style={{ width: `${Math.round(f.rate * 100)}%` }} /><span>{pct(f.rate)}</span></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="span2" title={t('an.c.reviewers')} hint={t('an.c.reviewersHint')}>
          {a.reviewers.length === 0 ? <ChartEmpty /> : (
            <table className="mini wide">
              <thead><tr><th>{t('app.reviewer')}</th><th className="num">{t('an.c.approvedN')}</th><th className="num">{t('an.c.rejectedN')}</th><th className="num">{t('an.c.editedN')}</th><th className="num">{t('an.c.editRate')}</th></tr></thead>
              <tbody>{a.reviewers.map((r) => <tr key={r.reviewer}><td>{r.reviewer}</td><td className="num">{r.approved}</td><td className="num">{r.rejected}</td><td className="num">{r.edited}</td><td className="num">{r.approved ? pct(r.edited / r.approved) : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
