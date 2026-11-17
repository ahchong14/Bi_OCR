import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom'
import { PIPELINE_STATUSES, type FieldKey, type Item, type PipelineStatus } from '../../../shared/types'
import { ApiError, api } from '../api'
import { ImageViewer } from '../components/ImageViewer'
import { Dialog, Empty, Loading, StatusBadge } from '../components/ui'
import { useApp } from '../context'
import { useI18n, type Key, type T } from '../i18n'
import { parseLooseDate, isIsoDate } from '../lib/dates'
import { canon, diffFields, formErrors, newItem, runRecon, toForm, toISO, toPayload, withAmount, type FormState } from '../lib/checks'
import { explain, headline } from '../lib/explain'
import { normCurrency, roundUnit } from '../../../shared/reconcile'
import { enrichRows, fullTextOf, itemAmountSet, lineAmount, modelItemRows, rateOf, type ModelItemRow } from '../../../shared/items'
import { SecondPanel } from '../components/SecondPanel'
import { fieldsToConfirm, fmtCorrection, pendingConfirm, queueTags, restoreText, sortAlerts } from '../lib/review'
import { isSystemUser, money, moneyC, parseNum, stamp } from '../lib/format'

const ZH2KEY: Record<string, FieldKey> = { 总额: 'total', 日期: 'date', 商家: 'merchant', 商品明细: 'items' }
/** 属于「商品明细」那一页的对账提示(其余的留在「金额」那一页)。 */
const ITEM_CHECKS = new Set<string>(['items_vs_subtotal', 'tax_by_rate', 'item_exceeds_total'])
const ALL_FIELDS: readonly string[] = ['merchant', 'date', 'currency', 'subtotal', 'discount', 'service_charge', 'tax', 'tip', 'fees', 'rounding', 'total', 'paid', 'change', 'items']
/** 更正记录/建议里的字段名: 流水线写中文(总额…),门户自己写英文键(service_charge…),两种都认。 */
const keyOf = (f: string): FieldKey | null => ZH2KEY[f] ?? (ALL_FIELDS.includes(f) ? (f as FieldKey) : null)
/** 队列排序。默认是服务端的"最需要检查的在前";其余按导入时间或金额。 */
const SORTS = { priority: {}, newest: { sort: 'importedAt', dir: 'desc' }, oldest: { sort: 'importedAt', dir: 'asc' }, amount: { sort: 'total', dir: 'desc' } } as const
type SortKey = keyof typeof SORTS
const readLS = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 隐私模式下写不进去不影响使用 */ } }
const readSS = (k: string, d: string) => { try { return sessionStorage.getItem(k) ?? d } catch { return d } }
const writeSS = (k: string, v: string) => { try { sessionStorage.setItem(k, v) } catch { /* 同上 */ } }
const REJECT_QUICK: Key[] = ['reject.q1', 'reject.q2', 'reject.q3', 'reject.q4', 'reject.q5']
const CURRENCIES = ['MYR', 'SGD', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'AUD', 'IDR', 'THB', 'KRW', 'INR', 'CAD', 'NZD']
type ScalarKey = Exclude<keyof FormState, 'items' | 'note'>
type Sug = { label: string; apply: (f: FormState) => FormState }
type Nav = { index: number; total: number; prevId?: number; nextId?: number }

const snapshot = (f: FormState) => JSON.stringify([canon(f), f.note.trim()])

/** 从一段文字里认出日期,统一成 YYYY-MM-DD;认不出返回 null。
 *  支持: 2018-06-23、23/06/2018、23-06-18、22 MAR 2018、5th January 2018、Jan 5, 2018、2018 Jan 05、05-Jan-18(后面带时间也行)。
 *  纯数字的 日/月/年 按东南亚小票最常见的「日在前」处理。 */
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function monthNo(word: string): number {
  const w = word.toLowerCase()
  if (w.length < 3) return 0
  const i = MONTH_NAMES.findIndex((n) => n === w || (w.length >= 3 && n.startsWith(w)) || (w === 'sept' && n === 'september'))
  return i + 1
}
function dateFromText(text: string): string | null {
  const pad = (n: string | number) => String(n).padStart(2, '0')
  const year = (y: string) => (y.length === 2 ? `20${y}` : y)
  const ok = (y: string, mo: number, d: string) => mo >= 1 && mo <= 12 && +d >= 1 && +d <= 31 ? `${year(y)}-${pad(mo)}-${pad(d)}` : null
  let m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]*([A-Za-z]{3,9})\.?,?[\s.-]*(\d{4}|\d{2})\b/.exec(text) // 22 MAR 2018 / 05-Jan-18
  if (m && monthNo(m[2]!)) { const r = ok(m[3]!, monthNo(m[2]!), m[1]!); if (r) return r }
  m = /\b([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/.exec(text) // Jan 5, 2018
  if (m && monthNo(m[1]!)) { const r = ok(m[3]!, monthNo(m[1]!), m[2]!); if (r) return r }
  m = /\b(\d{4})[\s.-]*([A-Za-z]{3,9})\.?[\s.-]*(\d{1,2})\b/.exec(text) // 2018 Jan 05
  if (m && monthNo(m[2]!)) { const r = ok(m[1]!, monthNo(m[2]!), m[3]!); if (r) return r }
  m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (m) return `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`
  m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(text)
  if (m) return `${year(m[3]!)}-${pad(m[2]!)}-${pad(m[1]!)}`
  return null
}

/** 滚动到某个字段、聚焦并闪一下,让审核员一眼看到该看哪里。scroll=false 时不滚动(用键盘连续确认时避免页面乱跳)。 */
function locate(k: FieldKey, scroll = true) {
  const el = k === 'items' ? document.querySelector<HTMLElement>('table.items') : document.getElementById(`f_${k}`)
  if (!el) return
  const panel = el.closest<HTMLElement>('[data-rpanel]') // 字段在没显示的那一页(商家详情 / 金额与明细)时,先切过去
  if (panel?.hidden) document.querySelector<HTMLElement>(`[data-rtab="${panel.dataset.rpanel}"]`)?.click()
  const box = k === 'items' ? el : el.closest<HTMLElement>('.f')
  if (scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (k !== 'items') window.setTimeout(() => el.focus({ preventScroll: true }), 80) // 从弹窗里跳过来时,弹窗关闭会把焦点还给原来的按钮,所以等一下再聚焦
  box?.classList.add('flash')
  window.setTimeout(() => box?.classList.remove('flash'), 1500)
}

// ============================================================ 页面: 左侧队列 + 右侧审核
export default function ReviewPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { user, toast, setImportOpen, setImportTab } = useApp()
  const { t, field } = useI18n()
  const [status, setStatus] = useState<PipelineStatus | ''>('')
  const [search, setSearch] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [sort, setSortState] = useState<SortKey>(() => (readLS('portal_queue_sort', 'priority') in SORTS ? (readLS('portal_queue_sort', 'priority') as SortKey) : 'priority'))
  const [qOpen, setQOpenState] = useState(() => readLS('portal_queue_open', '1') !== '0') // 左边的收据列表可以收起,收起后原图/识别文字和表单两栏平分整页
  const setQOpen = (v: boolean) => { setQOpenState(v); writeLS('portal_queue_open', v ? '1' : '0') }
  const setSort = (k: SortKey) => { setSortState(k); writeLS('portal_queue_sort', k) }
  const [done, setDone] = useState(() => Number(readSS('portal_done', '0')) || 0) // 这个浏览器标签页里已经处理了几张(关掉标签页就清零),用来显示进度
  const bumpDone = (n: number) => setDone((v) => { const x = Math.max(0, v + n); writeSS('portal_done', String(x)); return x })
  const handled = useRef(new Set<number>()) // 本次刚通过/驳回的收据编号: 队列刷新前列表还是旧的,自动打开「第一张」时要跳过它们

  // 队列分页加载(每次 200 张): 以前一次最多取 500 张,收据超过 500 张时后面的根本看不到
  const QUEUE_PAGE = 200
  const queue = useInfiniteQuery({
    queryKey: ['queue', status, search, sort],
    queryFn: ({ pageParam }) => api.receipts({ state: 'pending', status: status || undefined, q: search || undefined, ...SORTS[sort], pageSize: QUEUE_PAGE, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (all.length * QUEUE_PAGE < last.total ? all.length + 1 : undefined),
    placeholderData: keepPreviousData,
  })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const rows = useMemo(() => queue.data?.pages.flatMap((p) => p.rows) ?? [], [queue.data])
  const queueTotal = queue.data?.pages[0]?.total ?? 0
  const activeId = id ? Number(id) : null
  const index = rows.findIndex((r) => r.id === activeId)

  // 没有选中时自动打开队列第一张
  useEffect(() => {
    const first = rows.find((r) => !handled.current.has(r.id))
    if (activeId === null && first) nav(`/review/${first.id}`, { replace: true })
  }, [activeId, rows, nav])

  const bulk = useMutation({
    mutationFn: () => api.bulk({ ids: rows.map((r) => r.id), action: 'approve', user }),
    onSuccess: (r) => { toast(t('toast.bulkDone', { n: r.done }), 'ok'); setBulkOpen(false); void qc.invalidateQueries(); nav('/review', { replace: true }) },
    onError: (e: ApiError) => { toast(e.message, 'err'); setBulkOpen(false) },
  })

  // 看到队列末尾附近时自动加载下一批,按「下一张」不会突然到头
  useEffect(() => {
    if (!queue.hasNextPage || queue.isFetchingNextPage) return
    // 打开的这张在后面的批次里(链接直达、刷新): 继续往后加载直到找到它(最多多取几批,以免它根本不在待审核队列里时一直取)
    const lookingFor = activeId !== null && index === -1 && (queue.data?.pages.length ?? 0) < 4
    if (lookingFor || (index >= 0 && index >= rows.length - 25)) void queue.fetchNextPage()
  }, [index, activeId, rows.length, queue.hasNextPage, queue.isFetchingNextPage]) // eslint-disable-line react-hooks/exhaustive-deps

  const easy = (status === 'AUTO' || status === 'AUTO_VERIFIED') && rows.length > 0
  const counts = stats.data?.pendingByStatus ?? {}
  const empty = stats.data && stats.data.pending + stats.data.approved + stats.data.rejected === 0
  useEffect(() => {
    if (status && stats.data && (counts[status] ?? 0) === 0 && stats.data.pending > 0) setStatus('') // 选中的筛选已经没有收据了,回到「全部」
  }, [status, stats.data]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 处理完一张后跳到队列里的下一张(没有了就回到空状态)。 */
  const advance = (doneId: number) => {
    bumpDone(1)
    handled.current.add(doneId)
    const ids = rows.map((r) => r.id)
    const i = ids.indexOf(doneId)
    const next = ids[i + 1] ?? ids[i - 1]
    nav(next && next !== doneId ? `/review/${next}` : '/review', { replace: true })
  }

  /** 撤销刚做的通过/驳回:重新打开,并回到这一张继续看。 */
  const undo = async (rid: number, version: number) => {
    try {
      await api.review(rid, { action: 'reopen', version, user })
      bumpDone(-1)
      handled.current.delete(rid)
      await qc.invalidateQueries()
      toast(t('toast.undone'), 'ok')
      nav(`/review/${rid}`)
    } catch (e) { toast((e as Error).message, 'err') }
  }

  if (empty) {
    return (
      <div className="onboard">
        <Empty icon="🧾" title={t('onboard.title')} action={<button className="btn primary big" onClick={() => { setImportTab('scan'); setImportOpen(true) }}>{t('onboard.btn')}</button>}>
          <ol className="steps">
            <li>{t('onboard.s1')}</li><li>{t('onboard.s2')}</li><li>{t('onboard.s3')}</li>
          </ol>
        </Empty>
      </div>
    )
  }

  return (
    <div className={`review-layout ${qOpen ? '' : 'qclosed'}`}>
      <button type="button" className="qrail" title={t('queue.show')} aria-label={t('queue.show')} onClick={() => setQOpen(true)}>»<span>{t('queue.show')}</span></button>
      <aside className="queue">
        <div className="queue-head">
          <div className="qtop">
            <input className="search" type="search" placeholder={t('review.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn sm qcollapse" title={t('queue.hide')} aria-label={t('queue.hide')} onClick={() => setQOpen(false)}>«</button>
          </div>
          <div className="chips">
            <button className={`chip ${status === '' ? 'on' : ''}`} onClick={() => setStatus('')}>{t('common.all')} {stats.data?.pending ?? 0}</button>
            {PIPELINE_STATUSES.map((s) => {
              const n = counts[s] ?? 0
              return (
                <button key={s} className={`chip ${status === s ? 'on' : ''} ${n === 0 ? 'zero' : ''}`} disabled={n === 0 && status !== s} title={t(`status.desc.${s}` as Key)} onClick={() => setStatus(s)}>{t(`status.${s}` as Key)} {n}</button>
              )
            })}
          </div>
          <div className="qtools">
            <label className="qsort"><span>{t('review.sort')}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {(Object.keys(SORTS) as SortKey[]).map((k) => <option key={k} value={k}>{t(`review.sort.${k}` as Key)}</option>)}
              </select>
            </label>
          </div>
          {done > 0 && (
            <div className="qprog" role="status">
              <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round((done / (done + (stats.data?.pending ?? 0))) * 100)}%` }} /></div>
              <span>{t('review.progress', { done, left: stats.data?.pending ?? 0 })}</span>
            </div>
          )}
          {easy && (
            <div className="bulkbar">
              <span>{t('review.bulk.text', { n: rows.length })}</span>
              <button className="btn primary sm" onClick={() => setBulkOpen(true)}>{t('review.bulk.btn')}</button>
            </div>
          )}
        </div>
        <div className="queue-list">
          {queue.isLoading ? <Loading /> : rows.length === 0 ? (
            <div className="listempty">{search || status ? t('review.queue.noMatch') : <>{t('review.queue.empty')}<br />{t('review.queue.emptyHint')}</>}</div>
          ) : <>{rows.map((r) => (
            <button key={r.id} className={`qitem ${r.id === activeId ? 'on' : ''}`} onClick={() => nav(`/review/${r.id}`)}>
              <i className={`dot st-${r.pipelineStatus}`} />
              <div className="meta">
                <div className="title">{r.merchant ?? t('review.noMerchant')}</div>
                <div className="sub">{r.date ?? t('review.noDate')} · {moneyC(r.total, r.currency)}</div>
                {(() => {
                  const text = headline(r.reasons, t, field)
                  const { tags, more } = queueTags(r.reasons.map((c) => explain(c, t, field)))
                  // 有明确要看的字段就显示字段标签(一眼就知道看哪里),否则显示文字摘要(最多两行,完整内容在悬停提示里)
                  return tags.length
                    ? <div className="why qtags" title={text}><span aria-hidden="true">⚠</span>{tags.map((f) => <span key={f} className="qtag">{field(f)}</span>)}{more > 0 && <span className="qtag more">+{more}</span>}</div>
                    : <div className="why" title={text}>{text}</div>
                })()}
              </div>
              {(r.secondState === 'pending' || r.secondState === 'running') && <span className="pill" title={t('second.queued')}>⏳ {t('second.title')}</span>}
              <StatusBadge status={r.pipelineStatus} />
            </button>
          ))}
            {queue.hasNextPage && (
              <button className="btn sm loadmore" disabled={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
                {queue.isFetchingNextPage ? t('common.loading') : t('review.loadMore', { n: rows.length, total: queueTotal })}
              </button>
            )}</>}
        </div>
      </aside>

      <main className="review-main">
        {activeId === null
          ? <Empty icon="👈" title={t('review.pick.title')}>{t('review.pick.body')}</Empty>
          : <ReviewPane key={activeId} id={activeId} qOpen={qOpen} nav={{ index, total: queueTotal || rows.length, prevId: rows[index - 1]?.id, nextId: rows[index + 1]?.id }} onAdvance={advance} onUndo={undo} />}
      </main>

      <Dialog
        open={bulkOpen} onClose={() => setBulkOpen(false)} title={t('review.bulk.title')}
        footer={<><button className="btn" onClick={() => setBulkOpen(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={bulk.isPending} onClick={() => (user.trim() ? bulk.mutate() : toast(t('toast.nameNeeded'), 'err'))}>{t('review.bulk.confirm', { n: rows.length })}</button></>}
      >
        <p>{t('review.bulk.body', { n: rows.length })}</p>
        <p className="muted">{t('review.bulk.hint')}</p>
      </Dialog>
    </div>
  )
}

// ============================================================ 单张审核
function ReviewPane({ id, qOpen, nav: pos, onAdvance, onUndo }: { id: number; qOpen: boolean; nav: Nav; onAdvance: (id: number) => void; onUndo: (id: number, version: number) => void }) {
  const { t, field: fl } = useI18n()
  const { user, setUser, toast, requireAck } = useApp()
  const qc = useQueryClient()
  const go = useNavigate()
  const detail = useQuery({ queryKey: ['receipt', id], queryFn: () => api.receipt(id), refetchOnWindowFocus: false })
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: 60_000 })
  const d = detail.data
  // 提前加载下一张的详情和图片,点「通过并下一张」时几乎没有等待
  const nextId = pos.nextId
  useEffect(() => {
    if (!d || !nextId) return
    void qc.fetchQuery({ queryKey: ['receipt', nextId], queryFn: () => api.receipt(nextId) }).then((n) => { if (n.hasImage) { const img = new Image(); img.src = api.imageUrl(n.id, n.importedAt) } }).catch(() => { /* 预加载失败不影响当前这张 */ })
  }, [d?.id, nextId, qc])
  const [form, setForm] = useState<FormState | null>(null)
  const [base, setBase] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [warnOpen, setWarnOpen] = useState(false)
  // 中间栏: 原图和识别文字之间的分隔条,可以拖动调整比例(记住上次的位置;双击恢复默认)
  // 列表展开时原图默认占 28%(留更多地方给识别文字);列表收起后中间栏变宽,默认上下各一半。两种状态各记一个位置
  const readImg = (k: string, def: number) => { const n = Number(readLS(k, String(def))); return n >= 12 && n <= 75 ? n : def }
  const [imgOpen, setImgOpen] = useState(() => readImg('portal_img_pct', 28))
  const [imgClosed, setImgClosed] = useState(() => readImg('portal_img_pct_closed', 50))
  const imgKey = qOpen ? 'portal_img_pct' : 'portal_img_pct_closed'
  const imgDef = qOpen ? 28 : 50
  const imgPct = qOpen ? imgOpen : imgClosed
  const setImgPct = qOpen ? setImgOpen : setImgClosed
  const leftRef = useRef<HTMLDivElement>(null)
  const clampPct = (n: number) => Math.min(75, Math.max(12, n))
  const startSplit = (e: React.PointerEvent) => {
    const el = leftRef.current
    if (!el) return
    e.preventDefault() // 拖的时候不要选中文字
    let last = imgPct
    const move = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); last = clampPct(qOpen ? ((ev.clientY - r.top) / r.height) * 100 : ((ev.clientX - r.left) / r.width) * 100); setImgPct(last) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); writeLS(imgKey, String(Math.round(last))) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const nudgeSplit = (delta: number) => { const v = clampPct(imgPct + delta); setImgPct(v); writeLS(imgKey, String(Math.round(v))) }
  const [rtab, setRtabState] = useState<'details' | 'amounts' | 'items'>(() => { const v = readSS('portal_rtab', 'details'); return v === 'amounts' || v === 'items' ? v : 'details' }) // 右边表单当前在哪一页(切换收据时保持)
  // 左右两栏(原图+识别文字 | 表单)之间的分隔条: 列表展开时默认 5:3,收起后默认平分;两种状态各记一个位置,双击恢复默认
  const readPct = (k: string, def: number) => { const n = Number(readLS(k, String(def))); return n >= 30 && n <= 75 ? n : def }
  const [colOpen, setColOpen] = useState(() => readPct('portal_col_open', 62.5))
  const [colClosed, setColClosed] = useState(() => readPct('portal_col_closed', 65))
  const colKey = qOpen ? 'portal_col_open' : 'portal_col_closed'
  const colDef = qOpen ? 62.5 : 65
  const colPct = qOpen ? colOpen : colClosed
  const setColPct = qOpen ? setColOpen : setColClosed
  const rvRef = useRef<HTMLDivElement>(null)
  const startColSplit = (e: React.PointerEvent) => {
    const el = rvRef.current
    if (!el) return
    e.preventDefault()
    let last = colPct
    const move = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); last = Math.min(75, Math.max(30, ((ev.clientX - r.left - 14) / (r.width - 28)) * 100)); setColPct(last) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); writeLS(colKey, String(Math.round(last * 10) / 10)) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const nudgeCol = (delta: number) => { const v = Math.min(75, Math.max(30, colPct + delta)); setColPct(v); writeLS(colKey, String(v)) }
  const [alertsOpen, setAlertsOpen] = useState(false) // 顶部提示默认折叠成一行摘要,点「看详情」才展开
  const setRtab = (v: 'details' | 'amounts' | 'items') => { setRtabState(v); writeSS('portal_rtab', v) }
  const [active, setActive] = useState<ScalarKey | null>(null)
  const [bulkTax, setBulkTax] = useState('') // 「全部商品税率」输入框
  const [activeItem, setActiveItem] = useState<number | null>(null) // 当前选中的商品金额格子(点原文里的数字会填进去)
  const focusItem = useRef<number | null>(null) // 新加一行后要聚焦的行
  useEffect(() => {
    if (focusItem.current === null) return
    document.getElementById(`it_${focusItem.current}_name`)?.focus()
    focusItem.current = null
  }, [form?.items.length])
  const [touched, setTouched] = useState<Set<string>>(new Set()) // 离开过的金额格子;输入到一半的格子不提前标红
  const [attempted, setAttempted] = useState(false) // 点过通过/保存后,所有写错的格子都标红
  const skipBlock = useRef(false)
  const draftRef = useRef<FormState | null>(null) // 保存时发现别人刚改过: 先把员工正在填的内容存下来,别被服务器版本冲掉
  const [theirs, setTheirs] = useState<FormState | null>(null) // 对方保存的版本(有冲突时才有),可以一键改用
  const [dateNote, setDateNote] = useState('') // 自动把 14/02/2018 改成 2018-02-14 后的提示
  const [acked, setAcked] = useState<Set<FieldKey>>(new Set()) // 审核员点过「已核对」的被标记字段(换一张收据就清空)
  const [ackOpen, setAckOpen] = useState(false) // 还有被标记的字段没确认就点通过时弹出的提示
  const [nameOpen, setNameOpen] = useState(false) // 还没填审核人姓名就点通过/驳回/保存时弹出输入框
  const [nameText, setNameText] = useState('')
  const afterName = useRef<(() => void) | null>(null)
  const latest = useRef<{ approve: () => void; submit: (a: 'approve' | 'reject' | 'save' | 'reopen', n?: string) => void }>({ approve: () => {}, submit: () => {} })
  const ack = (k: FieldKey) => setAcked((x) => new Set(x).add(k))
  const unack = (k: FieldKey) => setAcked((x) => { const n = new Set(x); n.delete(k); return n })
  /** 还没填姓名: 弹出输入框,保存后接着做刚才想做的事(以前只弹一个提示,要自己去右上角找输入框)。 */
  const askName = (then: () => void) => { afterName.current = then; setNameText(''); setNameOpen(true) }
  const saveName = () => {
    const n = nameText.trim()
    if (!n) return
    setUser(n); setNameOpen(false)
    const f = afterName.current; afterName.current = null
    window.setTimeout(() => f?.(), 0) // 等姓名写进状态、界面重新渲染之后,再继续刚才的操作
  }
  const dateRef = useRef<HTMLInputElement>(null)

  // 载入数据(或服务端版本变化)时重置表单
  useEffect(() => {
    if (!d) return
    const f = toForm(d.data, d.state === 'pending' ? '' : (d.note ?? ''))
    setBase(snapshot(f))
    if (draftRef.current) { setForm(draftRef.current); setTheirs(f); draftRef.current = null } // 冲突: 保留我的修改,并提供「改用对方的版本」
    else { setForm(f); setTheirs(null) }
    setDateNote('')
  }, [d?.id, d?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const pending = d?.state === 'pending'
  const dirty = !!form && pending && snapshot(form) !== base
  const blocker = useBlocker(() => dirty && !skipBlock.current)
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const act = useMutation({
    mutationFn: (a: { action: 'approve' | 'reject' | 'save' | 'reopen'; note?: string }) =>
      api.review(id, { action: a.action, version: d!.version, user, note: a.note, final: a.action === 'reopen' ? undefined : toPayload(form!) }),
    onSuccess: (res, a) => {
      qc.setQueryData(['receipt', id], res)
      for (const k of ['queue', 'stats', 'table', 'analytics', 'audit', 'meta']) void qc.invalidateQueries({ queryKey: [k] })
      if (a.action === 'approve' || a.action === 'reject') {
        toast(a.action === 'approve' ? t('toast.approved') : t('toast.rejected'), 'ok', { duration: 8000, action: { label: t('toast.undo'), onClick: () => onUndo(id, res.version) } })
        skipBlock.current = true
        onAdvance(id)
      } else toast(a.action === 'save' ? t('toast.saved') : t('toast.reopened'), 'ok')
    },
    onError: (e: ApiError) => {
      if (e.status === 409) { draftRef.current = form; toast(t('toast.conflict'), 'err'); void detail.refetch() }
      else toast(e.message, 'err')
    },
  })

  /** 金额有写错的格子时不让提交: 标红、提示、把光标放到第一个有问题的格子。 */
  const amountsOk = (needRequired = false) => {
    if (!form) return true
    const badDate = form.date.trim() !== '' && !isIsoDate(form.date.trim())
    const missing = needRequired && (!form.merchant.trim() || parseNum(form.total) === null || Number.isNaN(parseNum(form.total)))
    if (!formErrors(form).count && !badDate && !missing) return true
    setAttempted(true)
    toast(missing && !formErrors(form).count && !badDate ? t('toast.fillRequired') : t('toast.fixAmounts'), 'err')
    requestAnimationFrame(() => document.querySelector<HTMLElement>('input.invalid')?.focus())
    return false
  }

  const submit = (action: 'approve' | 'reject' | 'save' | 'reopen', note?: string) => {
    if (!user.trim()) { askName(() => latest.current.submit(action, note)); return }
    if (action !== 'reopen' && !amountsOk(action === 'approve')) return
    act.mutate({ action, note: note ?? (action === 'reopen' ? undefined : form?.note) })
  }

  // ---- 派生: 对账 / 提示 / 建议 / 改动标记 ----
  const recon = useMemo(() => (form ? runRecon(form, t) : null), [form, t])
  const evidence = useMemo(() => itemAmountSet(fullTextOf(d?.ocrText ?? '')), [d?.ocrText]) // 整页转写里出现过的金额: 「算出的金额 / 模型读到的金额」对不上时,看哪个真的印在票上(必须在提前 return 之前,hooks 数量每次渲染要一样)
  const view = useMemo(() => {
    if (!d || !form || !recon) return null
    const flags: Partial<Record<FieldKey, string[]>> = {}
    const alerts: ReturnType<typeof explain>[] = []
    const seen = new Set<string>()
    const nowCur = canon(form)
    let suppressed = 0 // 员工已经处理掉的提示数量
    let singleSource = false // 「只有一个识别来源」每张门户扫描的收据都有,不当成提示挤在最上面,放到底部的识别信息里
    for (const code of d.reasons) {
      if (code === 'scanned_in_portal') { singleSource = true; continue }
      // 「没读到总额/商家/日期」这类提示,员工填好以后就不该再挂着
      const miss = /^missing_(total|merchant|date)$/.exec(code)
      if (miss && nowCur[miss[1] as 'total' | 'merchant' | 'date'] != null) { suppressed++; continue }
      // 「没能识别出内容」「文字识别质量差」这类整体提示: 员工已经把商家和总额都填好,就不用再挂着
      if ((code === 'extract_failed' || code === 'ocr_bad' || code === 'error') && nowCur.merchant && nowCur.total != null) { suppressed++; continue }
      if (code === 'items_not_extracted' && nowCur.items.length > 0) { suppressed++; continue }
      const e = explain(code, t, fl)
      if (e.code === 'auto_corrected' || e.code === 'auto_cleared') {
        // 系统自动改过什么,直接写出来: "总额: 22.00 → 23.32"(以前只说"系统更正了总额/小计",要自己去找改了多少)
        const parts = d.corrections.flatMap((c) => { const k = keyOf(c.field); return k && e.fields.includes(k) ? [`${fl(k)}: ${fmtCorrection(c.old, money, t('note.empty'))} → ${fmtCorrection(c.new, money, t('note.clearedWord'))}`] : [] })
        if (parts.length) e.text = `${e.text} (${parts.join('; ')})`
      }
      if (seen.has(e.text)) continue
      seen.add(e.text)
      alerts.push(e)
      for (const f of e.fields) (flags[f] ??= []).push(e.text)
    }
    const sugs: Partial<Record<FieldKey, Sug[]>> = {}
    const add = (k: FieldKey, label: string, apply: Sug['apply']) => {
      const list = (sugs[k] ??= [])
      if (!list.some((x) => x.label === label)) list.push({ label, apply })
    }
    const cur = canon(form)
    const saw = d.verifier.saw
    if (saw?.merchant && saw.merchant.trim().toLowerCase() !== (cur.merchant ?? '').toLowerCase()) add('merchant', t('sug.verifier', { v: saw.merchant }), (f) => ({ ...f, merchant: saw.merchant! }))
    const vd = toISO(String(saw?.date ?? ''))
    if (vd && vd !== cur.date) add('date', t('sug.verifier', { v: vd }), (f) => ({ ...f, date: vd }))
    const addTotal = (label: Key, v: number | null | undefined) => {
      if (v !== null && v !== undefined && !Number.isNaN(v) && v !== cur.total) add('total', t(label, { v: money(v) }), (f) => ({ ...f, total: v.toFixed(2) }))
    }
    // 对账引擎的推算(缺小计/税额/舍入、由付款推总额…),比逐字段的"第二个模型读到"更有依据,放在最前
    for (const fill of recon.result.fills) {
      const now = cur[fill.field]
      if (now !== null && Math.abs(now - fill.value) < 0.005) continue
      add(fill.field, t(`fill.${fill.field}.${fill.reason}` as Key, { v: money(fill.value), rate: Number(fill.params.rate ?? 0) }), (f) => ({ ...f, [fill.field]: fill.value.toFixed(2) }))
    }
    addTotal('sug.verifier', parseNum(String(saw?.total ?? '')))
    // 第二个读取模型对争议字段的读数,作为建议(采纳前审核员对照原图确认)
    for (const f of d.second?.disputed ?? []) {
      const v = d.second?.model2?.candidate[f]
      const k = keyOf(f)
      if (v === null || v === undefined || v === '' || !k || k === 'items') continue
      if (k === 'merchant' || k === 'date') { if (String(v) !== String(cur[k] ?? '')) add(k, t('sug.second', { v: String(v) }), (fm) => ({ ...fm, [k]: String(v) })) }
      else { const n = Number(v); if (!Number.isNaN(n) && n !== cur[k]) add(k, t('sug.second', { v: money(n) }), (fm) => ({ ...fm, [k]: n.toFixed(2) })) }
    }
    addTotal('sug.system', d.suggestedTotal)
    addTotal('sug.text', d.regexTotal)
    for (const s of d.suggestions) {
      const k = keyOf(s.field)
      if (!k) continue
      if (k === 'items' && Array.isArray(s.value)) add('items', t('sug.items', { n: s.value.length }), (f) => ({ ...f, items: (s.value as Item[]).map(newItem) }))
      else if (k !== 'items') add(k, t('sug.system', { v: String(s.new) }), (f) => ({ ...f, [k]: String(s.new) }))
    }
    const notes: Partial<Record<FieldKey, string[]>> = {}
    const empty = t('note.empty')
    for (const c of d.corrections) {
      const k = keyOf(c.field)
      if (!k) continue
      ;(notes[k] ??= []).push(c.new === null || c.new === undefined || c.new === ''
        ? t('note.cleared', { old: fmtCorrection(c.old, money, empty) })
        : t('note.corrected', { old: fmtCorrection(c.old, money, empty), new: fmtCorrection(c.new, money, empty) }))
      if (k !== 'items' && c.old !== null && c.old !== undefined) add(k, t('sug.restore', { v: fmtCorrection(c.old, money, empty) }), (f) => ({ ...f, [k]: restoreText(c.old) }))
    }
    return { flags, alerts: sortAlerts(alerts), needAck: fieldsToConfirm(alerts), singleSource, sugs, notes, suppressed, changed: new Set(diffFields(d.machine, cur)) }
  }, [d, form, recon, t, fl])

  // 还没处理的被标记字段(没点「已核对」也没改过值)。设置里关掉「通过前要确认」就恒为空
  const pendingAck = useMemo(() => (view && pending && requireAck ? pendingConfirm(view.needAck, acked, view.changed) : []), [view, pending, requireAck, acked])

  const requestApprove = () => {
    if (!user.trim()) { askName(() => latest.current.approve()); return } // 先问姓名,再弹对账确认
    if (!amountsOk(true)) return
    if (pendingAck.length) { setAckOpen(true); return } // 系统标出来的字段还没处理: 先拦住,以前「需检查」的收据一次点击就能通过
    if (recon?.result.hasFail) setWarnOpen(true)
    else submit('approve')
  }

  latest.current = { approve: requestApprove, submit } // 姓名弹窗保存后要继续的操作,用最新的函数(含最新的姓名和表单)
  useEffect(() => {
    const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    const h = (e: KeyboardEvent) => {
      if (!pending || !form || act.isPending) return
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); requestApprove() }
      else if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) submit('save') }
      else if (e.altKey && e.key === 'ArrowRight' && pos.nextId) { e.preventDefault(); go(`/review/${pos.nextId}`) }
      else if (e.altKey && e.key === 'ArrowLeft' && pos.prevId) { e.preventDefault(); go(`/review/${pos.prevId}`) }
      else if (!e.ctrlKey && !e.altKey && !e.metaKey && ![...document.querySelectorAll('dialog')].some((d) => d.open)) {
        // 单键快捷键: 只在没有在输入框里打字、也没有弹窗时生效。故意没有单键「通过」,避免误触(通过用 Ctrl+Enter)
        if (typing(e.target)) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return } // 在输入框里按 Esc 退出输入框,单键快捷键才生效
        const k = e.key.toLowerCase()
        if (k === 'j' && pos.nextId) go(`/review/${pos.nextId}`)
        else if (k === 'k' && pos.prevId) go(`/review/${pos.prevId}`)
        else if (k === 'f') { const f = pendingAck[0] ?? view?.needAck[0]; if (f) { e.preventDefault(); locate(f) } } // 跳到第一个待确认的字段
        else if (k === 'c') { const f = pendingAck[0]; if (f) { e.preventDefault(); ack(f); const next = pendingAck[1]; if (next) locate(next, false) } } // 标记为已核对,并跳到下一个
        else if (k === 'r') { e.preventDefault(); setRejectNote(''); setRejectOpen(true) }
        else if (e.key === '?') { e.preventDefault(); window.dispatchEvent(new Event('portal:help')) }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }) // 每次渲染重新绑定,保证拿到最新的表单

  if (detail.isError) return <Empty icon="⚠️" title={t('review.loadFailed')}>{(detail.error as Error).message}</Empty>
  if (!d || !form || !view || !recon) return <Loading />

  const set = (k: ScalarKey, v: string) => setForm((f) => f && { ...f, [k]: v })
  const readOnly = !pending
  const normalize = (k: ScalarKey) => { const n = parseNum(form[k]); if (n !== null && !Number.isNaN(n)) set(k, n.toFixed(2)) }
  const pickNumber = (token: string) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    const n = parseNum(token)
    const v = n === null || Number.isNaN(n) ? token : n.toFixed(2)
    if (activeItem !== null && form.items.some((x) => x.key === activeItem)) {
      setForm((f) => f && { ...f, items: f.items.map((x) => (x.key === activeItem ? { ...x, price: v } : x)) })
      return
    }
    if (!active || active === 'merchant' || active === 'date') return toast(t('form.ocr.pickField'), 'info') // 商家/日期格子要点图上的框,不是原文里的数字
    set(active, v)
  }
  /** 点 JSON 里的商品名(description)或商家名(merchant_name),直接填进表单,不用复制粘贴。
   *  商家名 → 商家格子;商品名 → 当前选中的那一行(点过那一行的任何格子就算选中);没选中任何行时,填进第一个还没有名字的行,都有名字了就新加一行。 */
  const pickText = (field: 'description' | 'merchant_name', raw: string) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    let v = raw
    try { v = JSON.parse(`"${raw}"`) as string } catch { /* 不是合法的 JSON 转义(模型输出本来就坏了)就原样用 */ }
    v = v.replace(/\s+/g, ' ').trim()
    if (field === 'merchant_name') return set('merchant', v)
    const rowName = (key: number) => setForm((f) => f && { ...f, items: f.items.map((x) => (x.key === key ? { ...x, name: v } : x)) })
    if (activeItem !== null && form.items.some((x) => x.key === activeItem)) return rowName(activeItem)
    const empty = form.items.find((x) => !x.name.trim())
    if (empty) { setActiveItem(empty.key); return rowName(empty.key) }
    const it = newItem({ qty: 1 })
    it.name = v
    setActiveItem(it.key)
    setForm((f) => f && { ...f, items: [...f.items, it] })
  }
  /** 「字段表格」的 →: 把模型读到的一个字段值填进表单(按字段规整: 日期→YYYY-MM-DD,币种→标准代码,金额→两位小数),并切到那个字段所在的页。 */
  const useField = (k: ScalarKey, raw: string) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    let v = raw.trim()
    if (k === 'merchant') v = v.replace(/\s+/g, ' ')
    else if (k === 'date') { const iso = dateFromText(v); if (!iso) return toast(t('form.box.noDate'), 'info'); v = iso }
    else if (k === 'currency') v = normCurrency(v) ?? v.toUpperCase()
    else { const n = parseNum(v); if (n === null || Number.isNaN(n)) return toast(t('form.err.format'), 'err'); v = n.toFixed(2) }
    set(k, v)
    setRtab(k === 'merchant' || k === 'date' ? 'details' : 'amounts')
  }
  /** 点「字段表格」里模型读到的值: 右边有选中的格子(点过它的输入框)就填进那个格子,没有就填进这一行自己对应的字段。 */
  const pickTarget: ScalarKey | null = activeItem === null ? active : null
  const pickField = (rowKey: ScalarKey, raw: string) => useField(pickTarget ?? rowKey, raw)
  /** 点「明细表格」里的一个格子: 商品名/数量/价格分别填进目标商品行的对应列。
   *  目标行 = 右边选中的那一行;没选中就用第一个空行;都没有就新加一行。填完这一行就成了"选中的行",接着点同一行的其他格子会填进同一行。 */
  const pickItemCell = (col: 'name' | 'qty' | 'uom' | 'discount' | 'tax' | 'price', raw: string) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    const txt = raw.trim()
    if (!txt) return
    setRtab('items') // 填的是右边的商品行,要让它显示出来
    let patch: Partial<{ name: string; qty: string; uom: string; discount: string; taxRate: string; price: string }>
    if (col === 'name') patch = { name: txt.replace(/\s+/g, ' ') }
    else if (col === 'uom') patch = { uom: txt.replace(/\s+/g, ' ').slice(0, 16) }
    else if (col === 'tax') {
      const r = rateOf(txt)
      if (r === null) return toast(t('form.err.format'), 'err')
      patch = { taxRate: String(r) }
    }
    else if (col === 'discount') {
      const n = parseNum(txt)
      if (n === null || Number.isNaN(n)) return toast(t('form.err.format'), 'err')
      patch = { discount: n.toFixed(2) }
    }
    else if (col === 'qty') {
      const q = /-?\d+(?:\.\d+)?/.exec(txt.replace(/,/g, ''))
      if (!q) return toast(t('form.err.format'), 'err')
      patch = { qty: q[0] }
    } else {
      const n = parseNum(txt)
      if (n === null || Number.isNaN(n)) return toast(t('form.err.format'), 'err')
      patch = { price: n.toFixed(2) }
    }
    const sel = activeItem !== null ? form.items.find((x) => x.key === activeItem) : undefined
    const target = sel ?? form.items.find((x) => !x.name.trim() && !x.price.trim())
    if (target) {
      setActiveItem(target.key)
      return setForm((f) => f && { ...f, items: f.items.map((x) => (x.key === target.key ? { ...x, ...patch } : x)) })
    }
    const it = { ...newItem({}), ...patch }
    setActiveItem(it.key)
    setForm((f) => f && { ...f, items: [...f.items, it] })
  }
  /** 明细表格里的一行 → 表单的商品行。金额 = 数量 × 单价 − 折扣(都读得出来时),否则取模型读到的金额(和服务端 itemsOf 的规则一样,见 shared/items.ts 的 lineAmount)。 */
  const toFormItem = (r: ModelItemRow) => {
    const num = (s: string) => { const n = parseNum(s); return n === null || Number.isNaN(n) ? null : n }
    const q = /-?\d+(?:\.\d+)?/.exec(r.quantity.replace(/,/g, ''))
    const disc = num(r.discount ?? '')
    const uom = (r.uom ?? '').replace(/\s+/g, ' ').trim()
    const taxRate = rateOf(r.tax)
    return newItem({ name: r.description.replace(/\s+/g, ' ').trim(), qty: q ? Number(q[0]) : null, price: lineAmount(r, evidence).value, ...(uom ? { uom } : {}), ...(disc !== null ? { discount: disc } : {}), ...(taxRate !== null ? { taxRate } : {}) })
  }
  /** 「→」: 填进当前选中的商品行;没选中就填进第一个空行;都有内容就新加一行。 */
  const useRow = (r: ModelItemRow) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    setRtab('items')
    const it = toFormItem(r)
    const sel = activeItem !== null ? form.items.find((x) => x.key === activeItem) : undefined
    const target = sel ?? form.items.find((x) => !x.name.trim() && !x.price.trim())
    if (target) {
      setActiveItem(target.key)
      return setForm((f) => f && { ...f, items: f.items.map((x) => (x.key === target.key ? { ...x, name: it.name, qty: it.qty, uom: it.uom, discount: it.discount, taxRate: it.taxRate, price: it.price } : x)) })
    }
    setActiveItem(it.key)
    setForm((f) => f && { ...f, items: [...f.items, it] })
  }
  /** 「全部采用」: 整张明细替换成表格里的这些行(和系统建议的"采用这 N 行"一样的效果)。 */
  const useAll = (rows: ModelItemRow[]) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    setRtab('items')
    setForm((f) => f && { ...f, items: rows.filter((r) => r.description.trim() || r.amount.trim() || r.unit_price.trim()).map(toFormItem) })
  }
  /** 点图上的文字框: 商家/日期字段取文字,金额字段取里面的数字(和点右边原始文字里的数字一样)。 */
  const pickBox = (text: string) => {
    if (readOnly) return toast(t('form.ocr.pickField'), 'info')
    if (activeItem === null && active === 'merchant') return set('merchant', text.replace(/\s+/g, ' ').trim())
    if (activeItem === null && active === 'date') {
      const iso = dateFromText(text)
      return iso ? set('date', iso) : toast(t('form.box.noDate'), 'info')
    }
    const num = text.match(/-?\d[\d.,]*\d|\d/)
    if (!num) return toast(t('form.box.noNumber'), 'info')
    pickNumber(num[0])
  }
  const addRow = () => {
    const it = newItem({ qty: 1 })
    focusItem.current = it.key
    setForm((f) => f && { ...f, items: [...f.items, it] })
  }
  /** 回车: 商品名 → 数量 → 金额 → 下一行的商品名(最后一行就新开一行)。不用 Tab 以外的快捷键,和全局的 J/K 不冲突(在输入框里本来就不生效)。 */
  const rowEnter = (e: React.KeyboardEvent<HTMLInputElement>, idx: number, col: 'name' | 'qty' | 'uom' | 'unit' | 'discount' | 'tax' | 'price') => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    const rows = form.items
    if (col === 'name') document.getElementById(`it_${rows[idx]!.key}_qty`)?.focus()
    else if (col === 'qty') document.getElementById(`it_${rows[idx]!.key}_uom`)?.focus()
    else if (col === 'uom') document.getElementById(`it_${rows[idx]!.key}_unit`)?.focus()
    else if (col === 'unit') document.getElementById(`it_${rows[idx]!.key}_discount`)?.focus()
    else if (col === 'discount') document.getElementById(`it_${rows[idx]!.key}_tax`)?.focus()
    else if (col === 'tax') document.getElementById(`it_${rows[idx]!.key}_price`)?.focus()
    else if (idx + 1 < rows.length) document.getElementById(`it_${rows[idx + 1]!.key}_name`)?.focus()
    else addRow()
  }

  const errs = formErrors(form)
  const showErr = (id: string) => attempted || touched.has(id)
  const touch = (id: string) => setTouched((s) => (s.has(id) ? s : new Set(s).add(id)))
  const fieldBox = (k: ScalarKey, o: { wide?: string; cls?: string; list?: string; ph?: string; numeric?: boolean; date?: boolean } = {}) => {
    const fk = k as FieldKey
    const needs = !readOnly && requireAck && view.needAck.includes(fk) // 这个字段被标出来,要求审核员确认
    const edited = view.changed.has(fk)
    const checked = acked.has(fk)
    const handled = needs && (edited || checked) // 点过「已核对」或者改过值,都算看过了
    const flagged = !!view.flags[fk] && !readOnly && !handled
    // 独立读取的佐证: 有整页转写时,金额在转写里也出现了、日期/商家与转写一致,就标一个小对勾(没有转写、或者值被审核员改过就不标)。
    // 它只说明"不是凭空编的",不代表一定对;无小数的币种(日元等)交叉验证本来就跳过,所以也不标。
    const hasText = d.ocrText.startsWith('[full text]')
    const amtN = (['total', 'subtotal', 'tax', 'paid', 'change'] as string[]).includes(k) ? parseNum(form[k]) : null
    const clean = !view.flags[fk] // 只要被任何提示标记过(比如日期的日/月顺序有歧义),就不显示「一致」的小标记:两次读到的字面相同,解决不了歧义,不能让人放心
    const inText = !readOnly && hasText && !edited && clean && amtN !== null && !Number.isNaN(amtN) && amtN !== 0 && roundUnit(canon(form).currency) < 1 && !d.reasons.includes(`${k}_not_in_text`)
    const agrees = !readOnly && hasText && !edited && clean && (k === 'date' || k === 'merchant') && d.verifier.agree?.[k] === true
    const numErr = o.numeric && !readOnly && showErr(k) ? errs.fields[k as keyof typeof errs.fields] : undefined
    const dateBad = o.date && !readOnly && showErr('date') && form.date.trim() !== '' && !isIsoDate(form.date.trim())
    const required = !readOnly && attempted && ((k === 'merchant' && !form.merchant.trim()) || (k === 'total' && (parseNum(form.total) === null || Number.isNaN(parseNum(form.total)))))
    const err: string | undefined = numErr ?? (dateBad ? 'date' : required ? 'required' : undefined)
    const input = (
      <input
        id={`f_${k}`} value={form[k]} type="text" list={o.list} placeholder={o.ph} inputMode={o.numeric ? 'decimal' : undefined} readOnly={readOnly}
        className={`${view.changed.has(k as FieldKey) ? 'changed' : ''} ${err ? 'invalid' : ''}`} aria-invalid={err ? true : undefined} onChange={(e) => set(k, e.target.value)}
        onFocus={() => { if (o.numeric || k === 'merchant' || k === 'date') { setActive(k); setActiveItem(null) } }} onBlur={() => {
          if (o.numeric) { touch(k); normalize(k) }
          if (o.date) {
            touch('date')
            const p = parseLooseDate(form.date)
            if (p && p.iso !== form.date.trim()) { set('date', p.iso); setDateNote(p.assumed ? t('form.date.assumed', { v: p.iso }) : '') } // 14/02/2018 → 2018-02-14
            else if (!p) { const named = dateFromText(form.date); if (named && named !== form.date.trim()) { set('date', named); setDateNote('') } } // 手打 05 Jan 2017 也自动改成 2017-01-05
          }
        }}
      />
    )
    return (
      <div className={`f ${o.wide ?? ''} ${o.cls ?? ''} ${flagged ? 'flag' : ''}`}>
        <label htmlFor={`f_${k}`}>{fl(k as FieldKey)}{k === 'total' ? ` ${t('form.totalHint')}` : ''}{flagged && <span className="flagmark" title={t('form.check')}>⚠</span>}{handled && (checked && !edited ? <button type="button" className="ackdone" title={t('ack.undo')} onClick={() => unack(fk)}>✓ {t('ack.done')}</button> : <span className="ackdone">✓ {t('ack.edited')}</span>)}{inText && <span className="srcok" title={t('src.inTextTip')}>✓ {t('src.inText')}</span>}{agrees && <span className="srcok" title={t('src.agreeTip')}>✓ {t('src.agree')}</span>}{needs && !handled && <button type="button" className="ackbtn mini" title={t('ack.btn')} aria-label={t('ack.btn')} onClick={() => ack(fk)}>✓</button>}</label>
        {o.date ? (
          // 日期用文本框显示 年-月-日(各地区的原生日期框日/月顺序不同,容易看错),再配一个日历按钮方便点选
          <div className="datebox">
            {input}
            <button type="button" className="calbtn" disabled={readOnly} title={t('form.pickDate')} aria-label={t('form.pickDate')} onClick={() => dateRef.current?.showPicker?.()}>📅</button>
            <input ref={dateRef} type="date" className="datehidden" tabIndex={-1} aria-hidden="true" value={/^\d{4}-\d{2}-\d{2}$/.test(form.date) ? form.date : ''} onChange={(e) => set('date', e.target.value)} />
          </div>
        ) : input}
        {err && <div className="hint err" role="alert">{t(`form.err.${err}` as Key)}</div>}
        {o.date && !err && dateNote && <div className="hint info">{dateNote}</div>}
        <div className="fextra">
          {(view.notes[k as FieldKey] ?? []).map((x) => <div key={x} className="hint info">{x}</div>)}
          {!readOnly && <Sugs list={view.sugs[k as FieldKey]} onPick={(fn) => setForm((f) => f && fn(f))} />}
        </div>
      </div>
    )
  }

  // 原始文字里和表单当前金额相同的数字高亮出来,一眼能看出每个金额是从哪一行来的
  const hitCents = new Set<number>()
  for (const k of ['total', 'subtotal', 'tax', 'paid', 'change', 'discount', 'service_charge', 'rounding'] as const) {
    const n = parseNum(form[k])
    if (n !== null && !Number.isNaN(n) && n !== 0) hitCents.add(Math.round(Math.abs(n) * 100))
  }
  const failing = recon.lines.filter((l) => l.status === 'fail')
  const duplicates = d.duplicates
  const dupText = t('review.dup', { files: ' ' }).split(' ') // 把链接插在句子中间

  /** 「全部商品税率」: 把同一个税率一次填进所有行(onlyEmpty = 只填还没填的行)。税率认 6、6%、SR 6% 这几种写法。 */
  const applyTaxAll = (raw: string, onlyEmpty: boolean) => {
    const r = rateOf(raw)
    if (r === null) return toast(t('form.err.format'), 'err')
    setForm((f) => f && { ...f, items: f.items.map((x) => (onlyEmpty && x.taxRate.trim() !== '' ? x : { ...x, taxRate: String(r) })) })
  }
  const detectedRate = (() => { const c = recon.result.checks.find((x) => x.id === 'tax_rate' && x.status === 'ok'); return c ? Number(c.params.rate) : null })() // 由税额反推出来的常见税率
  /** 商品明细编辑区。放在中间栏、原图正下方: 对着图改,不用在右边长表单里往下翻。逻辑和以前完全一样,只是换了位置。 */
  const itemsBlock = (
    <>
          <div className="h3">
            {t('form.items')}
            {!readOnly && <button className="btn sm" onClick={addRow}>{t('form.addRow')}</button>}
            <span className="muted">{t('form.itemsCount', { n: form.items.length })}</span>
          </div>
          {!readOnly && (
            <div className="sugs" style={{ marginBottom: 6 }}>
              <Sugs list={view.sugs.items} onPick={(fn) => setForm((f) => f && fn(f))} />
              {(view.notes.items ?? []).map((x) => <span key={x} className="hint info">{x}</span>)}
              {(view.flags.items ?? []).map((x) => <span key={x} className="hint">{x}</span>)}
              {requireAck && view.needAck.includes('items') && (acked.has('items') || view.changed.has('items')
                ? <span className="ackdone">✓ {view.changed.has('items') && !acked.has('items') ? t('ack.edited') : t('ack.done')}</span>
                : <button type="button" className="ackbtn" onClick={() => ack('items')}>✓ {t('ack.btn')}</button>)}
            </div>
          )}
          {!readOnly && form.items.length > 0 && (
            <div className="taxall" role="group" aria-label={t('form.taxall')}>
              <span className="lbl" title={t('form.item.taxTip')}>{t('form.taxall')}</span>
              <input className="i-taxall" inputMode="decimal" value={bulkTax} placeholder="6" onChange={(e) => setBulkTax(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyTaxAll(bulkTax, false) } }} />
              <span className="pct">%</span>
              <button type="button" className="btn sm" onClick={() => applyTaxAll(bulkTax, false)}>{t('form.taxall.all')}</button>
              <button type="button" className="btn sm" onClick={() => applyTaxAll(bulkTax, true)}>{t('form.taxall.empty')}</button>
              {detectedRate !== null && detectedRate > 0 && <button type="button" className="chip" onClick={() => applyTaxAll(String(detectedRate), false)}>{t('form.taxall.detected', { rate: detectedRate })}</button>}
              <button type="button" className="chip" onClick={() => applyTaxAll('0', false)}>{t('form.taxall.zero')}</button>
              <button type="button" className="chip" onClick={() => setForm((f) => f && { ...f, items: f.items.map((x) => ({ ...x, taxRate: '' })) })}>{t('form.taxall.clear')}</button>
            </div>
          )}
          {form.items.length === 0 && <p className="muted small itemsempty">{readOnly ? t('form.items.none') : t('form.items.empty')}</p>}
          {form.items.length > 0 && (
            <div className="itemswrap">
            <table className="items">
              <colgroup><col className="c-n" /><col className="c-qty" /><col className="c-uom" /><col className="c-unit" /><col className="c-disc" /><col className="c-tax" /><col className="c-price" /></colgroup>
              <thead><tr><th className="rown">#</th><th className="num">{t('form.item.qty')}</th><th>{t('form.item.uom')}</th><th className="num" title={t('form.item.unitTip')}>{t('form.item.unit')}</th><th className="num" title={t('form.item.discTip')}>{t('form.item.disc')}</th><th className="num" title={t('form.item.taxTip')}>{t('form.item.tax')}</th><th className="num" title={t('form.item.priceTip')}>{t('form.item.price')}</th></tr></thead>
              <tbody>
                {form.items.map((it, idx) => {
                  // 金额 = 数量 × 单价 − 折扣: 改了数量 / 单价 / 折扣就重新算金额(金额不是读出来的,是算出来的)
                  const upd = (patch: Partial<typeof it>) => setForm((f) => f && { ...f, items: f.items.map((x) => (x.key === it.key ? ('qty' in patch || 'unit' in patch || 'discount' in patch ? withAmount({ ...x, ...patch }) : { ...x, ...patch }) : x)) })
                  const suspect = recon.suspectKeys.has(it.key)
                  const ie = errs.items[it.key] ?? {}
                  const noAmount = !readOnly && it.name.trim() !== '' && it.price.trim() === '' // 有名字没金额: 最常见的漏读,标出来
                  const pickRow = () => { setActiveItem(it.key); setActive(null) }
                  const numCell = (col: 'qty' | 'discount', cls: string) => {
                    const e = ie[col]; const id = `${col === 'qty' ? 'q' : 'd'}${it.key}`
                    return (
                      <td className="num"><input id={`it_${it.key}_${col}`} className={`${cls} ${e && showErr(id) ? 'invalid' : ''}`} value={it[col]} inputMode="decimal" readOnly={readOnly} title={e && showErr(id) ? t(`form.err.${e}` as Key) : undefined}
                        onFocus={pickRow} onChange={(ev) => upd({ [col]: ev.target.value })} onBlur={() => { touch(id); if (col === 'discount') { const n = parseNum(it.discount); if (n !== null && !Number.isNaN(n)) upd({ discount: n.toFixed(2) }) } }} onKeyDown={(ev) => rowEnter(ev, idx, col)} /></td>
                    )
                  }
                  const cls = `${suspect ? 'suspect' : ''} ${activeItem === it.key ? 'picking' : ''}`
                  return (
                    <Fragment key={it.key}>
                    <tr className={`namerow ${cls}`} title={suspect ? t('form.item.suspect') : undefined}>
                      <td className="rown" rowSpan={2}>{idx + 1}</td>
                      <td colSpan={6}>
                        <div className="namecell">
                          <input id={`it_${it.key}_name`} value={it.name} placeholder={t('form.item.namePh')} readOnly={readOnly} onFocus={pickRow} onChange={(e) => upd({ name: e.target.value })} onKeyDown={(e) => rowEnter(e, idx, 'name')} />
                          {!readOnly && <button className="del" title={t('form.item.delete')} aria-label={t('form.item.delete')} onClick={() => setForm((f) => f && { ...f, items: f.items.filter((x) => x.key !== it.key) })}>✕</button>}
                        </div>
                      </td>
                    </tr>
                    <tr className={`detrow ${cls}`}>
                      {numCell('qty', 'i-qty')}
                      <td><input id={`it_${it.key}_uom`} className="i-uom" value={it.uom} placeholder={readOnly ? undefined : t('form.item.uomPh')} readOnly={readOnly} maxLength={16} onFocus={pickRow} onChange={(e) => upd({ uom: e.target.value })} onKeyDown={(e) => rowEnter(e, idx, 'uom')} /></td>
                      <td className="num"><input id={`it_${it.key}_unit`} className="i-unit" value={it.unit} inputMode="decimal" readOnly={readOnly} title={t('form.item.unitTip')} onFocus={pickRow} onChange={(e) => upd({ unit: e.target.value })} onBlur={() => { const n = parseNum(it.unit); if (n !== null && !Number.isNaN(n)) upd({ unit: String(Math.round(n * 1000) / 1000) }) }} onKeyDown={(e) => rowEnter(e, idx, 'unit')} /></td>
                      {numCell('discount', 'i-disc')}
                      <td className="num"><input id={`it_${it.key}_tax`} className="i-tax" value={it.taxRate} inputMode="decimal" readOnly={readOnly} placeholder={readOnly ? undefined : t('form.item.taxPh')} onFocus={pickRow} onChange={(e) => upd({ taxRate: e.target.value })} onKeyDown={(e) => rowEnter(e, idx, 'tax')} /></td>
                      <td className="num"><input id={`it_${it.key}_price`} className={`i-price ${ie.price && showErr(`p${it.key}`) ? 'invalid' : ''} ${noAmount ? 'noamount' : ''} ${it.unit.trim() !== '' ? 'computed' : ''}`} value={it.price} inputMode="decimal" readOnly={readOnly || it.unit.trim() !== ''} title={it.unit.trim() !== '' ? t('form.item.priceTip') : undefined} placeholder={noAmount ? t('form.item.pricePh') : undefined}
                        onChange={(e) => upd({ price: e.target.value })} onKeyDown={(e) => rowEnter(e, idx, 'price')}
                        onFocus={pickRow}
                        onBlur={() => { touch(`p${it.key}`); const n = parseNum(it.price); if (n !== null && !Number.isNaN(n)) upd({ price: n.toFixed(2) }) }} /></td>
                    </tr>
                    </Fragment>
                  )
                })}
              </tbody>
              {!readOnly && <tfoot><tr><td colSpan={7}><button type="button" className="addrow" onClick={addRow}>{t('form.addRow')}</button></td></tr></tfoot>}
            </table>
            </div>
          )}
          {form.items.length > 0 && (() => {
            // 按税率汇总: 每个税率下商品金额合计,和按含税/不含税算出的税额。只看填了税率的行;含税还是不含税用对账引擎认定的(认不出就只列金额)。
            const groups = new Map<number, number>()
            for (const x of form.items) {
              const r = rateOf(x.taxRate), a = parseNum(x.price)
              if (r !== null && a !== null && !Number.isNaN(a)) groups.set(r, Math.round(((groups.get(r) ?? 0) + a) * 100) / 100)
            }
            if (!groups.size) return null
            const mode = recon.result.mode
            const taxOf = (amt: number, r: number) => (mode === 'inclusive' ? (amt * r) / (100 + r) : mode === 'exclusive' ? (amt * r) / 100 : null)
            const rows = [...groups.entries()].sort((a, b) => b[0] - a[0])
            const taxSum = mode === 'unknown' ? null : Math.round(rows.reduce((s, [r, a]) => s + (taxOf(a, r) ?? 0), 0) * 100) / 100
            return (
              <table className="ratesum" aria-label={t('form.ratesum')}>
                <thead><tr><th>{t('form.ratesum.rate')}</th><th className="num">{t('form.ratesum.amount')}</th><th className="num">{t('form.ratesum.tax')}</th></tr></thead>
                <tbody>
                  {rows.map(([r, a]) => { const tx = taxOf(a, r); return <tr key={r}><td>{r}%</td><td className="num">{a.toFixed(2)}</td><td className="num">{tx === null ? '—' : tx.toFixed(2)}</td></tr> })}
                </tbody>
                {taxSum !== null && rows.length > 1 && <tfoot><tr><td>{t('form.ratesum.total')}</td><td /><td className="num">{taxSum.toFixed(2)}</td></tr></tfoot>}
              </table>
            )
          })()}
          {(() => {
            // 表格下面: 再放一个"添加一行"(行多时不用滚回表头) + 明细合计,和小计对比;有几行没金额也直接说
            // 金额列可能是「行小计」也可能是「单价」:两种合计都算,和小计吻合的那种为准(与对账引擎一致)。
            const rows = form.items.map((x) => ({ p: parseNum(x.price), q: parseNum(x.qty) })).filter((r): r is { p: number; q: number | null } => r.p !== null && !Number.isNaN(r.p))
            const r2 = (n: number) => Math.round(n * 100) / 100
            const sumL = r2(rows.reduce((a, r) => a + r.p, 0))
            const sumU = r2(rows.reduce((a, r) => a + r.p * (r.q !== null && !Number.isNaN(r.q) && r.q > 0 ? r.q : 1), 0))
            const sub = parseNum(form.subtotal)
            const hasSub = sub !== null && !Number.isNaN(sub)
            const near = (s: number) => hasSub && Math.abs(s - sub!) <= Math.max(0.06, Math.abs(sub!) * 0.005)
            const byQty = sumU !== sumL && !near(sumL) && near(sumU)
            let sum = byQty ? sumU : sumL
            let diff = hasSub ? Math.round((sum - sub!) * 100) / 100 : 0
            let refLabel = 'subtotal'
            let refVal = sub
            // 以对账引擎的结论为准(它会试「单价×数量 / 行小计」和「商品价含税」几种读法),下面的数字和对账提示才会一致
            const chk = recon.result.checks.find((c) => c.id === 'items_vs_subtotal')
            if (chk) { sum = Number(chk.params.itemsSum); refVal = Number(chk.params.ref); refLabel = String(chk.params.refLabel); diff = Math.round((sum - refVal) * 100) / 100 }
            const hasRef = hasSub || !!chk
            let match = hasSub && Math.abs(diff) <= Math.max(0.06, Math.abs(sub!) * 0.005)
            if (chk) match = chk.status === 'ok'
            const missing = form.items.filter((x) => x.name.trim() !== '' && x.price.trim() === '').length
            if (readOnly && !form.items.length) return null
            return (
              <div className="itemsfoot">
                {form.items.length > 0 && (
                  <span className={`itemssum ${hasRef ? (match ? 'ok' : 'off') : ''}`} title={t('form.items.sumTip')}>
                    {t('form.items.sum', { sum: sum.toFixed(2) })}{(byQty || (chk && sum !== sumL)) && ` (${t('form.items.byQty')})`}
                    {hasRef && (match ? ` ✓ ${refLabel === 'subtotal' ? t('form.items.matchSub') : t('form.items.matchRef', { ref: t(`ref.${refLabel}` as Key) })}` : ` · ${t('form.items.vsSub', { sub: refVal!.toFixed(2), diff: `${diff > 0 ? '+' : ''}${diff.toFixed(2)}` })}`)}
                  </span>
                )}
                {missing > 0 && <span className="itemsmissing">{t('form.items.missing', { n: missing })}</span>}
              </div>
            )
          })()}
    </>
  )

  return (
    <div className="rv" ref={rvRef} style={{ ['--cols' as string]: `minmax(0, ${colPct}fr) 14px minmax(0, ${100 - colPct}fr)` }}>
      <div className={`leftcol ${qOpen ? '' : 'side'}`} ref={leftRef} style={{ ['--imgpct' as string]: `${imgPct}%` }}>
        <ImageViewer src={d.hasImage ? api.imageUrl(d.id, d.importedAt) : null} openHref={d.hasImage ? api.imageUrl(d.id, d.importedAt) : undefined} boxes={d.boxes} onPick={pickBox} />
        <div className="splitter" role="separator" aria-orientation={qOpen ? 'horizontal' : 'vertical'} aria-label={t('split.tip')} title={t('split.tip')} tabIndex={0}
          onPointerDown={startSplit} onDoubleClick={() => { setImgPct(imgDef); writeLS(imgKey, String(imgDef)) }}
          onKeyDown={(e) => { const [less, more] = qOpen ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (e.key === less) { e.preventDefault(); nudgeSplit(-3) } else if (e.key === more) { e.preventDefault(); nudgeSplit(3) } }} />
        <OcrPanel text={d.ocrText} hits={hitCents} showHit={hitCents.size > 0 && !!d.ocrText} onPick={pickNumber} onPickText={pickText} onUseRow={useRow} onUseAll={useAll} onUseField={pickField} onPickCell={pickItemCell} pickTarget={pickTarget} onClearTarget={() => setActive(null)} form={form} readOnly={readOnly} />
      </div>

      <div className="colsplit" role="separator" aria-orientation="vertical" aria-label={t('colsplit.tip')} title={t('colsplit.tip')} tabIndex={0}
        onPointerDown={startColSplit} onDoubleClick={() => { setColPct(colDef); writeLS(colKey, String(colDef)) }}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeCol(-2) } else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeCol(2) } }} />

      <section className="formpane">
        <div className="rvhead">
          <h2>{d.file}</h2>
          <StatusBadge status={d.pipelineStatus} />
          {recon.result.mode !== 'unknown' && <span className="pill mode" title={t('review.mode')}>{t(`mode.${recon.result.mode}` as Key)}</span>}
          <span className="grow" />
          {pos.index >= 0 && (
            <div className="pager-mini" role="navigation">
              <button className="btn sm" disabled={!pos.prevId} title={`${t('review.prev')} (Alt+←)`} onClick={() => pos.prevId && go(`/review/${pos.prevId}`)}>‹</button>
              <span className="muted">{t('review.position', { i: pos.index + 1, n: pos.total })}</span>
              <button className="btn sm" disabled={!pos.nextId} title={`${t('review.next')} (Alt+→)`} onClick={() => pos.nextId && go(`/review/${pos.nextId}`)}>›</button>
            </div>
          )}
        </div>

        <div className="rvbody">
          {view.changed.size > 0 && <div className="muted changedline">{t('review.changed', { fields: [...view.changed].map(fl).join(', ') })}</div>}
          {!pending && (
            <div className={`statebar ${d.state}`}>
              {d.state === 'approved' ? t('review.approvedBy') : t('review.rejectedBy')} · {d.reviewer} · {stamp(d.reviewedAt)}{d.note ? ` · ${t('review.reasonIs', { note: d.note })}` : ''}
              <button className="btn" onClick={() => submit('reopen')}>{t('review.reopen')}</button>
            </div>
          )}
          {pending && theirs && (
            <div className="alert warn conflict"><span>⚠️</span><span className="grow">{t('conflict.banner')}</span>
              <button className="btn sm" onClick={() => { setForm(theirs); setTheirs(null) }}>{t('conflict.useTheirs')}</button>
              <button className="btn sm ghost" onClick={() => setTheirs(null)}>{t('common.gotIt')}</button></div>
          )}
          {pending && (
            <div className="alerts">
              {duplicates.length > 0 && (
                <div className="alert warn"><span>⚠️</span><span>{dupText[0]}{duplicates.map((x) => (
                  <Fragment key={x.id}><Link className="mono" to={`/data?state=all&open=${x.id}`}>{t('review.dup.state', { file: x.file, state: t(`state.${x.state}` as Key) })}</Link>{' '}</Fragment>
                ))}{dupText[1]}</span></div>
              )}
              {view.alerts.length ? (
                <div className={`alertbar ${view.alerts.some((a) => a.level === 'warn') ? 'warn' : 'info'}`}>
                  <div className="alertsum">
                    <span>{view.alerts.some((a) => a.level === 'warn') ? '⚠️' : 'ℹ️'}</span>
                    <span className="grow">{t('alerts.summary', { n: view.alerts.length })}</span>
                    <button type="button" className="linkbtn" aria-expanded={alertsOpen} onClick={() => setAlertsOpen((o) => !o)}>{alertsOpen ? t('alerts.hide') : t('alerts.show')}</button>
                  </div>
                  <div className="alertchips">
                    {[...new Set(view.alerts.flatMap((a) => a.fields))].map((f) => {
                      const settled = requireAck && (acked.has(f) || view.changed.has(f)) // 这个字段已经核对或改过
                      return <button type="button" key={f} className={`achip ${settled ? 'settled' : ''}`} onClick={() => locate(f)}>{settled ? '✓ ' : ''}{fl(f)}</button>
                    })}
                  </div>
                  {alertsOpen && (
                    <ul className="alertlist">
                      {view.alerts.map((a) => (
                        <li key={a.text} className={a.level}>
                          <span className="grow">{a.text}</span>
                          {a.fields.length > 0 && <button type="button" className="linkbtn" onClick={() => locate(a.fields[0]!)}>→ {a.fields.map(fl).join(' / ')}</button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : duplicates.length || view.suppressed ? null : <div className="alert ok"><span>✅</span><span>{t('review.allClear')}</span></div>}
            </div>
          )}

          <datalist id="merchants">{meta.data?.merchants.map((m) => <option key={m} value={m} />)}</datalist>
          <datalist id="currencies">{[...new Set([...(meta.data?.currencies ?? []), ...CURRENCIES])].map((c) => <option key={c} value={c} />)}</datalist>

          <div className="rtabs" role="tablist">
            <button type="button" role="tab" data-rtab="details" aria-selected={rtab === 'details'} className={rtab === 'details' ? 'on' : ''} onClick={() => setRtab('details')}>{t('form.tab.details')} {pendingAck.some((f) => (['merchant', 'date']).includes(f)) && <span className="tabdot" title={t('ack.pendingTip')}>●</span>}</button>
            <button type="button" role="tab" data-rtab="amounts" aria-selected={rtab === 'amounts'} className={rtab === 'amounts' ? 'on' : ''} onClick={() => setRtab('amounts')}>{t('form.tab.amounts')} {pendingAck.some((f) => (['currency', 'subtotal', 'discount', 'service_charge', 'tax', 'tip', 'fees', 'rounding', 'total', 'paid', 'change']).includes(f)) && <span className="tabdot" title={t('ack.pendingTip')}>●</span>}</button>
            <button type="button" role="tab" data-rtab="items" aria-selected={rtab === 'items'} className={rtab === 'items' ? 'on' : ''} onClick={() => setRtab('items')}>{t('form.tab.items')} <span className="tabcount">{form.items.length}</span> {pendingAck.includes('items') && <span className="tabdot" title={t('ack.pendingTip')}>●</span>}</button>
          </div>

          {/* 第 1 页: 商家详情(店名、日期;以后还会放地址、发票号、GST 号) */}
          <div data-rpanel="details" hidden={rtab !== 'details'}>
            <div className="grid">
              {fieldBox('merchant', { wide: 'w3', list: 'merchants' })}
              {fieldBox('date', { date: true, ph: t('form.datePh') })}
            </div>
          </div>

          {/* 第 2 页: 金额与明细(币种、各项金额、商品明细、对账检查) */}
          <div data-rpanel="amounts" hidden={rtab !== 'amounts'}>
            <div className="grid">
              {fieldBox('currency', { cls: 'half', list: 'currencies' })}
              {fieldBox('subtotal', { numeric: true })}{fieldBox('discount', { numeric: true })}{fieldBox('service_charge', { numeric: true })}
              {fieldBox('tax', { numeric: true })}{fieldBox('tip', { numeric: true })}{fieldBox('fees', { numeric: true })}
              {fieldBox('rounding', { numeric: true })}{fieldBox('total', { cls: 'total', wide: 'w4', numeric: true })}
              {fieldBox('paid', { numeric: true })}{fieldBox('change', { numeric: true })}
            </div>

            <div className="checks">{recon.lines.filter((c) => !ITEM_CHECKS.has(c.id)).map((c) => (
              <div key={c.id + c.text} className={`check ${c.status}`}>{c.text}{c.hint && <div className="check-hint">💡 {c.hint}</div>}</div>
            ))}</div>
          </div>

          {/* 第 3 页: 商品明细(每一行的各项、全部行的税率、和明细有关的对账提示) */}
          <div data-rpanel="items" hidden={rtab !== 'items'}>
            {itemsBlock}

            <div className="checks">{recon.lines.filter((c) => ITEM_CHECKS.has(c.id)).map((c) => (
              <div key={c.id + c.text} className={`check ${c.status}`}>{c.text}{c.hint && <div className="check-hint">💡 {c.hint}</div>}</div>
            ))}</div>
          </div>

          <div className="f noteBox">
            <label htmlFor="f_note">{t('form.note')} <span className="muted">{t('common.optional')}</span></label>
            <textarea id="f_note" rows={2} value={form.note} readOnly={readOnly} placeholder={t('form.notePh')} onChange={(e) => setForm((f) => f && { ...f, note: e.target.value })} />
          </div>

          <SecondPanel d={d} />
          {(d.timing || d.batch || view.singleSource || d.verifier.jev) && (
            // 这张是谁识别的、花了多久: 批次名里带识别服务名;耗时按阶段列出(识别服务没有提供就不显示)
            <p className="muted small scaninfo">
              {t('review.scanInfo')}: {d.batch ?? '—'}
              {d.timing ? ` · ${timingText(d.timing, t)}` : ''}
              {d.verifier.jev ? ` · ${d.verifier.jev.score !== null ? t('review.jev', { score: d.verifier.jev.score.toFixed(2), th: d.verifier.jev.threshold }) : t('review.jevNone', { verdict: d.verifier.jev.verdict })}` : ''}
              {view.singleSource ? ` · ${t('review.singleSource')}` : ''}
            </p>
          )}
          <details className="more">
            <summary>{t('form.history', { n: d.audit.length })}</summary>
            <div className="hist">{d.audit.map((a) => (
              <div key={a.id}>{stamp(a.ts)} · {isSystemUser(a.user) ? t('act.system') : a.user} · {t(`action.${a.action}` as Key)}
                {a.detail.changed?.length ? ` (${t('drawer.changedPrefix')}${a.detail.changed.map((k) => fl(k as FieldKey)).join(', ')})` : ''}{a.detail.note ? ` · ${a.detail.note}` : ''}</div>
            ))}</div>
          </details>
        </div>

        {pending && (
          <div className="actions">
            <button className="btn danger" onClick={() => { setRejectNote(''); setRejectOpen(true) }}>{t('form.reject')}</button>
            <button className="btn" title={t('form.reset.tip')} aria-label={t('form.reset.tip')} onClick={() => confirm(t('form.reset.confirm')) && setForm(toForm(d.machine))}>↩</button>
            <span className="grow" />
            {pendingAck.length > 0 && <button type="button" className="ackhint" title={t('ack.pendingTip')} onClick={() => locate(pendingAck[0]!)}>⚠ {t('ack.pending', { n: pendingAck.length })}</button>}
            {dirty && <span className="dirty">{t('review.dirty')}</span>}
            {pos.nextId && <button className="btn" onClick={() => go(`/review/${pos.nextId}`)}>{t('review.skip')}</button>}
            <button className="btn" disabled={act.isPending || !dirty} title="Ctrl+S" onClick={() => submit('save')}>{t('form.save')}</button>
            <button className="btn primary big" disabled={act.isPending} title="Ctrl+Enter" onClick={requestApprove}>{t('form.approve')}</button>
          </div>
        )}
      </section>

      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} title={t('reject.title')}
        footer={<><button className="btn" onClick={() => setRejectOpen(false)}>{t('common.cancel')}</button>
          <button className="btn danger" onClick={() => { if (!rejectNote.trim()) return toast(t('reject.needNote'), 'err'); setRejectOpen(false); submit('reject', rejectNote) }}>{t('reject.confirm')}</button></>}>
        <p className="muted">{t('reject.hint')}</p>
        <div className="chips">{REJECT_QUICK.map((k) => <button key={k} className="chip" onClick={() => setRejectNote(t(k))}>{t(k)}</button>)}</div>
        <textarea rows={3} value={rejectNote} placeholder={t('reject.ph')} onChange={(e) => setRejectNote(e.target.value)} />
      </Dialog>

      <Dialog open={nameOpen} onClose={() => setNameOpen(false)} title={t('name.title')}
        footer={<><button className="btn" onClick={() => setNameOpen(false)}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={!nameText.trim()} onClick={saveName}>{t('name.save')}</button></>}>
        <p>{t('name.body')}</p>
        <input className="namefield" autoFocus value={nameText} maxLength={40} placeholder={t('app.reviewerPh')} aria-label={t('app.reviewer')}
          onChange={(e) => setNameText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && nameText.trim()) saveName() }} />
      </Dialog>

      <Dialog open={ackOpen} onClose={() => setAckOpen(false)} title={t('ack.title', { n: pendingAck.length })}
        footer={<>
          <button className="btn" disabled={!form.note.trim()} title={form.note.trim() ? undefined : t('ack.needNote')}
            onClick={() => { setAckOpen(false); setAcked((x) => new Set([...x, ...pendingAck])); if (recon.result.hasFail) setWarnOpen(true); else submit('approve') }}>{t('ack.anyway')}</button>
          <button className="btn primary" autoFocus onClick={() => { setAckOpen(false); locate(pendingAck[0]!) }}>{t('ack.goCheck')}</button>
        </>}>
        <p>{t('ack.body')}</p>
        <ul className="acklist">{pendingAck.map((f) => <li key={f}><b>{fl(f)}</b> — {view.flags[f]?.[0]}</li>)}</ul>
        <p className="muted small">{t('ack.noteLabel')}</p>
        <textarea rows={2} value={form.note} placeholder={t('form.notePh')} onChange={(e) => setForm((f) => f && { ...f, note: e.target.value })} />
      </Dialog>

      <Dialog open={warnOpen} onClose={() => setWarnOpen(false)} title={t('warn.title')}
        footer={<><button className="btn" onClick={() => setWarnOpen(false)}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={() => { setWarnOpen(false); submit('approve') }}>{t('warn.confirm')}</button></>}>
        <p>{t('warn.body')}</p>
        <div className="checks">{failing.map((c) => <div key={c.id} className="check fail">{c.text}{c.hint && <div className="check-hint">💡 {c.hint}</div>}</div>)}</div>
        <p className="muted small">{t('warn.noteHint')}</p>
        <textarea rows={2} value={form.note} placeholder={t('form.notePh')} onChange={(e) => setForm((f) => f && { ...f, note: e.target.value })} />
      </Dialog>

      <Dialog open={blocker.state === 'blocked'} onClose={() => blocker.reset?.()} title={t('leave.title')}
        footer={<><button className="btn" onClick={() => blocker.reset?.()}>{t('leave.stay')}</button><button className="btn danger" onClick={() => blocker.proceed?.()}>{t('leave.go')}</button></>}>
        <p>{t('leave.body')}</p>
      </Dialog>
    </div>
  )
}

function Sugs({ list, onPick }: { list?: Sug[]; onPick: (fn: (f: FormState) => FormState) => void }) {
  const { t } = useI18n()
  if (!list?.length) return null
  return <div className="sugs">{list.map((s) => <button key={s.label} type="button" className="sug" onClick={() => onPick(s.apply)}>{s.label} <b>{t('common.apply')}</b></button>)}</div>
}

/** OCR 原文:里面的数字可以点,直接填进当前选中的金额格子(省得手动抄)。 */
/** 各阶段耗时(秒)的一句话: "核心字段 3.1s · 附加字段 2s · 商品明细 4.8s → 总耗时 12.4s"。只显示有的阶段,未知的阶段名原样显示。 */
function timingText(tm: Record<string, number>, t: T): string {
  const known = ['core', 'extra', 'items', 'text']
  const label = (k: string) => { const key = `timing.${k}` as Key; const s = t(key); return s === key ? k : s }
  const parts = [...known.filter((k) => typeof tm[k] === 'number'), ...Object.keys(tm).filter((k) => !known.includes(k) && k !== 'total' && typeof tm[k] === 'number')]
    .map((k) => `${label(k)} ${tm[k]}s`)
  return parts.join(' · ') + (typeof tm.total === 'number' ? `${parts.length ? ' → ' : ''}${label('total')} ${tm.total}s` : '')
}

/** 这个数字(带两位小数的)是不是和表单里某个金额相同。整数(数量、百分比)不高亮,免得到处都是。 */
function isHit(token: string, hits: ReadonlySet<number>): boolean {
  if (!/[.,]\d{2}$/.test(token)) return false
  const n = parseNum(token)
  return n !== null && !Number.isNaN(n) && hits.has(Math.round(Math.abs(n) * 100))
}

/** 识别文字面板:在图片下方,跟图片一起固定,表单往下滚也一直在旁边;可折叠(记住选择)。窄屏默认折叠。 */
/** ocrText 由服务端拼成 `[full text]\n…\n\n[core fields]\n{…}` 的样子(见 server/lib/structured.ts 的 composeText)。
 *  这里按 `[标题]` 把它拆回一段一段;开头没有标题的文字归到 title=''。 */
function splitSections(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  for (const part of text.split(/\n\n(?=\[[a-z][a-z ()]*\]\n)/)) {
    const m = /^\[([a-z][a-z ()]*)\]\n([\s\S]*)$/.exec(part)
    out.push(m ? { title: m[1]!, body: m[2]! } : { title: '', body: part })
  }
  return out
}

/** "JSON 视图": 只留模型对各个提问的回答(去掉整页转写),能解析的排版成缩进的 JSON,解析不了的原样显示(正好看出模型输出坏在哪)。
 *  which: 两个读取模型都有结果时,只看其中一个('main' = 模型 1,'second' = 模型 2;第二个模型的段落标题以 `second ` 开头,这里去掉前缀);'all' = 全部。 */
function answersAsJson(text: string, which: 'all' | 'main' | 'second' = 'all'): string {
  const mine = (title: string) => (which === 'all' ? true : which === 'second' ? title.startsWith('second ') : !title.startsWith('second '))
  return splitSections(text).filter((s) => s.title && s.title !== 'full text' && mine(s.title)).map((s) => {
    let shown = s.body
    const i = s.body.indexOf('{'), j = s.body.lastIndexOf('}')
    if (i >= 0 && j > i) { try { shown = JSON.stringify(JSON.parse(s.body.slice(i, j + 1)), null, 2) } catch { shown = s.body + '\n⚠ JSON' } }
    return `// ${which === 'second' ? s.title.replace(/^second /, '') : s.title}\n${shown}`
  }).join('\n\n')
}

/** 表格里"模型读到的值": 单击 = 填进表单(右边选中的格子),双击 = 改这个值。
 *  不做成一直可编辑的输入框,是因为那样单击只会进入编辑,没法"点一下就套用"。 */
function PickCell({ value, onChange, onPick, num, disabled, always }: { value: string; onChange: (v: string) => void; onPick: (v: string) => void; num?: boolean; disabled?: boolean; always?: boolean }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  if (always) return <input className={num ? 'num' : ''} value={value} readOnly={disabled} onChange={(e) => onChange(e.target.value)} />
  if (editing) {
    return <input autoFocus className={num ? 'num' : ''} value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => setEditing(false)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false) }} />
  }
  return (
    <button type="button" className={`pickcell ${num ? 'num' : ''} ${value.trim() ? '' : 'empty'}`} disabled={disabled || !value.trim()} title={t('pick.tip')}
      onClick={() => onPick(value)} onDoubleClick={() => setEditing(true)}>{value.trim() ? value : '—'}</button>
  )
}

/** 模型 JSON 里的字段名 → 表单字段。以后新增的商家详情(地址、发票号、GST 号)加在这里就会自动出现在「字段表格」里。 */
const MODEL_FIELDS: { json: string; key: ScalarKey }[] = [
  { json: 'merchant_name', key: 'merchant' }, { json: 'date', key: 'date' }, { json: 'currency', key: 'currency' },
  { json: 'subtotal', key: 'subtotal' }, { json: 'discount_amount', key: 'discount' }, { json: 'service_charge_amount', key: 'service_charge' },
  { json: 'tax_amount', key: 'tax' }, { json: 'rounding_adjustment', key: 'rounding' }, { json: 'total', key: 'total' },
  { json: 'amount_paid', key: 'paid' }, { json: 'change_given', key: 'change' },
]

/** 从 ocrText 的几段 `[标题]\n{json}` 里读出字段 → 值。某一段 JSON 坏了就跳过(那些字段不显示)。 */
function parseFieldSections(text: string, titles: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const title of titles) {
    const body = new RegExp(`(?:^|\n)\\[${title}\\]\n([\\s\\S]*?)(?=\n\n\\[[a-z]|$)`).exec(text)?.[1] ?? ''
    const i = body.indexOf('{'), j = body.lastIndexOf('}')
    if (i < 0 || j <= i) continue
    try { for (const [k, v] of Object.entries(JSON.parse(body.slice(i, j + 1)) as Record<string, unknown>)) out[k] = v === null || v === '###' ? '' : String(v) } catch { /* 这一段 JSON 坏了 */ }
  }
  return out
}
/** 有没有第二个读取模型的结果(服务端配置了 MINICPM2_URL 才会有)。 */
const hasSecondReader = (text: string) => /(?:^|\n)\[second (?:core fields|extra fields|line items)\]\n/.test(text)

/** 两个读数是不是同一个值: 比较前先规整(2025-08-15 和 15/08/2025 和 15 Aug 2025、RM 和 MYR、8.5 和 8.50 都算一样)。 */
function sameValue(key: ScalarKey, a: string, b: string): boolean {
  const asNum = (x: string) => { const n = parseNum(x); return n === null || Number.isNaN(n) ? null : n }
  if (key === 'date') return dateFromText(a) !== null && dateFromText(a) === (dateFromText(b) ?? b.trim())
  if (key === 'currency') return (normCurrency(a) ?? a.trim().toUpperCase()) === (normCurrency(b) ?? b.trim().toUpperCase())
  if (key === 'merchant') return a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()
  return asNum(a) !== null && asNum(a) === asNum(b)
}

/** JSON 视图里的"字段表格": 每个字段一行 —— 模型 1 读到的 | (有的话)模型 2 读到的 | 表单现在的值。
 *  两个读数都是单击就填进表单(双击先改再点)。两个模型读得一样的行右边有绿边;不一样的行整行高亮,由审核员选。 */
function ModelFieldsTable({ text, form, readOnly, target, onClearTarget, onUseField }: { text: string; form: FormState; readOnly: boolean; target: ScalarKey | null; onClearTarget: () => void; onUseField: (k: ScalarKey, raw: string) => void }) {
  const { t, field: fl } = useI18n()
  const parsed = useMemo(() => parseFieldSections(text, ['core fields', 'extra fields']), [text])
  const parsed2 = useMemo(() => parseFieldSections(text, ['second core fields', 'second extra fields']), [text])
  const two = hasSecondReader(text)
  const [vals, setVals] = useState(parsed)
  const [vals2, setVals2] = useState(parsed2)
  useEffect(() => setVals(parsed), [parsed])
  useEffect(() => setVals2(parsed2), [parsed2])
  const rows = MODEL_FIELDS.filter((f) => f.json in parsed || (two && f.json in parsed2))
  if (!rows.length) return <p className="muted small">{t('fields.none')}</p>
  return (
    <>
      <p className="muted small">{two ? t('fields.hint2') : t('fields.hint')}</p>
      <p className="pickto">
        {target ? <>{t('pick.toSelected', { field: fl(target as FieldKey) })} <button type="button" className="linkbtn" onClick={onClearTarget}>{t('pick.clear')}</button></> : t('pick.toOwn')}
      </p>
      <table className="mitems">
        <thead><tr><th>{t('fields.col.field')}</th><th>{two ? t('m.model1') : t('fields.col.model')}</th>{two && <th>{t('m.model2')}</th>}<th>{t('fields.col.form')}</th>{!two && <th />}</tr></thead>
        <tbody>
          {rows.map((f) => {
            const v = vals[f.json] ?? ''
            const v2 = vals2[f.json] ?? ''
            const cur = form[f.key]
            const both = two && !!v.trim() && !!v2.trim()
            const agree = both && sameValue(f.key, v, v2)
            // 只有一个模型时: 和表单不一样就高亮;两个模型时: 两个读数不一样才高亮(哪个对由审核员选)
            const differs = two ? both && !agree : !!v.trim() && !sameValue(f.key, v, cur)
            return (
              <tr key={f.json} className={`${differs ? 'differs' : ''} ${agree ? 'agree' : ''}`}>
                <td className="fname">{fl(f.key as FieldKey)}</td>
                <td><PickCell value={v} disabled={readOnly} onChange={(x) => setVals((o) => ({ ...o, [f.json]: x }))} onPick={(x) => onUseField(f.key, x)} /></td>
                {two && <td className="m2"><PickCell value={v2} disabled={readOnly} onChange={(x) => setVals2((o) => ({ ...o, [f.json]: x }))} onPick={(x) => onUseField(f.key, x)} /></td>}
                <td className="curval">{cur || '—'}</td>
                {!two && <td><button type="button" className="usebtn" disabled={readOnly || !v.trim()} title={t('items.use.tip')} onClick={() => onUseField(f.key, v)}>→</button></td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** JSON 视图里的"表格"模式: 把模型对商品明细的回答排成表格。
 *  格子可以直接改(只改这里的副本,不影响右边的表单);改好后点行尾的「→」把这一行填进表单,或点「全部采用」整张替换。
 *  这样不用在一长串 JSON 里上下找,也不用复制粘贴。 */
function ModelItemsTable({ text, which = 'main', readOnly, onUseRow, onUseAll, onPickCell }: { text: string; which?: 'main' | 'second'; readOnly: boolean; onUseRow: (r: ModelItemRow) => void; onUseAll: (rows: ModelItemRow[]) => void; onPickCell: (col: 'name' | 'qty' | 'uom' | 'discount' | 'tax' | 'price', raw: string) => void }) {
  const { t } = useI18n()
  const parsed = useMemo(() => { const p = modelItemRows(text, which); return { ...p, rows: enrichRows(p.rows, text) } }, [text, which]) // 单位 / 这一行的折扣 / 税率: 模型没读到的,从整页转写里补(2pc → pc,Member Discount -0.24 → 0.24,T → 6%)
  const evidence = useMemo(() => itemAmountSet(fullTextOf(text)), [text])
  const [rows, setRows] = useState<ModelItemRow[]>(parsed.rows)
  useEffect(() => setRows(parsed.rows), [parsed]) // 换了一张收据(或重新扫描)就用新的回答重新排
  const edit = (i: number, k: keyof ModelItemRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const [allTax, setAllTax] = useState('') // 给这张表所有行统一设税率(只改这里的副本)
  const [editMode, setEditMode] = useState(false) // 开了: 所有格子直接是输入框(可改、可加行、可删行);关了: 单击格子 = 填进右边的表单
  const blank: ModelItemRow = { description: '', quantity: '', unit_price: '', amount: '', uom: '', discount: '', tax: '' }
  const addRow = () => { setEditMode(true); setRows((rs) => [...rs, { ...blank }]) }
  const delRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i))
  if (!rows.length) return <><p className="muted small">{t('items.none')}</p>{!readOnly && <button type="button" className="btn sm" onClick={addRow}>{t('form.addRow')}</button>}</>
  const num = (v: string | undefined) => { const n = parseNum(v ?? ''); return n === null || Number.isNaN(n) ? null : n }
  const r2 = (n: number) => Math.round(n * 100) / 100
  const total = (pick: (r: ModelItemRow) => number | null) => r2(rows.reduce((a, r) => a + (pick(r) ?? 0), 0))
  const sumQty = total((r) => num(r.quantity))
  const sumDisc = total((r) => num(r.discount))
  const sumAmt = total((r) => lineAmount(r, evidence).value) // 金额列是算出来的(数量 × 单价 − 折扣),算不出来的行才用模型读到的金额
  const sumUnit = total((r) => { const u = num(r.unit_price), q = num(r.quantity); return u === null ? null : u * (q !== null && q > 0 ? q : 1) }) // 数量×单价
  const hasUnit = rows.some((r) => num(r.unit_price) !== null)
  const net = r2(sumAmt - sumDisc)
  const count = (pick: (r: ModelItemRow) => string | undefined) => rows.filter((r) => (pick(r) ?? '').trim() !== '').length
  const miss = (n: number) => (n < rows.length ? <span className="miss" title={t('items.missing', { n: rows.length - n })}>({n}/{rows.length})</span> : null)
  return (
    <>
      <p className="muted small">
        {t('items.hint')}
        {parsed.source === 'salvaged' ? ` ${t('items.src.salvaged')}` : parsed.source === 'retry' ? ` ${t('items.src.retry')}` : ''}
      </p>
      {!readOnly && (
        <div className="mitems-tools">
          <button type="button" className={`btn sm ${editMode ? 'primary' : ''}`} aria-pressed={editMode} onClick={() => setEditMode((m) => !m)}>{editMode ? `✓ ${t('items.editDone')}` : `✎ ${t('items.edit')}`}</button>
          {editMode && <span className="muted small">{t('items.editHint')}</span>}
          <span className="taxall inline"><span className="lbl">{t('form.taxall')}</span><input className="i-taxall" inputMode="decimal" value={allTax} placeholder="6" onChange={(e) => setAllTax(e.target.value)} /><span className="pct">%</span><button type="button" className="btn sm" onClick={() => { const r = rateOf(allTax); if (r !== null) setRows((rs) => rs.map((x) => ({ ...x, tax: String(r) }))) }}>{t('form.taxall.all')}</button><button type="button" className="btn sm" onClick={() => { const r = rateOf(allTax); if (r !== null) setRows((rs) => rs.map((x) => ((x.tax ?? '').trim() !== '' ? x : { ...x, tax: String(r) }))) }}>{t('form.taxall.empty')}</button></span>
        </div>
      )}
      <div className={`mitems-wrap ${editMode ? 'editing' : ''}`}>
      <table className="mitems">
        <thead><tr><th className="rown">#</th><th>{t('items.col.desc')}</th><th className="num">{t('items.col.qty')}</th><th>{t('items.col.uom')}</th><th className="num">{t('items.col.unit')}</th><th className="num">{t('items.col.disc')}</th><th className="num">{t('items.col.tax')}</th><th className="num">{t('items.col.amount')}</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            // 读到的金额和 数量 × 单价(折扣前 / 折扣后)都对不上: 多半数量、单价或金额读错了,标出来让审核员看原图
            const la = lineAmount(r, evidence)
            const off = la.conflict
            return (
            <tr key={i} className={off ? 'rowoff' : ''} title={off ? (la.unseen ? t('items.rowUnseen', { amt: (la.read ?? 0).toFixed(2) }) : t('items.rowOff', { calc: (la.gross ?? 0).toFixed(2), amt: (la.read ?? 0).toFixed(2) })) : undefined}>
              <td className="rown">{i + 1}</td>
              <td><PickCell always={editMode} value={r.description} disabled={readOnly} onChange={(v) => edit(i, 'description', v)} onPick={(v) => onPickCell('name', v)} /></td>
              <td><PickCell always={editMode} num value={r.quantity} disabled={readOnly} onChange={(v) => edit(i, 'quantity', v)} onPick={(v) => onPickCell('qty', v)} /></td>
              <td><PickCell always={editMode} value={r.uom ?? ''} disabled={readOnly} onChange={(v) => edit(i, 'uom', v)} onPick={(v) => onPickCell('uom', v)} /></td>
              <td><PickCell always={editMode} num value={r.unit_price} disabled={readOnly} onChange={(v) => edit(i, 'unit_price', v)} onPick={(v) => onPickCell('price', v)} /></td>
              <td><PickCell always={editMode} num value={r.discount ?? ''} disabled={readOnly} onChange={(v) => edit(i, 'discount', v)} onPick={(v) => onPickCell('discount', v)} /></td>
              <td><PickCell always={editMode} num value={r.tax ?? ''} disabled={readOnly} onChange={(v) => edit(i, 'tax', v)} onPick={(v) => onPickCell('tax', v)} /></td>
              <td>{(() => {
                // 金额 = 数量 × 单价 − 折扣(数量和单价都读得出来时,用算法算,不信模型读的金额一栏);读不出来(如数量是 1K)才显示模型读到的金额,并且可以改
                if (!la.computed) return <PickCell always={editMode} num value={r.amount} disabled={readOnly} onChange={(v) => edit(i, 'amount', v)} onPick={(v) => onPickCell('price', v)} />
                const shown = (la.value ?? 0).toFixed(2)
                const tip = t('items.amount.auto') + (off && la.read !== null ? ' ' + t('items.amount.modelRead', { v: la.read.toFixed(2) }) : '')
                return <button type="button" className={`pickcell num auto ${off ? 'differs' : ''}`} disabled={readOnly} title={tip} onClick={() => onPickCell('price', shown)}>{shown}{off && <span className="autowarn" aria-hidden> ⚠</span>}</button>
              })()}</td>
              <td className="acts"><button type="button" className="usebtn" disabled={readOnly} title={t('items.use.tip')} onClick={() => onUseRow(r)}>→</button>{editMode && <button type="button" className="del" title={t('form.item.delete')} aria-label={t('form.item.delete')} onClick={() => delRow(i)}>✕</button>}</td>
            </tr>
            )
          })}
        </tbody>
        <tfoot>
          {editMode && <tr className="addrowtr"><td colSpan={9}><button type="button" className="addrow" onClick={addRow}>{t('form.addRow')}</button></td></tr>}
          <tr className="sumrow">
            <td className="rown" />
            <td>{t('items.total')} · {t('items.rows', { n: rows.length })}</td>
            <td className="num">{sumQty}{miss(count((r) => r.quantity))}</td>
            <td />
            <td className="num muted">{hasUnit ? sumUnit.toFixed(2) : ''}</td>
            <td className="num">{sumDisc ? sumDisc.toFixed(2) : '–'}</td>
            <td className="num muted">{count((r) => r.tax) ? `${count((r) => r.tax)}/${rows.length}` : '–'}</td>
            <td className="num strong">{sumAmt.toFixed(2)}{miss(rows.filter((r) => lineAmount(r, evidence).value !== null).length)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      </div>
      <ul className="mitems-sums">
        <li><span>{t('items.sum.amount')}</span><b>{sumAmt.toFixed(2)}</b></li>
        {sumDisc > 0 && <li><span>{t('items.sum.disc')}</span><b>{sumDisc.toFixed(2)}</b></li>}
        {sumDisc > 0 && <li><span>{t('items.sum.net')}</span><b>{net.toFixed(2)}</b></li>}
        {hasUnit && <li><span>{t('items.sum.unit')}</span><b>{sumUnit.toFixed(2)}</b></li>}
        <li><span>{t('items.sum.qty')}</span><b>{sumQty}</b></li>
      </ul>
      <div className="mitems-foot">
        <span className="muted small">{t('items.sumTip')}</span>
        <button type="button" className="usebtn wide" disabled={readOnly} onClick={() => onUseAll(rows)}>{t('items.useAll', { n: rows.length })}</button>
      </div>
    </>
  )
}

function OcrPanel({ text, hits, showHit, onPick, onPickText, onUseRow, onUseAll, onUseField, onPickCell, pickTarget, onClearTarget, form, readOnly }: { text: string; hits: ReadonlySet<number>; showHit: boolean; onPick: (token: string) => void; onPickText: (field: 'description' | 'merchant_name', value: string) => void; onUseRow: (r: ModelItemRow) => void; onUseAll: (rows: ModelItemRow[]) => void; onUseField: (k: ScalarKey, raw: string) => void; onPickCell: (col: 'name' | 'qty' | 'uom' | 'discount' | 'tax' | 'price', raw: string) => void; pickTarget: ScalarKey | null; onClearTarget: () => void; form: FormState; readOnly: boolean }) {
  const { t } = useI18n()
  const [view, setView] = useState<'text' | 'json'>('json') // 默认打开 JSON(模型的原始输出),文字排第二
  const [itemsWhich, setItemsWhich] = useState<'main' | 'second'>('main') // 明细表格看哪个模型读的
  const two = hasSecondReader(text)
  const counts = useMemo(() => ({ main: modelItemRows(text, 'main').rows.length, second: modelItemRows(text, 'second').rows.length }), [text])
  const [jsonMode, setJsonMode] = useState<'json' | 'items' | 'fields'>('fields') // JSON 视图里: 字段表格(默认,最常用) / 明细表格 / 原样的 JSON
  const [rawWhich, setRawWhich] = useState<'main' | 'second'>('main') // 原样 JSON 看哪个模型读的
  const json = useMemo(() => answersAsJson(text, two ? rawWhich : 'all'), [text, two, rawWhich])
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem('portal_ocr_open'); if (v !== null) return v === '1' } catch { /* 隐私模式等 */ }
    return window.innerWidth > 1000
  })
  const toggle = () => setOpen((o) => { try { localStorage.setItem('portal_ocr_open', o ? '0' : '1') } catch { /* 忽略 */ } return !o })
  return (
    <section className={`ocrpanel ${open ? 'open' : ''}`}>
      <button type="button" className="ocrhead" aria-expanded={open} onClick={toggle}>{open ? '▾' : '▸'} {t('form.ocr')}</button>
      {open && (
        <>
          <div className="ocrtabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'json'} className={view === 'json' ? 'on' : ''} onClick={() => setView('json')}>{t('form.ocr.tabJson')}</button>
            <button type="button" role="tab" aria-selected={view === 'text'} className={view === 'text' ? 'on' : ''} onClick={() => setView('text')}>{t('form.ocr.tabText')}</button>
          </div>
          {view === 'json' ? (
            <>
              <div className="ocrtabs sub" role="tablist">
                <button type="button" role="tab" aria-selected={jsonMode === 'fields'} className={jsonMode === 'fields' ? 'on' : ''} onClick={() => setJsonMode('fields')}>{t('form.ocr.jsonFields')}</button>
                <button type="button" role="tab" aria-selected={jsonMode === 'items'} className={jsonMode === 'items' ? 'on' : ''} onClick={() => setJsonMode('items')}>{t('form.ocr.jsonItems')}</button>
                <button type="button" role="tab" aria-selected={jsonMode === 'json'} className={jsonMode === 'json' ? 'on' : ''} onClick={() => setJsonMode('json')}>{t('form.ocr.jsonRaw')}</button>
              </div>
              <div className="ocrscroll">
              {jsonMode === 'items' ? (
                <>
                  {two && (
                    <div className="ocrtabs sub m2tabs" role="tablist">
                      <button type="button" role="tab" aria-selected={itemsWhich === 'main'} className={itemsWhich === 'main' ? 'on' : ''} onClick={() => setItemsWhich('main')}>{t('m.model1')} · {t('m.rows', { n: counts.main })}</button>
                      <button type="button" role="tab" aria-selected={itemsWhich === 'second'} className={itemsWhich === 'second' ? 'on' : ''} onClick={() => setItemsWhich('second')}>{t('m.model2')} · {t('m.rows', { n: counts.second })}</button>
                      {counts.main !== counts.second && <span className="m2warn">⚠ {t('m.rowsDiffer')}</span>}
                    </div>
                  )}
                  <ModelItemsTable key={itemsWhich} text={text} which={two ? itemsWhich : 'main'} readOnly={readOnly} onUseRow={onUseRow} onUseAll={onUseAll} onPickCell={onPickCell} />
                </>
              ) : jsonMode === 'fields' ? (
                <ModelFieldsTable text={text} form={form} readOnly={readOnly} target={pickTarget} onClearTarget={onClearTarget} onUseField={onUseField} />
              ) : (
                <>
                  {two && (
                    <div className="ocrtabs sub m2tabs" role="tablist">
                      <button type="button" role="tab" aria-selected={rawWhich === 'main'} className={rawWhich === 'main' ? 'on' : ''} onClick={() => setRawWhich('main')}>{t('m.model1')}</button>
                      <button type="button" role="tab" aria-selected={rawWhich === 'second'} className={rawWhich === 'second' ? 'on' : ''} onClick={() => setRawWhich('second')}>{t('m.model2')}</button>
                    </div>
                  )}
                  <p className="muted small">{t('form.ocr.hint')}{showHit ? ` ${t('form.ocr.hit')}` : ''} {t('form.ocr.hintName')}</p>
                  <OcrText text={json || ''} hits={hits} onPick={onPick} onPickText={onPickText} />
                </>
              )}
              </div>
            </>
          ) : (
            <div className="ocrscroll">
              <p className="muted small">{t('form.ocr.hint')}{showHit ? ` ${t('form.ocr.hit')}` : ''}</p>
              <OcrText text={text} hits={hits} onPick={onPick} onPickText={onPickText} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** JSON 里值得整块点的文字: 商品名和商家名。整个值是一个按钮(里面的数字不再单独可点,否则 "BERAS 10KG" 会被拆成几块)。
 *  值的结尾不能简单找下一个引号: 模型常把英寸符号 " 直接写进商品名(6"HT),所以只认"后面紧跟 `,"下一个键":`、`}`、或行尾"的那个引号。 */
const NAME_VALUE = /("(?:description|merchant_name)"\s*:\s*")(.*?)(")(?=\s*,\s*"[a-z_]+"\s*:|\s*[}\]]|\s*,?\s*$)/gm

function OcrText({ text, hits, onPick, onPickText }: { text: string; hits: ReadonlySet<number>; onPick: (token: string) => void; onPickText?: (field: 'description' | 'merchant_name', value: string) => void }) {
  const { t } = useI18n()
  if (!text) return <pre className="ocr">{t('form.ocr.empty')}</pre>
  /** 普通文字: 里面的数字可以点,填进选中的金额格子。 */
  const withNumbers = (s: string, base: string) =>
    s.split(/(\d[\d.,]*\d|\d)/g).map((p, i) => (i % 2 === 1 ? <button key={`${base}-${i}`} type="button" className={`ocrnum ${isHit(p, hits) ? 'hit' : ''}`} onClick={() => onPick(p)}>{p}</button> : <Fragment key={`${base}-${i}`}>{p}</Fragment>))
  const nodes: React.ReactNode[] = []
  let last = 0
  if (onPickText) {
    for (const m of text.matchAll(NAME_VALUE)) {
      const at = m.index!
      nodes.push(...withNumbers(text.slice(last, at), `t${at}`))
      const field = m[1]!.includes('merchant_name') ? 'merchant_name' : 'description'
      nodes.push(<Fragment key={`n${at}`}>{m[1]}<button type="button" className="ocrname" title={t('form.ocr.pickName')} onClick={() => onPickText(field, m[2]!)}>{m[2]}</button>{m[3]}</Fragment>)
      last = at + m[0].length
    }
  }
  nodes.push(...withNumbers(text.slice(last), 'end'))
  return <pre className="ocr">{nodes}</pre>
}
