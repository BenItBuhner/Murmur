import { useEffect, useMemo, useRef, useState } from 'react'
import type { OverlayState } from '@shared/types'
import { cn } from '@renderer/lib/utils'

const BAR_COUNT = 18

interface Props {
  state: OverlayState
  level: number
  micError?: string
}

export function Overlay({ state, level, micError }: Props): React.JSX.Element {
  const levelsRef = useRef<number[]>(Array(BAR_COUNT).fill(0.05))
  const [, force] = useState(0)
  const phase = state.phase
  const listening = phase === 'listening'

  useEffect(() => {
    if (!listening) {
      levelsRef.current = Array(BAR_COUNT).fill(0.05)
      return
    }
    let raf = 0
    const tick = (): void => {
      const arr = levelsRef.current
      arr.push(Math.max(0.08, Math.min(1, level + (Math.random() - 0.5) * 0.08 * level)))
      if (arr.length > BAR_COUNT) arr.shift()
      force((n) => n + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [listening, level])

  const label = useMemo(() => {
    switch (phase) {
      case 'listening':
        if (state.mode === 'command') return 'Command'
        return state.locked ? 'Hands-free' : ''
      case 'processing':
        return state.mode === 'command' ? 'Editing…' : 'Transcribing…'
      case 'success':
        return state.message ?? 'Inserted'
      case 'error':
        return state.message ?? 'Something went wrong'
      case 'disabled':
        return 'Paused'
      default:
        return ''
    }
  }, [phase, state.locked, state.message, state.mode])

  const elapsed = state.elapsedSec ?? 0
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  if (phase === 'idle') {
    return (
      <div className="flex h-full w-full items-end justify-center pb-3">
        <div
          title={micError}
          className={cn(
            'h-1.5 w-14 rounded-full bg-black/55 shadow-[0_1px_4px_rgba(0,0,0,0.35)] transition-all duration-300',
            micError && 'bg-red-500/70'
          )}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-end justify-center pb-3">
      <div
        className={cn(
          'flex h-11 items-center gap-3 rounded-full px-4 text-[13px] font-medium text-white shadow-[0_6px_24px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.08)_inset] transition-all duration-200',
          'bg-[#141414]/95',
          phase === 'error' && 'bg-[#3a1512]/95',
          phase === 'success' && 'bg-[#0f2a1c]/95',
          phase === 'disabled' && 'bg-[#2a2a2a]/90 text-white/70',
          state.mode === 'command' && listening && 'bg-[#1b1633]/95'
        )}
      >
        {listening && (
          <>
            <span className="relative flex size-2.5">
              <span
                className={cn(
                  'absolute inline-flex size-full rounded-full opacity-70 animate-pulse-soft',
                  state.mode === 'command' ? 'bg-violet-400' : 'bg-[#ff5a36]'
                )}
              />
              <span
                className={cn(
                  'relative inline-flex size-2.5 rounded-full',
                  state.mode === 'command' ? 'bg-violet-400' : 'bg-[#ff5a36]'
                )}
              />
            </span>
            <div className="flex h-6 items-center gap-[3px]">
              {levelsRef.current.map((v, i) => (
                <span
                  key={i}
                  className={cn(
                    'block w-[3px] rounded-full transition-[height] duration-75',
                    state.mode === 'command' ? 'bg-violet-300' : 'bg-white'
                  )}
                  style={{
                    height: `${Math.max(3, Math.round(v * 22))}px`,
                    opacity: 0.55 + v * 0.45
                  }}
                />
              ))}
            </div>
            <span className="tabular-nums text-white/70">{elapsedLabel}</span>
            {label && (
              <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/85">
                {state.locked && state.mode !== 'command' && <LockIcon />}
                {label}
              </span>
            )}
          </>
        )}
        {phase === 'processing' && (
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
        )}
        {phase === 'success' && (
          <>
            <CheckIcon />
            <span>{label}</span>
          </>
        )}
        {phase === 'error' && (
          <>
            <WarnIcon />
            <span className="max-w-[260px] truncate">{label}</span>
          </>
        )}
        {phase === 'disabled' && (
          <>
            <PauseIcon />
            <span>{label}</span>
          </>
        )}
      </div>
    </div>
  )
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
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7ee2a8"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
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
