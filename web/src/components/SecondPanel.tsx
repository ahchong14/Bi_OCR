import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReceiptDetail } from '../../../shared/types'
import { api, type ApiError } from '../api'
import { useApp } from '../context'
import { useI18n } from '../i18n'
import type { FieldKey } from '../../../shared/types'

/**
 * 第二意见面板(审核页): 并排显示两个读取模型对争议字段的读数、Qwen 的仲裁和依据、验证器打分。
 * 影子模式下只显示;「采用」走审核页现有的字段建议(第二个模型的读数会出现在对应字段的建议里,审核员对照原图确认后才保存)。
 * 没有第二意见、也没在队列里时,给一个「请求第二意见」按钮(服务端没开会返回 409,把原因弹出来)。
 */

export function SecondPanel({ d }: { d: ReceiptDetail }) {
  const { t, field } = useI18n()
  const { toast } = useApp()
  const qc = useQueryClient()
  const ask = useMutation({
    mutationFn: () => api.requestSecond(d.id),
    onSuccess: () => { toast(t('second.requested'), 'ok'); void qc.invalidateQueries({ queryKey: ['receipt', d.id] }) },
    onError: (e: ApiError) => toast(e.message, 'err'),
  })
  const s = d.second
  const busy = d.secondState === 'pending' || d.secondState === 'running'
  const label = (f: string) => field(f as FieldKey)
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

  if (!s && !d.secondState) return null
  return (
    <details className="more second" open={!!s && s.disputed.length > 0}>
      <summary>
        {t('second.title')}
        {busy && <span className="muted"> · {d.secondState === 'running' ? t('second.running') : t('second.queued')}</span>}
        {d.secondState === 'failed' && <span className="muted"> · {t('second.failed')}</span>}
        {s && !busy && <span className="muted"> · {s.disputed.length ? s.disputed.map(label).join(' / ') : t('second.agreeAll')}</span>}
      </summary>
      {s?.model2 ? (
        <>
          {s.disputed.length > 0 && (
            <table className="tbl small">
              <thead><tr><th>{t('second.field')}</th><th>{t('second.model1')}</th><th>{t('second.model2')}</th><th>{t('second.qwen')}</th></tr></thead>
              <tbody>
                {s.disputed.map((f) => {
                  const q = s.qwen?.[f]
                  const a = (d.machine as unknown as Record<string, unknown>)[f]
                  const b = s.model2!.candidate[f]
                  return (
                    <tr key={f}>
                      <td>{label(f)}</td>
                      <td>{show(a)}</td>
                      <td>
                        {show(b)}
                      </td>
                      <td>
                        {q ? <>{q.pick === 'A' ? t('second.pickA') : q.pick === 'B' ? t('second.pickB') : t('second.pickNone')}
                          {q.evidence && <div className="muted small" title={q.evidence}>{t('second.evidence')}: {q.evidence}</div>}</> : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">
            {s.jev ? `${t('second.jev')}: ${t('second.model1')} ${s.jev.first?.toFixed(2) ?? '—'} · ${t('second.model2')} ${s.jev.second?.toFixed(2) ?? '—'} · ` : ''}
            {s.applied ? t('second.applied') : `${s.decision.upgrade ? t('second.wouldUpgrade') : t('second.wouldNot')} (${s.decision.why}) · ${t('second.shadow')}`}
          </p>
        </>
      ) : null}
      {!busy && <button type="button" className="btn sm" disabled={ask.isPending} onClick={() => ask.mutate()}>{s ? t('second.rerequest') : t('second.request')}</button>}
    </details>
  )
}
