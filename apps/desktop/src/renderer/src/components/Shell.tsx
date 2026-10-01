import React, { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  BookA,
  ChevronRight,
  Clock3,
  Home,
  Keyboard,
  Mic,
  Palette,
  RectangleHorizontal,
  Settings2,
  Sparkles,
  UserRound,
  Waves
} from 'lucide-react'
import type { OverlayState } from '@shared/types'
import { syncLabel } from '@renderer/components/SyncBadge'
import { Rolling, directionBetween, page, settle } from '@renderer/components/motion'
import { useCloud } from '@renderer/hooks/useCloud'
import { NAV, type Route } from '@renderer/lib/navigation'
import { cn } from '@renderer/lib/utils'

export type { Route } from '@renderer/lib/navigation'

type Icon = React.ComponentType<{ className?: string; strokeWidth?: number }>

/** The glyph beside each rail item; the structure itself is `NAV`. */
const ICONS: Record<Route, Icon> = {
  home: Home,
  history: Clock3,
  dictionary: BookA,
  style: Sparkles,
  providers: Waves,
  shortcuts: Keyboard,
  audio: Mic,
  button: RectangleHorizontal,
  appearance: Palette,
  general: Settings2,
  account: UserRound
}

interface Props {
  route: Route
  onNavigate: (r: Route) => void
  state: OverlayState
  enabled: boolean
  platform: string
  showAccount?: boolean
  children: React.ReactNode
}

/**
 * The frame: a rail down the left one tone below the canvas (no rule between them), the page on
 * the right. The active section is a raised pill that glides between items. The rail's foot holds
 * the account (the one place it is reached from) and the live state of the button.
 */
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
  const direction = useDirection(route)
  // A new page starts at its top, whatever the last one was scrolled to.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [route])

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col bg-sidebar">
        <div className={cn('flex items-center px-6', isWin ? 'h-10 drag-region' : 'h-16')}>
          <Wordmark />
        </div>
        {/*
          The active pill is one shared element that glides between items. It sits on a negative
          z-index inside the nav's own stacking context, so mid-flight it passes under every label
          rather than over the ones it crosses.
        */}
        <nav className="isolate flex-1 space-y-px overflow-y-auto px-3 pt-3">
          {NAV.map((item) => {
            const active = route === item.id
            const Icon = ICONS[item.id]
            return (
              <React.Fragment key={item.id}>
                {item.group && <div className="eyebrow px-3 pb-2 pt-6">{item.group}</div>}
                <button
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground',
                    active && 'text-foreground [&>svg]:text-primary'
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      transition={settle}
                      className="surface-raised absolute inset-0 -z-10 rounded-full"
                      aria-hidden
                    />
                  )}
                  <Icon
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
          {showAccount && (
            <AccountCard active={route === 'account'} onOpen={() => onNavigate('account')} />
          )}
          <StatusCard state={state} enabled={enabled} />
        </div>
      </aside>
      <main className="relative flex-1 min-w-0 overflow-hidden">
        {isWin && <div className="drag-region absolute inset-x-0 top-0 h-10" />}
        <div ref={scroller} className="h-full overflow-y-auto px-gutter pb-14 pt-12">
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

/** Sidebar order, top to bottom, the account last; decides which way a page transition leans. */
const ORDER: readonly Route[] = [...NAV.map((n) => n.id), 'account']

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

/**
 * The rail's foot, cloud builds only: who is signed in and how the sync stands, the way the
 * Android drawer's foot shows it. Clicking it opens the Account page; it is the only way there.
 */
function AccountCard({
  active,
  onOpen
}: {
  active: boolean
  onOpen: () => void
}): React.JSX.Element | null {
  const { enabled, status, clerk } = useCloud()
  if (!enabled || !status || status.phase === 'disabled') return null
  const { label, hint } = syncLabel(status)
  const signedIn = status.signedIn || clerk.signedIn
  const name = status.user?.name?.trim() || clerk.name?.trim() || null
  const email = status.user?.email ?? clerk.email
  const initial = (name ?? email ?? '?').charAt(0).toUpperCase()
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'surface-raised flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition-[background-color,box-shadow,transform] duration-200 hover:bg-accent active:scale-[0.985]',
        active && 'bg-accent'
      )}
      title={signedIn ? `${label}: ${hint}` : hint}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-medium',
          signedIn ? 'bg-primary text-primary-foreground' : 'well text-muted-foreground'
        )}
        aria-hidden
      >
        {signedIn ? initial : <UserRound className="size-3.5" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-note font-medium">
          {signedIn ? (name ?? email ?? 'Your account') : 'Not signed in'}
        </span>
        <span className="block truncate text-caption text-muted-foreground">
          {signedIn ? label : 'Sign in to sync across devices'}
        </span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
    </button>
  )
}

/** The rail's foot: a small raised card with the live state of the button; clicking it starts or stops a hands-free dictation. */
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
        'surface-raised flex w-full items-center gap-2.5 rounded-md px-3.5 py-2.5 text-left transition-[background-color,box-shadow,transform] duration-200 hover:bg-accent active:scale-[0.985]',
        listening && 'bg-record/10 hover:bg-record/14'
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
      <Rolling text={label} className="flex-1 text-note font-medium" />
      <Rolling
        text={listening ? 'click to stop' : enabled ? 'click to start' : 'click to resume'}
        className="text-caption text-muted-foreground"
      />
    </button>
  )
}

/** The name, set in the display serif. Murmur has no mark yet; the word is the mark. */
export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('serif-display text-heading leading-none', className)}>Murmur</span>
}
