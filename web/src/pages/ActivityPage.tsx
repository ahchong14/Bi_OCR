import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AuditEntry, FieldKey } from '../../../shared/types'
import { api } from '../api'
import { Chips, Empty, Loading } from '../components/ui'
import { useI18n, type Key } from '../i18n'
import { isSystemUser, stamp } from '../lib/format'

type Tr = ReturnType<typeof useI18n>['t']
type Fl = (k: FieldKey) => string

/** 批量操作会给每张收据各记一行;同一个人、同一分钟、同一种批量操作的连续记录合成一组,不再刷屏。 */
function groupRows(rows: AuditEntry[]): { rows: AuditEntry[] }[] {
  const out: { rows: AuditEntry[] }[] = []
  for (const a of rows) {
    const last = out[out.length - 1]
    const p = last?.rows[0]
    const sameBulk = !!a.detail.bulk && !!p?.detail.bulk
    const sameImport = a.action === 'imported' && p?.action === 'imported' && a.detail.batch === p.detail.batch // 同一次导入的几十条也合并
    if (last && p && (sameBulk || sameImport) && p.user === a.user && p.action === a.action && stamp(p.ts) === stamp(a.ts)) last.rows.push(a)
    else out.push({ rows: [a] })
  }
  return out
}

function ActRow({ a, t, field }: { a: AuditEntry; t: Tr; field: Fl }) {
  return (
    <tr>
      <td className="nowrap">{stamp(a.ts)}</td>
      <td>{isSystemUser(a.user) ? t('act.system') : a.user}</td>
      <td><span className={`pill act-${a.action}`}>{t(`action.${a.action}` as Key)}</span>{a.detail.bulk && <span className="tag">{t('act.bulk')}</span>}</td>
      <td>{a.receiptId ? <Link className="mono" to={`/data?state=all&open=${a.receiptId}`}>{a.file ?? `#${a.receiptId}`}</Link> : '—'}</td>
      <td>
        {a.detail.changed?.length ? <Chips items={a.detail.changed.map((k) => field(k as FieldKey))} /> : null}
        {a.detail.note ? <span className="muted"> {a.detail.note}</span> : null}
        {a.detail.batch ? <span className="muted">{a.detail.batch}</span> : null}
        {a.detail.unresolved?.length ? <span className="tag warn" title={a.detail.unresolved.join(', ')}>{t('act.unresolved')}</span> : null}
      </td>
    </tr>
  )
}

function ActGroup({ rows, t, field }: { rows: AuditEntry[]; t: Tr; field: Fl }) {
  const [open, setOpen] = useState(false)
  const a = rows[0]!
  const unresolved = rows.filter((r) => r.detail.unresolved?.length).length
  return (
    <>
      <tr className="grouprow">
        <td className="nowrap">{stamp(a.ts)}</td>
        <td>{isSystemUser(a.user) ? t('act.system') : a.user}</td>
        <td colSpan={2}>
          <span className={`pill act-${a.action}`}>{t('act.bulkGroup', { action: t(`action.${a.action}` as Key), n: rows.length })}</span>
        </td>
        <td>
          {unresolved > 0 && <span className="tag warn">{t('act.bulkUnresolved', { n: unresolved })}</span>}
          {a.detail.note ? <span className="muted"> {a.detail.note}</span> : null}
          <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? t('act.collapse') : t('act.expand')}</button>
        </td>
      </tr>
      {open && rows.map((r) => <ActRow key={r.id} a={r} t={t} field={field} />)}
    </>
  )
}

const ACTIONS = ['imported', 'approve', 'reject', 'save', 'reopen'] as const

/** 全局操作记录: 谁、什么时候、对哪张收据做了什么。用于对账和追溯。 */
export default function ActivityPage() {
  const { t, field } = useI18n()
  const [user, setUser] = useState('')
  const [action, setAction] = useState('')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 50

  useEffect(() => { const timer = setTimeout(() => { setQ(text); setPage(1) }, 300); return () => clearTimeout(timer) }, [text])
  const data = useQuery({
    queryKey: ['audit', user, action, q, page],
    queryFn: () => api.audit({ user: user || undefined, action: action || undefined, q: q || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  })
  const d = data.data
  const pages = d ? Math.max(1, Math.ceil(d.total / pageSize)) : 1

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('act.title')}</h1>
          <p className="muted">{t('act.subtitle')}</p>
        </div>
      </div>
      <div className="toolbar">
        <input className="search" type="search" placeholder={t('act.search')} value={text} onChange={(e) => setText(e.target.value)} />
        <select value={user} onChange={(e) => { setUser(e.target.value); setPage(1) }} aria-label={t('act.userCol')}><option value="">{t('act.user')}</option>{d?.users.map((x) => <option key={x} value={x}>{isSystemUser(x) ? t('act.system') : x}</option>)}</select>
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }} aria-label={t('act.actionCol')}>
          <option value="">{t('act.action')}</option>{ACTIONS.map((k) => <option key={k} value={k}>{t(`action.${k}` as Key)}</option>)}
        </select>
        <span className="grow" />
        {d && <span className="muted">{t('act.total', { n: d.total })}</span>}
      </div>
      {!d ? <Loading /> : d.rows.length === 0 ? <Empty icon="📜" title={t('act.empty')} /> : (
        <div className={`tablewrap ${data.isFetching ? 'busy' : ''}`}>
          <table className="dt">
            <thead><tr><th>{t('act.time')}</th><th>{t('act.userCol')}</th><th>{t('act.actionCol')}</th><th>{t('act.receipt')}</th><th>{t('act.detail')}</th></tr></thead>
            <tbody>
              {groupRows(d.rows).map((g) => g.rows.length === 1 ? <ActRow key={g.rows[0]!.id} a={g.rows[0]!} t={t} field={field} /> : <ActGroup key={g.rows[0]!.id} rows={g.rows} t={t} field={field} />)}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <span className="muted">{t('pager.page', { page, pages })}</span>
        <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('pager.prev')}</button>
        <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('pager.next')}</button>
      </div>
    </div>
  )
}
