import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { OverlayState } from '@shared/types'
import { cn } from '@renderer/lib/utils'

const BAR_COUNT = 18
const BAR_STEP_MS = 45
const IDLE_WIDTH = 56
const IDLE_HEIGHT = 6
const PILL_HEIGHT = 44
const PILL_PAD_X = 16
/** How long an outgoing layer keeps fading; must cover `overlay-layer-out` in globals.css. */
const LEAVE_MS = 240
const FLAT_LEVELS: readonly number[] = Array(BAR_COUNT).fill(0.05)

interface Props {
  state: OverlayState
  level: number
  micError?: string
}

/** One set of pill contents. The current layer renders live props; leaving layers are frozen. */
interface Layer {
  key: string
  state: OverlayState
  leaving: boolean
  levels: readonly number[]
}

interface Stack {
  key: string
  layers: Layer[]
}

/**
 * Everything that changes *what* the pill shows. Progress within a phase (elapsed time, levels,
 * the hands-free badge) updates the current layer in place instead of cross-fading.
 */
function contentKey(s: OverlayState): string {
  switch (s.phase) {
    case 'idle':
      return 'idle'
    case 'listening':
      return `listening:${s.mode === 'command' ? 'command' : 'dictation'}`
    default:
      return `${s.phase}:${s.mode ?? ''}:${s.message ?? ''}`
  }
}

function labelFor(s: OverlayState): string {
  switch (s.phase) {
    case 'listening':
      if (s.mode === 'command') return 'Command'
      return s.locked ? 'Hands-free' : ''
    case 'processing':
      return s.mode === 'command' ? 'Editing…' : 'Transcribing…'
    case 'success':
      return s.message ?? 'Inserted'
    case 'error':
      return s.message ?? 'Something went wrong'
    case 'disabled':
      return 'Paused'
    default:
      return ''
  }
}

/**
 * The overlay pill. A single element morphs between every state: its width follows the measured
 * content, its height, colour and shadow transition, and the old and new contents cross-fade on top
 * of each other while it does. The idle indicator is the same element collapsed to a thin bar, so
 * starting a dictation grows the bar into the pill instead of swapping two elements.
 */
export function Overlay({ state, level, micError }: Props): React.JSX.Element {
  const key = contentKey(state)
  const idle = state.phase === 'idle'
  const listening = state.phase === 'listening'

  // ---- waveform: a new sample slides in on a fixed cadence, independent of the frame rate -----
  const [levels, setLevels] = useState<readonly number[]>(FLAT_LEVELS)
  const levelRef = useRef(level)
  useEffect(() => {
    levelRef.current = level
  }, [level])
  useEffect(() => {
    if (!listening) return
    let raf = 0
    let last = 0
    let fresh = true
    const tick = (now: number): void => {
      if (now - last >= BAR_STEP_MS) {
        last = now
        const lvl = levelRef.current
        const sample = Math.max(0.08, Math.min(1, lvl + (Math.random() - 0.5) * 0.08 * lvl))
        setLevels((prev) => {
          const next = [...(fresh ? FLAT_LEVELS : prev), sample]
          fresh = false
          if (next.length > BAR_COUNT) next.shift()
          return next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [listening])

  // ---- layer stack: the current contents plus whatever is still fading out ------------------
  // Derived from the previous render's stack (React's "adjust state during render" pattern).
  const [stack, setStack] = useState<Stack>(() => ({
    key,
    layers: idle ? [] : [{ key, state, leaving: false, levels: FLAT_LEVELS }]
  }))
  const current = stack.layers.find((l) => !l.leaving)
  if (stack.key !== key) {
    const next = stack.layers.filter((l) => l.leaving && l.key !== key)
    if (current) next.push({ ...current, leaving: true, levels })
    if (!idle) next.push({ key, state, leaving: false, levels: FLAT_LEVELS })
    setStack({ key, layers: next })
  } else if (current && current.state !== state) {
    // Keep the live layer's snapshot fresh so it freezes on its latest contents when it leaves.
    setStack({ key, layers: stack.layers.map((l) => (l === current ? { ...l, state } : l)) })
  }
  useEffect(() => {
    if (!stack.layers.some((l) => l.leaving)) return
    const timer = window.setTimeout(() => {
      setStack((s) => ({ ...s, layers: s.layers.filter((l) => !l.leaving) }))
    }, LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [stack])

  // ---- width follows the current contents ---------------------------------------------------
  // ResizeObserver reports the initial size on observe() and runs before paint; flushSync makes
  // the new width land in the same frame so the CSS transition starts from the previous one.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [contentWidth, setContentWidth] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.offsetWidth
      flushSync(() => setContentWidth(Math.ceil(w)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [key])

  const width = idle ? IDLE_WIDTH : Math.max(IDLE_WIDTH, contentWidth + PILL_PAD_X * 2)
  const height = idle ? IDLE_HEIGHT : PILL_HEIGHT
  const phase = state.phase

  return (
    <div className="flex h-full w-full items-end justify-center pb-3">
      <div
        title={idle ? micError : undefined}
        style={{ width, height }}
        className={cn(
          'overlay-pill relative overflow-hidden rounded-full text-[13px] font-medium text-white',
          idle
            ? micError
              ? 'bg-red-500/70 shadow-[0_1px_4px_rgba(0,0,0,0.35)]'
              : 'bg-black/55 shadow-[0_1px_4px_rgba(0,0,0,0.35)]'
            : 'shadow-[0_6px_24px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.08)_inset]',
          !idle && 'bg-[#141414]/95',
          phase === 'error' && 'bg-[#3a1512]/95',
          phase === 'success' && 'bg-[#0f2a1c]/95',
          phase === 'disabled' && 'bg-[#2a2a2a]/90 text-white/70',
          state.mode === 'command' && listening && 'bg-[#1b1633]/95'
        )}
      >
        {stack.layers.map((layer) => (
          <div
            key={layer.key}
            className={cn(
              'overlay-layer',
              layer.leaving ? 'overlay-layer-out' : 'overlay-layer-in'
            )}
          >
            <div
              ref={layer.leaving ? undefined : contentRef}
              className="flex h-11 items-center gap-3 whitespace-nowrap"
            >
              <Contents
                state={layer.leaving ? layer.state : state}
                levels={layer.leaving ? layer.levels : levels}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Contents({
  state,
  levels
}: {
  state: OverlayState
  levels: readonly number[]
}): React.JSX.Element | null {
  const label = labelFor(state)
  const elapsed = state.elapsedSec ?? 0
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  switch (state.phase) {
    case 'listening': {
      const command = state.mode === 'command'
      return (
        <>
          <span className="relative flex size-2.5">
            <span
              className={cn(
                'absolute inline-flex size-full rounded-full opacity-70 animate-pulse-soft',
                command ? 'bg-violet-400' : 'bg-[#ff5a36]'
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-2.5 rounded-full',
                command ? 'bg-violet-400' : 'bg-[#ff5a36]'
              )}
            />
          </span>
          <div className="flex h-6 items-center gap-[3px]">
            {levels.map((v, i) => (
              <span
                key={i}
                className={cn(
                  'block w-[3px] rounded-full transition-[height] duration-75',
                  command ? 'bg-violet-300' : 'bg-white'
                )}
                style={{ height: `${Math.max(3, Math.round(v * 22))}px`, opacity: 0.55 + v * 0.45 }}
              />
            ))}
          </div>
          <span className="tabular-nums text-white/70">{elapsedLabel}</span>
          {label && (
            <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/85 animate-fade-in">
              {state.locked && !command && <LockIcon />}
              {label}
            </span>
          )}
        </>
      )
    }
    case 'processing':
      return (
        <>
          <span className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block size-1.5 rounded-full bg-white animate-bounce-dot"
                style={{ animationDelay: `${i * 140}ms` }}
              />
            ))}
          </span>
          <span className="text-white/85">{label}</span>
        </>
      )
    case 'success':
      return (
        <>
          <CheckIcon />
          <span>{label}</span>
        </>
      )
    case 'error':
      return (
        <>
          <WarnIcon />
          <span className="max-w-[260px] truncate">{label}</span>
        </>
      )
    case 'disabled':
      return (
        <>
          <PauseIcon />
          <span>{label}</span>
        </>
      )
    default:
      return null
  }
}

function LockIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
function CheckIcon(): React.JSX.Element {
  return (
    <svg
      className="overlay-check"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7ee2a8"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  )
}
function WarnIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#ff8a70"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}
function PauseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}
