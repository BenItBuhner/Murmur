import React, { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  BookA,
  Clock3,
  Home,
  Keyboard,
  Mic,
  Settings2,
  Sparkles,
  UserRound,
  Waves,
  Zap
} from 'lucide-react'
import type { OverlayState } from '@shared/types'
import { SyncCard } from '@renderer/components/SyncBadge'
import { Rolling, directionBetween, page, settle } from '@renderer/components/motion'
import { cn } from '@renderer/lib/utils'

export type Route =
  | 'home'
  | 'history'
  | 'dictionary'
  | 'snippets'
  | 'style'
  | 'shortcuts'
  | 'audio'
  | 'providers'
  | 'general'
  | 'account'

const NAV: Array<{
  id: Route
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  group?: string
  /** Only shown when the build talks to a Murmur cloud instance. */
  cloud?: boolean
}> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'history', label: 'History', icon: Clock3 },
  { id: 'dictionary', label: 'Dictionary', icon: BookA, group: 'Personalize' },
  { id: 'snippets', label: 'Snippets', icon: Zap },
  { id: 'style', label: 'Style', icon: Sparkles },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, group: 'Setup' },
  { id: 'audio', label: 'Microphone', icon: Mic },
  { id: 'providers', label: 'Models', icon: Waves },
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'account', label: 'Account', icon: UserRound, group: 'Cloud', cloud: true }
]

interface Props {
  route: Route
  onNavigate: (r: Route) => void
  state: OverlayState
  enabled: boolean
  platform: string
  showAccount?: boolean
  children: React.ReactNode
}

export function Shell({
  route,
  onNavigate,
  state,
  enabled,
  platform,
  showAccount = false,
  children
}: Props): React.JSX.Element {
  const isWin = platform === 'win32'
  const nav = NAV.filter((item) => !item.cloud || showAccount)
  const direction = useDirection(route)
  // A new page starts at its top, whatever the last one was scrolled to.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [route])

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className={cn('flex items-center px-6', isWin ? 'h-10 drag-region' : 'h-16')}>
          <Wordmark />
        </div>
        {/*
          The active pill is one shared element that glides between items. It sits on a negative
          z-index inside the nav's own stacking context, so mid-flight it passes under every label
          rather than over the ones it crosses.
        */}
        <nav className="isolate flex-1 space-y-px px-3 pt-3">
          {nav.map((item) => {
            const active = route === item.id
            return (
              <React.Fragment key={item.id}>
                {item.group && <div className="eyebrow px-3 pb-2 pt-6">{item.group}</div>}
                <button
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-[13.5px] font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground',
                    active && 'text-foreground [&>svg]:text-primary'
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      transition={settle}
                      className="absolute inset-0 -z-10 rounded-full bg-accent"
                      aria-hidden
                    />
                  )}
                  <item.icon
                    className="size-4 opacity-80 transition-colors duration-200"
                    strokeWidth={1.75}
                  />
                  <span>{item.label}</span>
                </button>
              </React.Fragment>
            )
          })}
        </nav>
        <div className="space-y-2 p-3">
          {showAccount && <SyncCard />}
          <StatusCard state={state} enabled={enabled} />
        </div>
      </aside>
      <main className="relative flex-1 min-w-0 overflow-hidden">
        {isWin && <div className="drag-region absolute inset-x-0 top-0 h-10" />}
        <div ref={scroller} className="h-full overflow-y-auto px-12 pb-14 pt-12">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={route}
              custom={direction}
              variants={page}
              initial="initial"
              animate="enter"
              exit="exit"
              className="mx-auto max-w-3xl stagger"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  )
}

/** Sidebar order, top to bottom; decides which way a page transition leans. */
const ORDER: readonly Route[] = NAV.map((n) => n.id)

/**
 * Which way the page just chosen sits from the one before it in the sidebar: below (1), above
 * (-1), or nowhere in particular (0). Remembers the last two routes in state so the answer is
 * stable for the whole of the transition.
 */
function useDirection(route: Route): number {
  const [trail, setTrail] = useState<[Route | undefined, Route]>([undefined, route])
  if (trail[1] !== route) setTrail([trail[1], route])
  const from = trail[1] === route ? trail[0] : trail[1]
  return directionBetween(ORDER, from, route)
}

function StatusCard({
  state,
  enabled
}: {
  state: OverlayState
  enabled: boolean
}): React.JSX.Element {
  const listening = state.phase === 'listening'
  const processing = state.phase === 'processing'
  const label = !enabled
    ? 'Paused'
    : listening
      ? 'Listening'
      : processing
        ? 'Transcribing'
        : 'Ready'
  return (
    <button
      onClick={() =>
        enabled ? void window.murmur.dictation.toggle() : void window.murmur.app.setEnabled(true)
      }
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-left transition-[background-color,border-color,transform] duration-200 hover:bg-accent active:scale-[0.985]',
        listening && 'border-record/40'
      )}
      title={listening ? 'Stop and insert' : 'Start hands-free dictation'}
    >
      <span className="relative flex size-2">
        {(listening || processing) && (
          <span
            className={cn(
              'absolute inline-flex size-full rounded-full opacity-70 animate-pulse-soft',
              listening ? 'bg-record' : 'bg-info'
            )}
          />
        )}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full transition-colors duration-300',
            !enabled
              ? 'bg-muted-foreground/40'
              : listening
                ? 'bg-record'
                : processing
                  ? 'bg-info'
                  : 'bg-success'
          )}
        />
      </span>
      <Rolling text={label} className="flex-1 text-[13px] font-medium" />
      <Rolling
        text={listening ? 'click to stop' : enabled ? 'click to start' : 'click to resume'}
        className="text-[11px] text-muted-foreground"
      />
    </button>
  )
}

/** The name, set in the display serif. */
export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('serif-display text-[23px] leading-none', className)}>Murmur</span>
}

export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-[7px] bg-primary text-primary-foreground',
        className
      )}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="3" y="9" width="2.6" height="6" rx="1.3" />
        <rect x="7.5" y="6" width="2.6" height="12" rx="1.3" />
        <rect x="12" y="3.5" width="2.6" height="17" rx="1.3" />
        <rect x="16.5" y="6" width="2.6" height="12" rx="1.3" />
        <rect x="21" y="9" width="2.6" height="6" rx="1.3" transform="translate(-2 0)" />
      </svg>
    </span>
  )
}
