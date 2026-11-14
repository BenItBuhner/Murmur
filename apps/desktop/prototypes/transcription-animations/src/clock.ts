import { useEffect, useState } from 'react'
import { DURATION } from './script'

declare global {
  interface Window {
    /** Wall-clock ms (Date.now basis) at which t = 0; the recorder trims video to it. */
    __takeStart?: number
  }
}

const params = new URLSearchParams(location.search)
const RECORDING = params.has('rec')
const LEAD_IN = 500

/** Milliseconds into the take. Loops for viewing; plays once (and holds) when recording. */
export function useClock(): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    const start = performance.now() + LEAD_IN
    window.__takeStart = Date.now() + LEAD_IN
    let raf = 0
    const tick = (now: number): void => {
      const e = now - start
      setT(e < 0 ? 0 : RECORDING ? Math.min(e, DURATION) : e % (DURATION + 600))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return t
}

export const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v))
export const easeOut = (p: number): number => 1 - Math.pow(1 - clamp(p), 3)
export const easeInOut = (p: number): number => {
  const x = clamp(p)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}
export const easeOutBack = (p: number): number => {
  const x = clamp(p)
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
/** Progress 0..1 of an animation that starts at `from` and lasts `dur`. */
export const prog = (t: number, from: number, dur: number): number => clamp((t - from) / dur)
