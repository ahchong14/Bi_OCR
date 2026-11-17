import { useCallback, useEffect, useRef, useState } from 'react'
import type { OcrBox } from '../../../shared/types'
import { useI18n } from '../i18n'

const NUMBERISH = /\d/
const hueOf = (i: number) => (i * 47) % 360

/**
 * 收据图片查看器: 滚轮缩放、拖动平移、旋转、双击放大。
 * 有文字框(识别服务给了位置)时在图上画出每个词的框,点一个框就把里面的文字交给 onPick(审核页据此填进选中的字段)。
 */
export function ImageViewer({ src, openHref, boxes, onPick }: { src: string | null; openHref?: string; boxes?: OcrBox[]; onPick?: (text: string) => void }) {
  const { t } = useI18n()
  const [showBoxes, setShowBoxes] = useState(() => { try { return localStorage.getItem('portal_boxes') !== '0' } catch { return true } })
  const toggleBoxes = () => setShowBoxes((o) => { try { localStorage.setItem('portal_boxes', o ? '0' : '1') } catch { /* 隐私模式等 */ } return !o })
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [v, setV] = useState({ s: 1, x: 0, y: 0, rot: 0, fit: 1 })

  const fit = useCallback((rot: number) => {
    const b = box.current, i = img.current
    if (!b || !i || !i.naturalWidth) return
    const swap = rot % 180 !== 0
    const w = swap ? i.naturalHeight : i.naturalWidth, h = swap ? i.naturalWidth : i.naturalHeight
    const s = Math.min(b.clientWidth / w, b.clientHeight / h)
    setV({ s, x: 0, y: 0, rot, fit: s })
  }, [])

  useEffect(() => { setV((p) => ({ ...p, rot: 0 })) }, [src])
  useEffect(() => {
    const b = box.current
    if (!b) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setV((p) => ({ ...p, s: Math.min(8, Math.max(p.fit * 0.4, p.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) }))
    }
    b.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(() => fit(v.rot))
    ro.observe(b)
    return () => { b.removeEventListener('wheel', onWheel); ro.disconnect() }
  }, [fit, v.rot])

  const zoom = (f: number) => setV((p) => ({ ...p, s: Math.min(8, Math.max(p.fit * 0.4, p.s * f)) }))

  return (
    <div className="imgpane">
      <div className="imgtools">
        <button className="btn sm" onClick={() => zoom(1.25)}>{t('viewer.in')}</button>
        <button className="btn sm" onClick={() => zoom(1 / 1.25)}>{t('viewer.out')}</button>
        <button className="btn sm" onClick={() => fit(v.rot)}>{t('viewer.fit')}</button>
        <button className="btn sm" onClick={() => fit((v.rot + 90) % 360)}>{t('viewer.rotate')}</button>
        {!!boxes?.length && <button className={`btn sm ${showBoxes ? 'on' : ''}`} aria-pressed={showBoxes} title={t('viewer.boxesTip')} onClick={toggleBoxes}>{t('viewer.boxes')}</button>}
        {openHref && <a className="btn sm" href={openHref} target="_blank" rel="noopener">{t('viewer.open')}</a>}
        <span className="muted hide-sm">{t('viewer.hint')}</span>
      </div>
      <div
        ref={box}
        className="viewer"
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.ocrbox')) return; drag.current = { x: e.clientX - v.x, y: e.clientY - v.y }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => drag.current && setV((p) => ({ ...p, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))}
        onPointerUp={() => { drag.current = null }}
        onDoubleClick={() => setV((p) => ({ ...p, s: p.s > p.fit * 1.5 ? p.fit : p.fit * 2.5, x: 0, y: 0 }))}
      >
        {src ? (
          <div
            className="imgwrap" style={{ width: nat.w || undefined, height: nat.h || undefined, ['--s' as string]: v.s, transform: `translate(-50%,-50%) translate(${v.x}px,${v.y}px) rotate(${v.rot}deg) scale(${v.s})` }}
          >
            <img ref={img} src={src} alt={t('viewer.alt')} draggable={false} onLoad={(e) => { setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); fit(v.rot) }} />
            {showBoxes && boxes?.map((b, i) => (
              <button
                key={i} type="button" className={`ocrbox ${NUMBERISH.test(b.t) ? 'num' : ''}`} title={b.t} onClick={() => onPick?.(b.t)}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, ['--hue' as string]: hueOf(i) }}
              />
            ))}
          </div>
        ) : (
          <div className="noimg">{t('review.noImage')}<br />{t('review.noImageHint')}</div>
        )}
      </div>
    </div>
  )
}
