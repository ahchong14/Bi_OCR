import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError, api } from '../api'
import { useApp } from '../context'
import { useI18n } from '../i18n'
import { ScanPanel } from './ScanPanel'
import { Dialog, Segmented } from './ui'

/** 导入标准答案 CSV(文件名 → 商家、日期、总额),用来在「分析」页对照识别准确率。 */
function TruthPanel() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [over, setOver] = useState(false)
  const count = useQuery({ queryKey: ['truthInfo'], queryFn: api.truthInfo })
  async function send(file?: File) {
    if (!file) return
    if (!/\.csv$/i.test(file.name)) return setMsg({ kind: 'err', text: t('truth.needCsv') })
    try {
      const r = await api.importTruth(file)
      setMsg({ kind: 'ok', text: t('truth.done', { added: r.added, updated: r.updated, failed: r.failed }) })
      void qc.invalidateQueries({ queryKey: ['truthInfo'] }); void qc.invalidateQueries({ queryKey: ['accuracy'] })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : t('import.failedGeneric') })
    }
  }
  return (
    <div className="scanpanel">
      <p className="muted">{t('truth.hint')}</p>
      <p><b>{t('truth.current', { n: count.data?.count ?? 0 })}</b></p>
      <label className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files[0]) }}>
        <input type="file" accept=".csv,text/csv" hidden aria-label="labels.csv" onChange={(e) => { void send(e.target.files?.[0]); e.target.value = '' }} />
        <div>📋 {t('truth.drop')}<br /><span className="muted">{t('truth.dropHint')}</span></div>
      </label>
      {msg && <div className={`importmsg ${msg.kind}`}>{msg.kind === 'ok' ? '✅ ' : '❌ '}{msg.text}</div>}
    </div>
  )
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const zipInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)
  const imgInput = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [over, setOver] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  const refresh = () => qc.invalidateQueries()
  const info = useQuery({ queryKey: ['scanInfo'], queryFn: api.scanInfo, staleTime: 60_000 })
  const { importTab: tab, setImportTab: setTab } = useApp()

  async function uploadZip(file?: File) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) return setMsg({ kind: 'err', text: t('import.needZip') })
    setMsg(null)
    setProgress(0)
    try {
      const r = await api.uploadZip(file, setProgress)
      const parts = [t('import.added', { n: r.added })]
      if (r.duplicates) parts.push(t('import.dups', { n: r.duplicates }))
      if (r.withoutImage) parts.push(t('import.noImage', { n: r.withoutImage }))
      if (r.failed) parts.push(t('import.failed', { n: r.failed }) + (r.errors?.length ? ` (${r.errors[0]})` : ''))
      setMsg({ kind: r.added ? 'ok' : r.duplicates && !r.failed ? 'warn' : 'err', text: r.added ? parts.join(', ') : r.duplicates && !r.failed ? t('import.noneNew', { n: r.duplicates }) : parts.join(', ') })
      refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : t('import.failedGeneric') })
    } finally {
      setProgress(null)
      if (zipInput.current) zipInput.current.value = ''
    }
  }

  async function importJson() {
    const jf = jsonInput.current?.files?.[0]
    if (!jf) return setMsg({ kind: 'err', text: t('import.needJson') })
    try {
      const r = await api.importJson(JSON.parse(await jf.text()))
      let attached = 0
      for (const im of Array.from(imgInput.current?.files ?? [])) attached += (await api.attachImage(im)).attached
      setMsg({ kind: 'ok', text: t('import.addedImages', { n: r.added, m: attached }) })
      refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('import.failedGeneric') })
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('import.title')} wide footer={<button className="btn" onClick={onClose}>{t('common.close')}</button>}>
      <Segmented<'scan' | 'package' | 'truth'> value={tab} onChange={setTab} options={[{ value: 'scan', label: t('import.tab.scan') }, { value: 'package', label: t('import.tab.package') }, { value: 'truth', label: t('import.tab.truth') }]} />
      <div hidden={tab !== 'scan'}><ScanPanel onDone={onClose} /></div>
      <div hidden={tab !== 'truth'}><TruthPanel /></div>
      <div hidden={tab !== 'package'}>
      <p className="muted">{t('import.hint')}</p>
      <label
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void uploadZip(e.dataTransfer.files[0]) }}
      >
        <input ref={zipInput} type="file" accept=".zip" hidden aria-label="portal_package.zip" onChange={(e) => void uploadZip(e.target.files?.[0])} />
        <div>{t('import.drop')}<br /><span className="muted">{t('import.dropHint')}</span></div>
      </label>
      {progress !== null && <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
      {msg && <div className={`importmsg ${msg.kind}`}>{msg.kind === 'ok' ? '✅ ' : msg.kind === 'warn' ? 'ℹ️ ' : '❌ '}{msg.text}</div>}
      <details className="adv">
        <summary>{t('import.adv')}</summary>
        <p className="muted">{t('import.advHint')}</p>
        <input ref={jsonInput} type="file" accept=".json" aria-label="receipts_result.json" />
        <input ref={imgInput} type="file" accept="image/*" multiple aria-label="images" />
        <button className="btn" onClick={() => void importJson()}>{t('import.advBtn')}</button>
      </details>
      </div>
    </Dialog>
  )
}
