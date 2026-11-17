import { useI18n } from './i18n'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastKind = 'ok' | 'err' | 'info'
export interface ToastOptions { action?: { label: string; onClick: () => void }; duration?: number }
export type Theme = 'system' | 'light' | 'dark'

interface Ctx {
  user: string
  setUser: (s: string) => void
  toast: (msg: string, kind?: ToastKind, opts?: ToastOptions) => void
  theme: Theme
  setTheme: (t: Theme) => void
  importOpen: boolean
  setImportOpen: (v: boolean) => void
  /** 导入窗口打开时显示哪个页签(例如分析页的「导入标准答案」直接打开到标准答案页签)。 */
  importTab: 'scan' | 'package' | 'truth'
  setImportTab: (t: 'scan' | 'package' | 'truth') => void
  /** 拖到页面任意位置的图片: 打开导入窗口并交给扫描面板处理。 */
  droppedFiles: File[]
  setDroppedFiles: (f: File[]) => void
  /** 通过前必须确认系统标出来的字段(默认开)。关掉后回到以前的行为: 只在金额对不上时才拦。 */
  requireAck: boolean
  setRequireAck: (v: boolean) => void
}
const AppCtx = createContext<Ctx>({ user: '', setUser: () => {}, toast: () => {}, theme: 'system', setTheme: () => {}, importOpen: false, setImportOpen: () => {}, importTab: 'scan', setImportTab: () => {}, droppedFiles: [], setDroppedFiles: () => {}, requireAck: true, setRequireAck: () => {} })
export const useApp = () => useContext(AppCtx)

const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 隐私模式下写不进去,不影响使用 */ } }

export function AppProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [user, setUserState] = useState(() => read('portal_user', ''))
  const [theme, setThemeState] = useState<Theme>(() => read('portal_theme', 'system') as Theme)
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'scan' | 'package' | 'truth'>('scan')
  const [requireAck, setRequireAckState] = useState(() => read('portal_require_ack', '1') !== '0')
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind; opts?: ToastOptions }[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextId = useRef(0)

  const setUser = useCallback((s: string) => { setUserState(s); write('portal_user', s) }, [])
  const setTheme = useCallback((t: Theme) => { setThemeState(t); write('portal_theme', t) }, [])
  const setRequireAck = useCallback((v: boolean) => { setRequireAckState(v); write('portal_require_ack', v ? '1' : '0') }, [])
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id)
    setToasts((l) => l.filter((x) => x.id !== id))
  }, [])
  // 提示叠在右上角(不再盖住底部的操作按钮),最多同时 3 条;错误停留更久,也可以手动关闭
  const toast = useCallback((msg: string, kind: ToastKind = 'info', opts?: ToastOptions) => {
    const id = ++nextId.current
    setToasts((l) => [...l.filter((x) => x.msg !== msg), { id, msg, kind, opts }].slice(-3))
    timers.current.set(id, setTimeout(() => dismiss(id), opts?.duration ?? (kind === 'err' ? 6500 : 2800)))
  }, [dismiss])

  const value = useMemo(() => ({ user, setUser, toast, theme, setTheme, importOpen, setImportOpen, importTab, setImportTab, droppedFiles, setDroppedFiles, requireAck, setRequireAck }), [user, setUser, toast, theme, setTheme, importOpen, importTab, droppedFiles, requireAck, setRequireAck])
  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast show ${x.kind}`} role={x.kind === 'err' ? 'alert' : 'status'}>
            <span>{x.msg}</span>
            {x.opts?.action && <button className="toast-action" onClick={() => { x.opts!.action!.onClick(); dismiss(x.id) }}>{x.opts.action.label}</button>}
            <button className="toast-x" aria-label={t('toast.close')} title={t('toast.close')} onClick={() => dismiss(x.id)}>✕</button>
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  )
}
