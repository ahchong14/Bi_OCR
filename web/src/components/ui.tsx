import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import type { PipelineStatus, ReviewState } from '../../../shared/types'
import { useI18n, type Key } from '../i18n'

export function StatusBadge({ status }: { status: PipelineStatus }) {
  const { t } = useI18n()
  return <span className={`pill st-${status}`}><i className="dot" />{t(`status.${status}` as Key)}</span>
}

export function StateBadge({ state }: { state: ReviewState }) {
  const { t } = useI18n()
  return <span className={`pill state-${state}`}>{t(`state.${state}` as Key)}</span>
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={wide ? 'wide' : ''} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <h3>{title}</h3>
      {children}
      {footer && <div className="dlgfoot">{footer}</div>}
    </dialog>
  )
}

export function Empty({ icon, title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="big">{icon}</div>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Loading({ text }: { text?: string }) {
  const { t } = useI18n()
  return <div className="loading"><span className="spinner" />{text ?? t('common.loading')}</div>
}

export function Card({ title, hint, children, className = '', right }: { title: string; hint?: string; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {hint && <p className="muted">{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export const Chips = ({ items }: { items: string[] }) => (
  <span className="chiplist">{items.length ? items.map((x) => <span key={x} className="tag">{x}</span>) : <span className="muted">—</span>}</span>
)

/** 页面渲染出错时给出友好提示,而不是整页空白。 */
function Fallback({ error }: { error: Error }) {
  const { t } = useI18n()
  return (
    <div className="empty">
      <div className="big">😵</div>
      <h2>{t('error.title')}</h2>
      <p>{t('error.body')}</p>
      <pre className="ocr" style={{ maxWidth: 640, margin: '12px auto', textAlign: 'left' }}>{error.message}</pre>
      <button className="btn primary" onClick={() => location.reload()}>{t('common.reload')}</button>
    </div>
  )
}
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack) }
  render() { return this.state.error ? <Fallback error={this.state.error} /> : this.props.children }
}
