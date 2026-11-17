import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'

const isIso = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
}

/**
 * 日期输入框: 统一显示 年-月-日(浏览器自带的日期框会随系统地区显示 日/月/年 或 月/日/年,员工容易看错),旁边带日历按钮点选。
 * 只有输入完整且合法的日期(或清空)时才通知上层,写到一半不会触发筛选。
 */
export function DateInput({ value, onChange, label, className = '' }: { value: string; onChange: (v: string) => void; label: string; className?: string }) {
  const { t } = useI18n()
  const [text, setText] = useState(value)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => setText(value), [value])
  const bad = text !== '' && !isIso(text)
  const commit = (s: string) => { setText(s); if (s === '' || isIso(s)) onChange(s) }
  return (
    <span className={`datebox dateinput ${className}`}>
      <input type="text" inputMode="numeric" placeholder="YYYY-MM-DD" maxLength={10} value={text} aria-label={label} aria-invalid={bad || undefined} className={bad ? 'invalid' : ''} onChange={(e) => commit(e.target.value)} />
      <button type="button" className="calbtn" title={t('form.pickDate')} aria-label={t('form.pickDate')} onClick={() => picker.current?.showPicker?.()}>📅</button>
      <input ref={picker} type="date" className="datehidden" tabIndex={-1} aria-hidden="true" value={isIso(value) ? value : ''} onChange={(e) => commit(e.target.value)} />
    </span>
  )
}
