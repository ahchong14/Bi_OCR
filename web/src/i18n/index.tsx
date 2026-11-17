import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { FIELD_LABELS } from '../../../shared/labels'
import type { FieldKey, Lang } from '../../../shared/types'
import { setApiLang } from '../api'
import { setFormatLocale } from '../lib/format'
import { en } from './en'
import { zh, type Key } from './zh'

export type { Key }
export type Params = Record<string, string | number>
export type T = (key: Key, params?: Params) => string

const DICT: Record<Lang, Record<Key, string>> = { zh, en }

/** {name} 是变量;"单数|复数"按 n 选择(英文用)。 */
function format(text: string, params?: Params): string {
  if (!params) return text
  let s = text
  if (s.includes('|') && typeof params.n === 'number') {
    const [one, many] = s.split('|')
    s = params.n === 1 ? one! : (many ?? one!)
  }
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
}

export const makeT = (lang: Lang): T => (key, params) => format(DICT[lang][key] ?? key, params)

const detect = (): Lang => {
  try {
    const saved = localStorage.getItem('portal_lang')
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* 隐私模式下读不到,用浏览器语言 */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

interface I18n {
  lang: Lang
  setLang: (l: Lang) => void
  t: T
  field: (k: FieldKey) => string
}
const Ctx = createContext<I18n>({ lang: 'zh', setLang: () => {}, t: makeT('zh'), field: (k) => FIELD_LABELS.zh[k] })
export const useI18n = () => useContext(Ctx)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = detect()
    setApiLang(l) // 在第一个请求发出前就设好,服务端提示用对应语言
    setFormatLocale(l)
    return l
  })
  const setLang = useCallback((l: Lang) => {
    setApiLang(l)
    setFormatLocale(l)
    try { localStorage.setItem('portal_lang', l) } catch { /* 忽略 */ }
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
    setLangState(l)
  }, [])
  const value = useMemo<I18n>(() => ({ lang, setLang, t: makeT(lang), field: (k) => FIELD_LABELS[lang][k] }), [lang, setLang])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
