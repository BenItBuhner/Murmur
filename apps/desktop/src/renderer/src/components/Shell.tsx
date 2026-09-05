import React from 'react'
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
  icon: React.ComponentType<{ className?: string }>
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
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className={cn('flex items-center gap-2.5 px-5', isWin ? 'h-10 drag-region' : 'h-14')}>
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Murmur</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 pt-2">
          {nav.map((item) => (
            <React.Fragment key={item.id}>
              {item.group && (
                <div className="px-2 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {item.group}
                </div>
              )}
              <button
                onClick={() => onNavigate(item.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  route === item.id && 'bg-card text-foreground shadow-xs'
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="space-y-2 p-3">
          {showAccount && <SyncCard />}
          <StatusCard state={state} enabled={enabled} />
        </div>
      </aside>
      <main className="relative flex-1 min-w-0 overflow-hidden">
        {isWin && <div className="drag-region absolute inset-x-0 top-0 h-10" />}
        <div className={cn('h-full overflow-y-auto px-10 pb-12', isWin ? 'pt-12' : 'pt-10')}>
          <div className="mx-auto max-w-3xl animate-fade-in" key={route}>
            {children}
          </div>
        </div>
      </main>
    </div>
  )
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
      className="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent"
      title={listening ? 'Stop and insert' : 'Start hands-free dictation'}
    >
      <span className="relative flex size-2.5">
        {listening && (
          <span className="absolute inline-flex size-full rounded-full bg-record opacity-70 animate-pulse-soft" />
        )}
        <span
          className={cn(
            'relative inline-flex size-2.5 rounded-full',
            !enabled
              ? 'bg-muted-foreground/40'
              : listening
                ? 'bg-record'
                : processing
                  ? 'bg-blue-400'
                  : 'bg-success'
          )}
        />
      </span>
      <span className="flex-1 text-[13px] font-medium">{label}</span>
      <span className="text-[11px] text-muted-foreground">
        {listening ? 'click to stop' : enabled ? 'click to start' : 'click to resume'}
      </span>
    </button>
  )
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
