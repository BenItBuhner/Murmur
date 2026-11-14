import { useEffect, useRef } from 'react'
import { drawStrands } from './strands'

/** A DPR-aware canvas that redraws the strands whenever t changes. */
export function StrandsCanvas({
  t,
  w,
  h,
  gain,
  tint,
  ownEnding,
  style
}: {
  t: number
  w: number
  h: number
  gain?: number
  tint?: number
  ownEnding?: boolean
  style?: React.CSSProperties
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.max(2, window.devicePixelRatio || 1)
    if (cv.width !== w * dpr) {
      cv.width = w * dpr
      cv.height = h * dpr
    }
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawStrands(g, t, { w, h, gain, tint, ownEnding })
  }, [t, w, h, gain, tint, ownEnding])
  return <canvas ref={ref} style={{ width: w, height: h, display: 'block', ...style }} />
}
