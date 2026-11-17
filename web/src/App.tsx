import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import type { PipelineStatus } from '../../shared/types'
import { PIPELINE_STATUSES } from '../../shared/types'
import { api, setToken, setTokenPrompt } from './api'
import { ImportDialog } from './components/ImportDialog'
import { Dialog, ErrorBoundary } from './components/ui'
import { useApp, type Theme } from './context'
import { useI18n, type Key } from './i18n'
import { useScan } from './scan'

/** 整体外壳: 顶部导航 + 审核人姓名 + 导入 + 语言/外观设置 + 帮助。 */
export default function Layout() {
  const { t, lang, setLang } = useI18n()
  const { user, setUser, theme, setTheme, importOpen, setImportOpen, setImportTab, setDroppedFiles, requireAck, setRequireAck } = useApp()
  const scan = useScan()
  const openScan = () => { setImportTab('scan'); setImportOpen(true) }
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 })
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [tokenText, setTokenText] = useState('')
  const resolver = useRef<(() => void) | null>(null)

  // 服务端要求口令时,请求层会调用这里弹出输入框
  useEffect(() => {
    setTokenPrompt(() => new Promise<void>((resolve) => { resolver.current = resolve; setTokenOpen(true) }))
  }, [])
  const { pathname } = useLocation()
  // 页面标题随页面变化(浏览器标签页、历史记录里能分清是哪一页)
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    const page = (['review', 'data', 'analytics', 'activity'] as const).find((p) => pathname.startsWith('/' + p))
    document.title = page ? `${t(`nav.${page}` as Key)} · ${t('app.brand')}` : t('app.brand')
  }, [lang, t, pathname])

  // 审核页按 ? 键时打开帮助(帮助弹窗的状态在这里)
  useEffect(() => {
    const h = () => setHelpOpen(true)
    window.addEventListener('portal:help', h)
    return () => window.removeEventListener('portal:help', h)
  }, [])

  const confirmToken = () => { setToken(tokenText); setTokenOpen(false); resolver.current?.() }

  return (
    <div className="shell"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        // 把图片直接拖到页面任意位置: 打开扫描窗口并开始(zip 之类的不处理,走导入页签)
        const files = Array.from(e.dataTransfer.files).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f.name))
        if (!files.length || importOpen) return
        e.preventDefault(); setDroppedFiles(files); openScan()
      }}>
      <a className="skip" href="#main">{t('app.skip')}</a>
      <header className="top">
        <div className="brand"><span aria-hidden="true">🧾</span> <span className="brand-text">{t('app.brand')}</span></div>
        <nav aria-label={t('nav.main')}>
          <NavLink to="/review">{t('nav.review')}{stats.data && stats.data.pending > 0 && <span className="count">{stats.data.pending}</span>}</NavLink>
          <NavLink to="/data">{t('nav.data')}</NavLink>
          <NavLink to="/analytics">{t('nav.analytics')}</NavLink>
          <NavLink to="/activity">{t('nav.activity')}</NavLink>
        </nav>
        <div className="top-actions">
        {scan.items.length > 0 && (
          <button className={`btn sm scanchip ${scan.busy ? 'busy' : ''}`} onClick={() => openScan()} title={t('scan.chipTitle')}>
            {scan.busy ? `⌛ ${t('scan.chipBusy', { done: scan.counts.done + scan.counts.dup + scan.counts.error, total: scan.items.length })}` : scan.paused ? `⏸ ${t('scan.chipPaused')}` : `✅ ${t('scan.chipDone', { n: scan.counts.done + scan.counts.dup })}`}
          </button>
        )}
        <button className="btn ghost" onClick={() => openScan()}>{t('app.import')}</button>
        <label className="who"><span className="who-label">{t('app.reviewer')}</span> <input id="user-input" aria-label={t('app.reviewer')} value={user} placeholder={t('app.reviewerPh')} maxLength={40} onChange={(e) => setUser(e.target.value)} className={user.trim() ? '' : 'need'} /></label>
        <div className="menu">
          <button className="btn ghost" onClick={() => setSettingsOpen((v) => !v)} title={t('app.settings')} aria-label={t('app.settings')}>⚙ {lang === 'zh' ? '中文' : 'EN'}</button>
          {settingsOpen && (
            <div className="menu-body settings" onMouseLeave={() => setSettingsOpen(false)}>
              <div className="set-row"><span>{t('settings.language')}</span>
                <div className="segmented"><button className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>中文</button><button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button></div></div>
              <div className="set-row"><span>{t('settings.theme')}</span>
                <div className="segmented">{(['system', 'light', 'dark'] as Theme[]).map((x) => <button key={x} className={theme === x ? 'on' : ''} onClick={() => setTheme(x)}>{t(`theme.${x}` as Key)}</button>)}</div></div>
              <div className="set-row" title={t('settings.requireAckTip')}><span>{t('settings.requireAck')}</span>
                <div className="segmented"><button className={requireAck ? 'on' : ''} onClick={() => setRequireAck(true)}>{t('settings.on')}</button><button className={!requireAck ? 'on' : ''} onClick={() => setRequireAck(false)}>{t('settings.off')}</button></div></div>
            </div>
          )}
        </div>
        <button className="btn ghost" onClick={() => setHelpOpen(true)} title={t('app.help')} aria-label={t('app.help')}>？</button>
        </div>
      </header>
      <main id="main" className="content" tabIndex={-1}><ErrorBoundary><Outlet /></ErrorBoundary></main>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title={t('help.title')} footer={<button className="btn primary" onClick={() => setHelpOpen(false)}>{t('common.gotIt')}</button>}>
        <h4>{t('help.pages')}</h4>
        <ul className="plain">
          <li><b>{t('nav.review')}</b>: {t('help.page.review')}</li>
          <li><b>{t('nav.data')}</b>: {t('help.page.data')}</li>
          <li><b>{t('nav.analytics')}</b>: {t('help.page.analytics')}</li>
          <li><b>{t('nav.activity')}</b>: {t('help.page.activity')}</li>
        </ul>
        <h4>{t('help.legend')}</h4>
        <ul className="legend">
          {PIPELINE_STATUSES.map((s: PipelineStatus) => <li key={s}><i className={`dot st-${s}`} /><b>{t(`status.${s}` as Key)}</b>: {t(`status.desc.${s}` as Key)}</li>)}
        </ul>
        <h4>{t('help.tips')}</h4>
        <ul className="plain"><li>{t('help.tip.ocr')}</li><li>{t('help.tip.fill')}</li><li>{t('help.tip.undo')}</li></ul>
        <h4>{t('help.shortcuts')}</h4>
        <ul className="plain shortcuts">
          <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t('help.sc.approve')}</li><li><kbd>Ctrl</kbd>+<kbd>S</kbd> {t('help.sc.save')}</li>
          <li><kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> {t('help.sc.nav')}</li><li><kbd>Esc</kbd> {t('help.sc.close')}</li><li>{t('help.sc.image')}</li>
          <li><kbd>J</kbd> / <kbd>K</kbd> {t('help.sc.jk')}</li><li><kbd>F</kbd> {t('help.sc.f')}</li><li><kbd>C</kbd> {t('help.sc.c')}</li><li><kbd>R</kbd> {t('help.sc.r')}</li><li><kbd>?</kbd> {t('help.sc.help')}</li><li><kbd>Esc</kbd> {t('help.sc.esc')}</li>
          <li className="muted small">{t('help.sc.note')}</li>
        </ul>
        <p className="muted">{t('help.footer')}</p>
      </Dialog>

      <Dialog open={tokenOpen} onClose={() => setTokenOpen(false)} title={t('token.title')}
        footer={<button className="btn primary" onClick={confirmToken}>{t('token.ok')}</button>}>
        <p className="muted">{t('token.hint')}</p>
        <input type="password" autoFocus value={tokenText} placeholder={t('token.ph')} autoComplete="off" onChange={(e) => setTokenText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirmToken()} />
      </Dialog>
    </div>
  )
}
