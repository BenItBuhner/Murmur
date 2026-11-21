import type { CSSProperties, ReactNode } from 'react'
import { easeOut } from './clock'
import { LISTEN_END, LISTEN_START, PROCESS_END, SUCCESS_END, type Phase, phaseAt } from './script'

const BOUNDS: [Phase, number][] = [
  ['idle', 0],
  ['listening', LISTEN_START],
  ['processing', LISTEN_END],
  ['success', PROCESS_END],
  ['idle', SUCCESS_END]
]

/** Which phase came before the one at t, and when the current one began. */
export function phaseInfo(t: number): { phase: Phase; prev: Phase; since: number; at: number } {
  let k = 0
  for (let i = 0; i < BOUNDS.length; i++) if (t >= BOUNDS[i][1]) k = i
  return {
    phase: phaseAt(t),
    prev: BOUNDS[Math.max(0, k - 1)][0],
    since: t - BOUNDS[k][1],
    at: BOUNDS[k][1]
  }
}

export type Size = [number, number]

/**
 * Size that glides from the previous phase's size to the current one over `dur` ms, like the
 * real pill's 340ms width/height transition. `size(phase, t)` gives the resting size.
 */
export function morphSize(t: number, size: (p: Phase, t: number) => Size, dur = 380): Size {
  const { phase, prev, since, at } = phaseInfo(t)
  const to = size(phase, t)
  if (at === 0) return to
  const from = size(prev, at - 1)
  const p = easeOut(since / dur)
  return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p]
}

export const IDLE: Size = [56, 6]

/** The floating pill body every concept sits in (same surface and elevation as the real one). */
export function Pill({
  size,
  children,
  style,
  radius
}: {
  size: Size
  children?: ReactNode
  style?: CSSProperties
  radius?: number
}): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-end justify-center pb-3">
      <div
        className="relative overflow-hidden text-note font-medium text-white"
        style={{
          width: size[0],
          height: size[1],
          borderRadius: radius ?? 999,
          background: 'oklch(0.18 0 0)',
          boxShadow:
            size[1] < 10
              ? '0 1px 4px rgba(0,0,0,0.35)'
              : '0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)',
          ...style
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** The real pill's tick, drawn in by progress p. */
export function Check({
  p,
  color = 'oklch(0.84 0.12 155)',
  size = 16
}: {
  p: number
  color?: string
  size?: number
}): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={16}
        strokeDashoffset={16 * (1 - p)}
      />
    </svg>
  )
}
