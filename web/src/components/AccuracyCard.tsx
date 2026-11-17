import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AccuracyField, AccuracyReport } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../context'
import { useI18n, type Key, type T } from '../i18n'
import { pct } from '../lib/format'
import { Card } from './ui'

const MIN = 30 // 样本少于这个数,百分比只能当参考
const FIELDS = ['total', 'date', 'company'] as const

const providerName = (p: string, t: T) => (p === 'zip' ? t('an.p.zip') : p === 'json' ? t('an.p.json') : p === 'unknown' ? t('an.p.scan') : p)

function Cell({ f, t }: { f: AccuracyField; t: T }) {
  if (!f.n) return <td className="num muted">—</td>
  return (
    <td className="num" title={t('acc.cellHint', { a: f.machine, n: f.n })}>
      <b>{pct(f.machine / f.n)}</b> <span className="muted">({f.machine}/{f.n}){f.n < MIN ? ' ⚠' : ''}</span>
      {f.finalN > 0 && <div className="small muted">{t('acc.afterReview', { p: pct(f.final / f.finalN), a: f.final, n: f.finalN })}</div>}
    </td>
  )
}

/** 对照标准答案: 机器读对了多少、人工改完后又对了多少、具体读错了哪些。需要先导入标准答案 CSV。 */
export function AccuracyCard() {
  const { t } = useI18n()
  const { setImportOpen, setImportTab } = useApp()
  const q = useQuery({ queryKey: ['accuracy'], queryFn: api.accuracy, staleTime: 10_000 })
  const [field, setField] = useState<'all' | (typeof FIELDS)[number]>('all')
  const r: AccuracyReport | undefined = q.data
  if (!r) return null

  if (r.labelled === 0) {
    return (
      <Card className="span2" title={t('acc.title')} hint={t('acc.hintNone')}>
        <p className="muted">{t('acc.none')}</p>
        <button className="btn" onClick={() => { setImportTab('truth'); setImportOpen(true) }}>{t('acc.importBtn')}</button>
      </Card>
    )
  }
  const miss = r.mismatches.filter((m) => field === 'all' || m.field === field)
  return (
    <Card className="span2" title={t('acc.title')} hint={t('acc.hint', { labelled: r.labelled, matched: r.matched })}>
      {r.matched === 0 ? <p className="muted">{t('acc.noMatch')}</p> : (
        <>
          <table className="mini wide">
            <thead><tr><th>{t('an.p.source')}</th><th className="num">{t('acc.receipts')}</th>{FIELDS.map((f) => <th key={f} className="num">{t(`acc.f.${f}` as Key)}</th>)}</tr></thead>
            <tbody>
              {r.sources.map((s) => (
                <tr key={s.source}><td title={s.source}>{providerName(s.source, t)}</td><td className="num">{s.receipts}</td>{FIELDS.map((f) => <Cell key={f} f={s[f]} t={t} />)}</tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{t('acc.note', { min: MIN })}</p>
          <div className="row gap wrap" style={{ margin: '10px 0 6px' }}>
            <b>{t('acc.mismatches', { n: r.mismatches.length })}</b>
            {(['all', ...FIELDS] as const).map((f) => <button key={f} className={`chip ${field === f ? 'on' : ''}`} onClick={() => setField(f)}>{f === 'all' ? t('common.all') : t(`acc.f.${f}` as Key)}</button>)}
          </div>
          {miss.length === 0 ? <p className="muted">{t('acc.noMiss')}</p> : (
            <div className="tablewrap" style={{ maxHeight: 320 }}>
              <table className="mini wide">
                <thead><tr><th>{t('act.receipt')}</th><th>{t('acc.field')}</th><th>{t('acc.read')}</th><th>{t('acc.truth')}</th><th>{t('acc.afterReviewCol')}</th></tr></thead>
                <tbody>
                  {miss.slice(0, 100).map((m, i) => (
                    <tr key={`${m.id}-${m.field}-${i}`}>
                      <td><Link className="mono" to={`/data?state=all&open=${m.id}`}>{m.file}</Link></td>
                      <td>{t(`acc.f.${m.field}` as Key)}</td><td>{m.machine ?? '—'}</td><td><b>{m.truth ?? '—'}</b></td>
                      <td>{m.finalOk === null ? '—' : m.finalOk ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
