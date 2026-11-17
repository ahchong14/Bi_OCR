import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { FieldKey, ReceiptData } from '../../../shared/types'
import { ApiError, api } from '../api'
import { useApp } from '../context'
import { useI18n, type Key } from '../i18n'
import { explain } from '../lib/explain'
import { isSystemUser, money, moneyC, stamp } from '../lib/format'
import { ImageViewer } from './ImageViewer'
import { Loading, StateBadge, StatusBadge } from './ui'

/** 只读的收据详情抽屉: 在数据表格里点一行打开。 */
export function ReceiptDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t, field } = useI18n()
  const { user, toast } = useApp()
  const qc = useQueryClient()
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api.receipt(id!), enabled: id !== null })
  const d = q.data

  const show = (k: FieldKey, data: ReceiptData): string => {
    const v = data[k]
    if (k === 'items') return t('form.itemsCount', { n: (v as unknown[]).length })
    if (v === null || v === '') return '—'
    return typeof v === 'number' ? money(v) : String(v)
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const reopen = useMutation({
    mutationFn: () => api.review(id!, { action: 'reopen', version: d!.version, user }),
    onSuccess: () => { void qc.invalidateQueries(); toast(t('toast.reopened'), 'ok'); nav(`/review/${id}`) },
    onError: (e: ApiError) => toast(e.message, 'err'),
  })

  if (id === null) return null
  const scalarKeys: FieldKey[] = ['merchant', 'date', 'currency', 'subtotal', 'discount', 'service_charge', 'tax', 'tip', 'fees', 'rounding', 'paid', 'change']
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="receipt details">
        <header>
          <div>
            <h3>{d?.file ?? t('drawer.loading')}</h3>
            {d && <div className="row gap"><StateBadge state={d.state} /><StatusBadge status={d.pipelineStatus} /></div>}
          </div>
          <button className="btn ghost" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </header>
        {!d ? <Loading /> : (
          <div className="drawer-body">
            <ImageViewer src={d.hasImage ? api.imageUrl(d.id, d.importedAt) : null} openHref={d.hasImage ? api.imageUrl(d.id, d.importedAt) : undefined} />
            <dl className="facts">
              {scalarKeys.filter((k) => d.data[k] !== null || ['merchant', 'date', 'currency', 'subtotal', 'tax'].includes(k)).map((k) => (
                <div key={k} className={d.editedFields.includes(k) ? 'edited' : ''}><dt>{field(k)}</dt><dd>{show(k, d.data)}</dd></div>
              ))}
              <div className={`big ${d.editedFields.includes('total') ? 'edited' : ''}`}><dt>{field('total')}</dt><dd>{moneyC(d.data.total, d.data.currency)}</dd></div>
            </dl>

            {d.duplicates.length > 0 && (
              <div className="alert warn">⚠️ <span>{t('drawer.dup')}: {d.duplicates.map((x) => (
                <Link key={x.id} to={`/data?state=all&open=${x.id}`} className="mono">{x.file} </Link>
              ))}</span></div>
            )}

            {d.editedFields.length > 0 && (
              <section>
                <h4>{t('drawer.edited')}</h4>
                <table className="mini">
                  <thead><tr><th>{t('drawer.field')}</th><th>{t('drawer.machine')}</th><th>{t('drawer.final')}</th></tr></thead>
                  <tbody>{d.editedFields.map((k) => <tr key={k}><td>{field(k)}</td><td className="muted">{show(k, d.machine)}</td><td><b>{show(k, d.data)}</b></td></tr>)}</tbody>
                </table>
              </section>
            )}

            <section>
              <h4>{t('drawer.items', { n: d.data.items.length })}</h4>
              {d.data.items.length ? (
                <table className="mini">
                  <thead><tr><th>{t('form.item.name')}</th><th className="num">{t('form.item.qty')}</th><th className="num">{t('form.item.price')}</th></tr></thead>
                  <tbody>{d.data.items.map((it, i) => <tr key={i}><td>{it.name}</td><td className="num">{it.qty ?? '—'}</td><td className="num">{money(it.price)}</td></tr>)}</tbody>
                </table>
              ) : <p className="muted">{t('drawer.noItems')}</p>}
            </section>

            {d.reasons.length > 0 && (
              <section>
                <h4>{t('drawer.reasons')}</h4>
                <ul className="reasons">{d.reasons.map((r) => { const e = explain(r, t, field); return <li key={r} className={e.level}>{e.text}</li> })}</ul>
              </section>
            )}
            {d.note && <section><h4>{t('drawer.note')}</h4><p>{d.note}</p></section>}

            <section>
              <h4>{t('drawer.audit')}</h4>
              <ol className="timeline">
                {d.audit.map((a) => (
                  <li key={a.id}>
                    <b>{t(`action.${a.action}` as Key)}</b> · {isSystemUser(a.user) ? t('act.system') : a.user} <span className="muted">{stamp(a.ts)}</span>
                    {a.detail.changed?.length ? <div className="muted">{t('drawer.changedPrefix')}{a.detail.changed.map((k) => field(k as FieldKey)).join(', ')}</div> : null}
                    {a.detail.note ? <div className="muted">{a.detail.note}</div> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
        {d && (
          <footer>
            {d.state === 'pending'
              ? <Link className="btn primary" to={`/review/${d.id}`}>{t('drawer.goReview')}</Link>
              : <button className="btn primary" disabled={reopen.isPending || !user.trim()} title={user.trim() ? '' : t('toast.nameNeeded')} onClick={() => reopen.mutate()}>{t('drawer.reopen')}</button>}
          </footer>
        )}
      </aside>
    </>
  )
}
