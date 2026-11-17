import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type OnChangeFn, type SortingState, type VisibilityState } from '@tanstack/react-table'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PIPELINE_STATUSES, type BulkProblem, type BulkScope, type PipelineStatus, type ReceiptQuery, type ReceiptRow, type ReviewState } from '../../../shared/types'
import { ApiError, api } from '../api'
import { DateInput } from '../components/DateInput'
import { ReceiptDrawer } from '../components/ReceiptDrawer'
import { Chips, Dialog, Empty, Segmented, StateBadge, StatusBadge } from '../components/ui'
import { useApp } from '../context'
import { useI18n, type Key } from '../i18n'
import { money, moneyC, stamp } from '../lib/format'

type StateFilter = ReviewState | 'all'
const PAGE_SIZES = [25, 50, 100, 200]
const DEFAULT_HIDDEN: VisibilityState = { subtotal: false, tax: false, tip: false, paid: false, note: false, pipelineStatus: false }

/** 筛选条件保存在网址里: 刷新不丢,还能把链接发给同事。 */
function useUrlState() {
  const [sp, setSp] = useSearchParams()
  const get = (k: string, d = '') => sp.get(k) ?? d
  const set = (patch: Record<string, string | undefined>, keepPage = false) =>
    setSp((prev) => {
      const n = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) v === undefined || v === '' ? n.delete(k) : n.set(k, v)
      if (!keepPage) n.delete('page')
      return n
    }, { replace: true })
  return { get, set }
}

type Tr = ReturnType<typeof useI18n>['t']
const SHOWN = 6
/** 批量通过预览里的问题清单: 文件名 + 商家 + 总额 + 每条问题的一句话。 */
function ProblemList({ items, t }: { items: BulkProblem[]; t: Tr }) {
  return (
    <ul className="problems">
      {items.slice(0, SHOWN).map((p) => (
        <li key={p.id}>
          <span className="mono">{p.file}</span> · {p.merchant ?? t('review.noMerchant')} · {p.total === null ? '—' : money(p.total)}
          <div className="muted small">{p.codes.map((c) => t(`bulk.code.${c}` as Key)).join(' · ')}</div>
        </li>
      ))}
      {items.length > SHOWN && <li className="muted">{t('bulk.more', { n: items.length - SHOWN })}</li>}
    </ul>
  )
}

export default function DataPage() {
  const { t, field } = useI18n()
  const { toast, user } = useApp()
  const qc = useQueryClient()
  const u = useUrlState()
  const state = u.get('state', 'approved') as StateFilter
  const sort = u.get('sort', 'reviewedAt')
  const dir = u.get('dir', 'desc') as 'asc' | 'desc'
  const page = Number(u.get('page', '1')) || 1
  const pageSize = Number(u.get('pageSize', '50')) || 50
  const [qText, setQText] = useState(u.get('q'))
  const [dense, setDense] = useState(() => localStorage.getItem('table_dense') === '1')
  const [colMenu, setColMenu] = useState(false)
  const [visibility, setVisibility] = useState<VisibilityState>(() => {
    try { return { ...DEFAULT_HIDDEN, ...JSON.parse(localStorage.getItem('table_cols') ?? '{}') } } catch { return DEFAULT_HIDDEN }
  })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [approveOpen, setApproveOpen] = useState(false)
  const [ack, setAck] = useState(false) // 员工明确确认「我已核对过这些有问题的收据」才能连它们一起通过
  const openId = u.get('open') ? Number(u.get('open')) : null

  // 搜索框防抖
  useEffect(() => {
    const timer = setTimeout(() => qText !== u.get('q') && u.set({ q: qText }), 300)
    return () => clearTimeout(timer)
  }, [qText]) // eslint-disable-line react-hooks/exhaustive-deps

  const query: ReceiptQuery = {
    state, status: (u.get('status') || undefined) as PipelineStatus | undefined, q: u.get('q') || undefined, currency: u.get('currency') || undefined,
    reviewer: u.get('reviewer') || undefined, edited: (u.get('edited') || undefined) as 'yes' | 'no' | undefined, from: u.get('from') || undefined, to: u.get('to') || undefined,
    sort, dir, page, pageSize,
  }
  const data = useQuery({ queryKey: ['table', query], queryFn: () => api.receipts(query), placeholderData: keepPreviousData })
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta })
  const rows = data.data?.rows ?? []
  const total = data.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))

  // 换了筛选条件/翻页后,清掉已经看不到的选择
  useEffect(() => { setSelected(new Set()) }, [state, u.get('status'), u.get('q'), u.get('currency'), u.get('reviewer'), u.get('edited'), u.get('from'), u.get('to'), page, pageSize])

  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const selectedRows = rows.filter((r) => selected.has(r.id))

  const columns = useMemo<ColumnDef<ReceiptRow>[]>(() => [
    { id: 'select', header: '', enableSorting: false, enableHiding: false, cell: () => null },
    { id: 'file', header: 'file', accessorKey: 'file', cell: (c) => <span className="mono clip" title={c.row.original.file}>{c.row.original.file}</span> },
    { id: 'merchant', header: 'merchant', accessorKey: 'merchant', cell: (c) => c.row.original.merchant ? <span className="clamp2" title={c.row.original.merchant}>{c.row.original.merchant}</span> : <span className="muted">{t('col.unrecognized')}</span> },
    { id: 'date', header: 'date', accessorKey: 'date', cell: (c) => <span className="nowrap">{c.row.original.date ?? '—'}</span> },
    { id: 'currency', header: 'currency', accessorKey: 'currency', cell: (c) => c.row.original.currency ?? '—' },
    { id: 'total', header: 'total', accessorKey: 'total', meta: { num: true }, cell: (c) => <b>{money(c.row.original.total)}</b> },
    { id: 'subtotal', header: 'subtotal', accessorKey: 'subtotal', meta: { num: true }, cell: (c) => money(c.row.original.subtotal) },
    { id: 'tax', header: 'tax', accessorKey: 'tax', meta: { num: true }, cell: (c) => money(c.row.original.tax) },
    { id: 'tip', header: 'tip', accessorKey: 'tip', meta: { num: true }, cell: (c) => money(c.row.original.tip) },
    { id: 'paid', header: 'paid', accessorKey: 'paid', meta: { num: true }, cell: (c) => money(c.row.original.paid) },
    { id: 'itemCount', header: 'itemCount', accessorKey: 'itemCount', meta: { num: true } },
    { id: 'state', header: 'state', accessorKey: 'state', cell: (c) => <StateBadge state={c.row.original.state} /> },
    { id: 'pipelineStatus', header: 'pipelineStatus', accessorKey: 'pipelineStatus', cell: (c) => <StatusBadge status={c.row.original.pipelineStatus} /> },
    { id: 'editedFields', header: 'editedFields', enableSorting: false, cell: (c) => <Chips items={c.row.original.editedFields.map(field)} /> },
    { id: 'reviewer', header: 'reviewer', accessorKey: 'reviewer', cell: (c) => c.row.original.reviewer ?? '—' },
    { id: 'reviewedAt', header: 'reviewedAt', accessorKey: 'reviewedAt', cell: (c) => <span className="nowrap">{stamp(c.row.original.reviewedAt)}</span> },
    { id: 'note', header: 'note', enableSorting: false, cell: (c) => <span className="clip muted" title={c.row.original.note ?? ''}>{c.row.original.note ?? ''}</span> },
  ], [t, field])
  const colName = (id: string) => t(`col.${id}` as Key)

  const sorting: SortingState = [{ id: sort, desc: dir === 'desc' }]
  const onSortingChange: OnChangeFn<SortingState> = (up) => {
    const next = (typeof up === 'function' ? up(sorting) : up)[0]
    next ? u.set({ sort: next.id, dir: next.desc ? 'desc' : 'asc' }) : u.set({ sort: undefined, dir: undefined })
  }
  const table = useReactTable({
    data: rows, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true, manualFiltering: true,
    state: { sorting, columnVisibility: visibility }, onSortingChange, enableSortingRemoval: false, enableMultiSort: false,
    onColumnVisibilityChange: (up) => setVisibility((v) => {
      const n = typeof up === 'function' ? up(v) : up
      localStorage.setItem('table_cols', JSON.stringify(n))
      return n
    }),
    getRowId: (r) => String(r.id),
  })

  const filtersActive = ['status', 'q', 'currency', 'reviewer', 'edited', 'from', 'to'].some((k) => u.get(k))
  const exportQuery: ReceiptQuery = { ...query, page: undefined, pageSize: undefined, sort: undefined, dir: undefined }
  const doExport = (kind: 'receipts' | 'items', ids?: number[]) =>
    api.download(kind, ids ? { state: 'all', ids: ids.join(',') } : exportQuery).catch((e: Error) => toast(e.message || t('toast.exportFailed'), 'err'))

  const bulk = useMutation({
    mutationFn: (a: { action: 'approve' | 'reject' | 'reopen'; note?: string; scope?: BulkScope }) => api.bulk({ ids: [...selected], action: a.action, user, note: a.note, scope: a.scope }),
    onSuccess: (r) => {
      // 跳过的要说清楚: 有问题没通过的几张、本来就不能通过的几张
      const flaggedSkipped = r.flagged.length - r.approvedFlagged
      toast(!r.skipped ? t('toast.bulkDone', { n: r.done }) : t('toast.bulkDetail', { n: r.done, m: r.skipped, f: Math.max(0, flaggedSkipped), b: r.blocked.length }), 'ok')
      setSelected(new Set()); setRejectOpen(false); setApproveOpen(false); setAck(false)
      void qc.invalidateQueries()
    },
    onError: (e: ApiError) => toast(e.message, 'err'),
  })
  // 批量通过前先体检: 列出有问题的和不能通过的,让员工看清楚再决定
  const preview = useMutation({ mutationFn: (ids: number[]) => api.bulkPreview(ids), onError: (e: ApiError) => { toast(e.message, 'err'); setApproveOpen(false) } })
  const openApprove = () => {
    if (!user.trim()) return toast(t('toast.nameNeeded'), 'err')
    setAck(false); setApproveOpen(true); preview.mutate([...selected])
  }
  const runBulk = (a: { action: 'approve' | 'reject' | 'reopen'; note?: string; scope?: BulkScope }) => (user.trim() ? bulk.mutate(a) : toast(t('toast.nameNeeded'), 'err'))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('data.title')}</h1>
          <p className="muted">{t('data.subtitle')}</p>
        </div>
        <div className="row gap">
          <button className="btn" onClick={() => doExport('receipts')}>{t('data.exportReceipts')}</button>
          <button className="btn" onClick={() => doExport('items')}>{t('data.exportItems')}</button>
        </div>
      </div>

      <div className="toolbar">
        <Segmented<StateFilter> value={state} onChange={(v) => u.set({ state: v })}
          options={[{ value: 'approved', label: t('state.approved') }, { value: 'rejected', label: t('state.rejected') }, { value: 'pending', label: t('state.pending') }, { value: 'all', label: t('common.all') }]} />
        <input className="search" type="search" placeholder={t('data.search')} value={qText} onChange={(e) => setQText(e.target.value)} />
        <select value={u.get('status')} onChange={(e) => u.set({ status: e.target.value })} aria-label={t('col.pipelineStatus')}>
          <option value="">{t('data.f.status')}</option>
          {PIPELINE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}` as Key)}</option>)}
        </select>
        <select value={u.get('currency')} onChange={(e) => u.set({ currency: e.target.value })} aria-label={t('col.currency')}>
          <option value="">{t('data.f.currency')}</option>
          {meta.data?.currencies.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={u.get('reviewer')} onChange={(e) => u.set({ reviewer: e.target.value })} aria-label={t('col.reviewer')}>
          <option value="">{t('data.f.reviewer')}</option>
          {meta.data?.reviewers.map((r) => <option key={r}>{r}</option>)}
        </select>
        <select value={u.get('edited')} onChange={(e) => u.set({ edited: e.target.value })} aria-label={t('col.editedFields')}>
          <option value="">{t('data.f.edited')}</option>
          <option value="yes">{t('data.f.editedYes')}</option>
          <option value="no">{t('data.f.editedNo')}</option>
        </select>
        <div className="daterange" role="group" aria-label={t('data.f.date')}>{t('data.f.date')} <DateInput label={t('data.f.dateFrom')} value={u.get('from')} onChange={(v) => u.set({ from: v })} /> – <DateInput label={t('data.f.dateTo')} value={u.get('to')} onChange={(v) => u.set({ to: v })} /></div>
        {filtersActive && <button className="btn ghost sm" onClick={() => { setQText(''); u.set({ status: undefined, q: undefined, currency: undefined, reviewer: undefined, edited: undefined, from: undefined, to: undefined }) }}>{t('common.clearFilters')}</button>}
        <span className="grow" />
        <div className="menu">
          <button className="btn sm" onClick={() => setColMenu((v) => !v)}>{t('data.cols')}</button>
          {colMenu && (
            <div className="menu-body" onMouseLeave={() => setColMenu(false)}>
              {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                <label key={c.id} className="check-row"><input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />{colName(c.id)}</label>
              ))}
            </div>
          )}
        </div>
        <button className="btn sm" onClick={() => setDense((d) => { localStorage.setItem('table_dense', d ? '0' : '1'); return !d })}>{dense ? t('data.comfy') : t('data.dense')}</button>
      </div>

      {selected.size > 0 ? (
        <div className="selbar" role="region">
          <b>{t('sel.count', { n: selected.size })}</b>
          <button className="btn sm primary" title={t('sel.approveHint')} disabled={bulk.isPending || !selectedRows.some((r) => r.state === 'pending')} onClick={openApprove}>{t('sel.approve')}</button>
          <button className="btn sm danger" disabled={bulk.isPending || !selectedRows.some((r) => r.state === 'pending')} onClick={() => { setRejectNote(''); setRejectOpen(true) }}>{t('sel.reject')}</button>
          <button className="btn sm" title={t('sel.reopenHint')} disabled={bulk.isPending || !selectedRows.some((r) => r.state !== 'pending')} onClick={() => runBulk({ action: 'reopen' })}>{t('sel.reopen')}</button>
          <button className="btn sm" onClick={() => doExport('receipts', [...selected])}>{t('sel.export')}</button>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>{t('sel.clear')}</button>
        </div>
      ) : (
        <div className="summary-strip">
          <span>{t('data.count', { n: total })}</span>
          {data.data?.sums.filter((s) => s.sum !== 0).map((s) => <span key={s.currency ?? 'none'} className="sum-chip">{moneyC(s.sum, s.currency ?? t('data.unknownCurrency'))}<small>{t('data.sumCount', { n: s.count })}</small></span>)}
          {data.isFetching && <span className="muted">{t('common.updating')}</span>}
        </div>
      )}

      <div className={`tablewrap ${data.isFetching ? 'busy' : ''}`}>
        <table className={`dt ${dense ? 'dense' : ''}`}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  if (h.column.id === 'select') {
                    return <th key={h.id} className="selcol"><input type="checkbox" aria-label={t('sel.page')} title={t('sel.page')} checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  }
                  const sorted = h.column.getIsSorted()
                  const num = (h.column.columnDef.meta as { num?: boolean } | undefined)?.num
                  return (
                    <th key={h.id} className={`${num ? 'num' : ''} ${h.column.getCanSort() ? 'sortable' : ''}`} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      onClick={h.column.getCanSort() ? () => u.set({ sort: h.column.id, dir: sorted === 'asc' ? 'desc' : 'asc' }) : undefined}>
                      {colName(h.column.id)}
                      {sorted && <span className="sortmark">{sorted === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className={`${Number(row.id) === openId ? 'on' : ''} ${selected.has(Number(row.id)) ? 'sel' : ''}`} tabIndex={0} onClick={() => u.set({ open: row.id }, true)} onKeyDown={(e) => e.key === 'Enter' && u.set({ open: row.id }, true)}>
                {row.getVisibleCells().map((cell) => cell.column.id === 'select' ? (
                  <td key={cell.id} className="selcol" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={t('col.select')} checked={selected.has(Number(row.id))} onChange={() => toggle(Number(row.id))} /></td>
                ) : (
                  <td key={cell.id} className={(cell.column.columnDef.meta as { num?: boolean } | undefined)?.num ? 'num' : ''}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.isLoading && rows.length === 0 && <Empty icon="🗂️" title={t('data.empty.title')}>{filtersActive ? t('data.empty.filters') : state === 'approved' ? t('data.empty.approved') : t('data.empty.generic')}</Empty>}
      </div>

      <div className="pager">
        <span className="muted">{t('pager.page', { page, pages })}</span>
        <button className="btn sm" disabled={page <= 1} onClick={() => u.set({ page: '1' }, true)}>{t('pager.first')}</button>
        <button className="btn sm" disabled={page <= 1} onClick={() => u.set({ page: String(page - 1) }, true)}>{t('pager.prev')}</button>
        <button className="btn sm" disabled={page >= pages} onClick={() => u.set({ page: String(page + 1) }, true)}>{t('pager.next')}</button>
        <button className="btn sm" disabled={page >= pages} onClick={() => u.set({ page: String(pages) }, true)}>{t('pager.last')}</button>
        <span className="grow" />
        <label className="muted">{t('pager.perPage')} <select value={pageSize} onChange={(e) => u.set({ pageSize: e.target.value })}>{PAGE_SIZES.map((n) => <option key={n}>{n}</option>)}</select> {t('pager.perPageUnit')}</label>
      </div>

      <ReceiptDrawer id={openId} onClose={() => u.set({ open: undefined }, true)} />

      <Dialog open={approveOpen} onClose={() => setApproveOpen(false)} title={t('bulk.title')}
        footer={<>
          <button className="btn" onClick={() => setApproveOpen(false)}>{t('common.cancel')}</button>
          {preview.data && preview.data.flagged.length > 0 && <button className="btn danger" disabled={bulk.isPending || !ack} onClick={() => runBulk({ action: 'approve', scope: 'all' })}>{t('bulk.btnAll', { n: preview.data.clean + preview.data.flagged.length })}</button>}
          <button className="btn primary" disabled={bulk.isPending || !preview.data || preview.data.clean === 0} onClick={() => runBulk({ action: 'approve', scope: 'clean' })}>{t('bulk.btnClean', { n: preview.data?.clean ?? 0 })}</button>
        </>}>
        {!preview.data ? <p className="muted">{t('bulk.checking')}</p> : (
          <div className="bulkprev">
            <p><b className="good-text">✓ {t('bulk.clean', { n: preview.data.clean })}</b></p>
            {preview.data.flagged.length > 0 && (
              <>
                <p><b className="warn-text">⚠ {t('bulk.flagged', { n: preview.data.flagged.length })}</b> <span className="muted">{t('bulk.flaggedHint')}</span></p>
                <ProblemList items={preview.data.flagged} t={t} />
                <label className="check-row ackrow"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{t('bulk.ack')}</label>
              </>
            )}
            {preview.data.blocked.length > 0 && (
              <>
                <p><b className="muted">{t('bulk.blocked', { n: preview.data.blocked.length })}</b></p>
                <ProblemList items={preview.data.blocked} t={t} />
              </>
            )}
          </div>
        )}
      </Dialog>

      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} title={t('sel.rejectTitle', { n: selectedRows.filter((r) => r.state === 'pending').length })}
        footer={<><button className="btn" onClick={() => setRejectOpen(false)}>{t('common.cancel')}</button>
          <button className="btn danger" disabled={bulk.isPending} onClick={() => (rejectNote.trim() ? runBulk({ action: 'reject', note: rejectNote }) : toast(t('reject.needNote'), 'err'))}>{t('reject.confirm')}</button></>}>
        <p className="muted">{t('reject.hint')}</p>
        <div className="chips">{(['reject.q1', 'reject.q2', 'reject.q3', 'reject.q4', 'reject.q5'] as Key[]).map((k) => <button key={k} className="chip" onClick={() => setRejectNote(t(k))}>{t(k)}</button>)}</div>
        <textarea rows={3} value={rejectNote} placeholder={t('reject.ph')} onChange={(e) => setRejectNote(e.target.value)} />
      </Dialog>
    </div>
  )
}
