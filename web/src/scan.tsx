import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScanInfo, ScanOutcome } from '../../shared/types'
import { ApiError, api } from './api'
import { useApp } from './context'
import { useI18n } from './i18n'

export type ScanState = 'waiting' | 'scanning' | 'done' | 'dup' | 'error'
export interface ScanItem { key: number; file: File; state: ScanState; outcome?: ScanOutcome; error?: string }
export interface ScanCounts { waiting: number; scanning: number; done: number; dup: number; error: number; easy: number; check: number }

interface Ctx {
  info: ScanInfo | undefined
  infoLoading: boolean
  items: ScanItem[]
  counts: ScanCounts
  busy: boolean
  paused: string | null
  ack: boolean
  setAck: (v: boolean) => void
  add: (files: File[]) => void
  cancel: () => void
  retry: () => void
  clear: () => void
}
const ScanCtx = createContext<Ctx | null>(null)
export const useScan = () => useContext(ScanCtx)!

const IMG = /\.(jpe?g|png|webp|gif)$/i
const CONCURRENCY = 2
const ACK_KEY = 'scan_ack'
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 隐私模式 */ } }
let nextKey = 0

/**
 * 扫描队列放在应用最外层: 关掉扫描窗口、切换页面,识别都会继续,页头有进度提示,完成后弹出提示。
 * 识别遇到限流/关闭会暂停,不再继续硬发。
 */
export function ScanProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { droppedFiles, setDroppedFiles, toast } = useApp()
  const qc = useQueryClient()
  const infoQ = useQuery({ queryKey: ['scanInfo'], queryFn: api.scanInfo, staleTime: 60_000 })
  const [items, setItems] = useState<ScanItem[]>([])
  const [ack, setAckState] = useState(() => read(ACK_KEY) === '1')
  const [paused, setPaused] = useState<string | null>(null)
  const itemsRef = useRef<ScanItem[]>([])
  const running = useRef(0)
  const stopped = useRef(false)
  const batch = useRef('')
  itemsRef.current = items

  const setAck = useCallback((v: boolean) => { setAckState(v); write(ACK_KEY, v ? '1' : '0') }, [])
  const patch = (key: number, p: Partial<ScanItem>) => setItems((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)))

  const pump = useCallback(() => {
    while (!stopped.current && running.current < CONCURRENCY) {
      const next = itemsRef.current.find((x) => x.state === 'waiting')
      if (!next) break
      next.state = 'scanning' // 立刻标记,避免同一张被两个 worker 取走
      running.current++
      patch(next.key, { state: 'scanning' })
      void api.scanImage(next.file, batch.current)
        .then((o) => { patch(next.key, { state: o.duplicate ? 'dup' : 'done', outcome: o }); void qc.invalidateQueries({ queryKey: ['stats'] }); void qc.invalidateQueries({ queryKey: ['queue'] }) })
        .catch((e: Error) => {
          const status = e instanceof ApiError ? e.status : 0
          patch(next.key, { state: 'error', error: e.message })
          if (status === 429 || status === 503) { stopped.current = true; setPaused(e.message) }
        })
        .finally(() => { running.current--; pump() })
    }
  }, [qc])

  const add = useCallback((files: File[]) => {
    const imgs = files.filter((f) => IMG.test(f.name))
    const skipped = files.length - imgs.length
    if (skipped) toast(t('scan.skipped', { n: skipped }), 'info')
    if (!imgs.length) return
    if (!ack && !infoQ.data?.local) { toast(t('scan.needAck'), 'err'); return } // 识别服务在内网时,图片不出内网,不需要这个确认
    if (!batch.current || !itemsRef.current.some((x) => x.state === 'waiting' || x.state === 'scanning')) batch.current = `scan ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
    stopped.current = false
    setPaused(null)
    setItems((l) => [...l, ...imgs.map((file) => ({ key: ++nextKey, file, state: 'waiting' as ScanState }))])
    queueMicrotask(() => requestAnimationFrame(pump))
  }, [ack, infoQ.data?.local, pump, t, toast])

  // 拖到页面任意位置的图片通过全局状态交过来
  useEffect(() => {
    if (droppedFiles.length && infoQ.data?.enabled) { const f = droppedFiles; setDroppedFiles([]); add(f) }
  }, [droppedFiles, infoQ.data?.enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo<ScanCounts>(() => {
    const c: ScanCounts = { waiting: 0, scanning: 0, done: 0, dup: 0, error: 0, easy: 0, check: 0 }
    for (const x of items) {
      c[x.state]++
      if (x.state === 'done') (x.outcome?.status === 'AUTO_VERIFIED' || x.outcome?.status === 'AUTO' ? c.easy++ : c.check++)
    }
    return c
  }, [items])
  // 暂停(限流)时剩下的还在排队,但没有在跑: 不算忙碌,界面才能给出「继续」
  const busy = counts.scanning > 0 || (counts.waiting > 0 && !paused)

  // 一批识别完成(从忙碌变成空闲): 弹一条汇总提示,哪怕员工已经关掉了窗口
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy && items.length > 0 && counts.waiting === 0) toast(t('scan.finished', { easy: counts.easy, check: counts.check, dup: counts.dup, err: counts.error }), counts.error ? 'err' : 'ok', { duration: 6000 })
    wasBusy.current = busy
  }, [busy]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => { stopped.current = false; setPaused(null); setItems((l) => l.map((x) => (x.state === 'error' ? { ...x, state: 'waiting', error: undefined } : x))); queueMicrotask(() => requestAnimationFrame(pump)) }, [pump])
  const cancel = useCallback(() => { stopped.current = true; setItems((l) => l.filter((x) => x.state !== 'waiting')) }, [])
  const clear = useCallback(() => { if (!busy) { setItems([]); setPaused(null) } }, [busy])

  // 还有图片在识别时关闭/刷新页面: 浏览器会提醒(没发出去的会丢)
  useEffect(() => {
    if (!busy) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [busy])

  const value = useMemo<Ctx>(() => ({ info: infoQ.data, infoLoading: infoQ.isLoading, items, counts, busy, paused, ack: ack || !!infoQ.data?.local, setAck, add, cancel, retry, clear }), [infoQ.data, infoQ.isLoading, items, counts, busy, paused, ack, setAck, add, cancel, retry, clear])
  return <ScanCtx.Provider value={value}>{children}</ScanCtx.Provider>
}
