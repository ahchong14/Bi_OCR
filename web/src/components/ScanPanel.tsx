import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { moneyC } from '../lib/format'
import { useScan } from '../scan'
import { StatusBadge } from './ui'

/** 门户内扫描的界面: 选图片 → 逐张识别 → 立刻进入待审核队列。队列状态在 ScanProvider 里,关窗口不影响识别。 */
export function ScanPanel({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const nav = useNavigate()
  const s = useScan()
  const [over, setOver] = useState(false)
  const { items, counts } = s
  const total = items.length
  const finished = counts.done + counts.dup + counts.error

  if (s.infoLoading) return <p className="muted">{t('common.loading')}</p>
  if (!s.info?.enabled) return <div className="importmsg err">❌ {t('scan.disabled')}</div>

  return (
    <div className="scanpanel">
      <div className="alert info"><span>🔒</span><span>{t(s.info.local ? 'scan.privacyLocal' : 'scan.privacy', { provider: s.info.provider ?? '' })}</span></div>
      {s.info.sharedTestKey && <div className="alert warn"><span>⚠️</span><span>{t('scan.sharedKey')}</span></div>}
      {!s.info.local && <label className="check-row ackrow"><input type="checkbox" checked={s.ack} onChange={(e) => s.setAck(e.target.checked)} />{t('scan.ack')}</label>}

      <label
        className={`drop ${over ? 'over' : ''} ${s.ack ? '' : 'disabled'}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); s.add(Array.from(e.dataTransfer.files)) }}
      >
        <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden aria-label={t('scan.pick')} disabled={!s.ack}
          onChange={(e) => { s.add(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        <div>📷 {t('scan.drop')}<br /><span className="muted">{t('scan.dropHint', { mb: Math.round((s.info.maxBytes ?? 0) / 1024 / 1024) })}</span></div>
      </label>

      {total > 0 && (
        <>
          <div className="scanhead">
            <b>{t('scan.progress', { done: finished, total })}</b>
            <span className="grow" />
            {counts.waiting > 0 && <button className="btn sm" onClick={s.cancel}>{t('scan.cancel')}</button>}
            {!s.busy && (counts.error > 0 || counts.waiting > 0) && <button className="btn sm primary" onClick={s.retry}>{s.paused ? t('scan.resume', { n: counts.error + counts.waiting }) : t('scan.retry', { n: counts.error })}</button>}
            {!s.busy && <button className="btn sm ghost" onClick={s.clear}>{t('scan.clear')}</button>}
          </div>
          <div className="progress"><div style={{ width: `${Math.round((finished / total) * 100)}%` }} /></div>
          {s.paused && <div className="alert warn"><span>⏸</span><span>{t('scan.paused')} {s.paused}</span></div>}
          <ul className="scanlist" aria-live="polite">
            {items.map((x) => (
              <li key={x.key} className={`scanitem ${x.state}`}>
                <span className="scanicon" aria-hidden="true">{x.state === 'waiting' ? '⏳' : x.state === 'scanning' ? '⌛' : x.state === 'error' ? '❌' : x.state === 'dup' ? '♻️' : '✅'}</span>
                <span className="scanname mono" title={x.file.name}>{x.file.name}</span>
                <span className="scanmeta">
                  {x.state === 'scanning' && <span className="muted">{t('scan.scanning')}</span>}
                  {x.state === 'waiting' && <span className="muted">{t('scan.waiting')}</span>}
                  {x.state === 'dup' && <span className="muted">{t('scan.dup')}</span>}
                  {x.state === 'error' && <span className="err-text">{x.error}</span>}
                  {x.state === 'done' && x.outcome && (
                    <>
                      <span className="clip">{x.outcome.merchant ?? t('review.noMerchant')}</span>
                      <b>{moneyC(x.outcome.total, x.outcome.currency)}</b>
                      <span className="muted small">{t('scan.meta', { n: x.outcome.items ?? 0, s: (x.outcome.ms / 1000).toFixed(1) })}</span>
                      {x.outcome.status && <StatusBadge status={x.outcome.status} />}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {!s.busy && finished > 0 && (
            <div className="scandone">
              <div>{t('scan.summary', { easy: counts.easy, check: counts.check, dup: counts.dup, err: counts.error })}</div>
              <button className="btn primary big" onClick={() => { onDone(); nav('/review') }} disabled={counts.done === 0 && counts.dup === 0}>{t('scan.startReview')} →</button>
            </div>
          )}
        </>
      )}
      <p className="muted small">{t('scan.hint')}</p>
    </div>
  )
}
