'use client'

import { SignIn } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useConvex } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import type { DesktopToPhone, MicDictationState, MicIceServer } from '@/lib/mic-protocol'
import {
  friendlyLinkError,
  phoneDeviceId,
  phoneName,
  PhoneMicLink,
  type LinkPhase,
  type Receiver
} from '@/lib/phone-mic'
import { convexSignaling } from './convex-signaling'

export function MicView() {
  return (
    <>
      <AuthLoading>
        <Surface className="min-h-64 animate-pulse-soft" />
      </AuthLoading>
      <Unauthenticated>
        <div className="flex flex-col items-center gap-6">
          <p className="max-w-prose text-center text-lead text-muted-foreground">
            Sign in with the account your computer uses.
          </p>
          <SignIn routing="hash" />
        </div>
      </Unauthenticated>
      <Authenticated>
        <PhoneMic />
      </Authenticated>
    </>
  )
}

interface Dictation {
  state: MicDictationState
  startedAt?: number
  level: number
  result?: { text: string; words: number }
  error?: string
}

const IDLE: Dictation = { state: 'idle', level: 0 }

/** Keeps the screen on while `on` (the browser stops the microphone when a phone sleeps). */
function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = (): void => {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release()
          else lock = l
        })
        .catch(() => undefined)
    }
    acquire()
    // The lock is dropped whenever the page is hidden; take it again on return.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => undefined)
    }
  }, [on])
}

function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

function clock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function PhoneMic() {
  const convex = useConvex()
  const signaling = useMemo(() => convexSignaling(convex), [convex])
  const [list, setList] = useState<{ receivers: Receiver[]; iceServers: MicIceServer[] } | null>(
    null
  )
  const [loadError, setLoadError] = useState<string>()
  const [desktop, setDesktop] = useState<Receiver | null>(null)
  const [phase, setPhase] = useState<LinkPhase>('idle')
  const [detail, setDetail] = useState<string>()
  const [dictation, setDictation] = useState<Dictation>(IDLE)
  const linkRef = useRef<PhoneMicLink | null>(null)
  const elapsed = useElapsed(dictation.state === 'listening' ? dictation.startedAt : undefined)

  const load = useCallback(() => {
    signaling
      .receivers()
      .then((l) => {
        setLoadError(undefined)
        setList(l)
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [signaling])

  useEffect(load, [load])
  useEffect(() => () => linkRef.current?.close(), [])
  useWakeLock(phase === 'connecting' || phase === 'linked' || phase === 'interrupted')

  const onMessage = useCallback((m: DesktopToPhone) => {
    setDictation((d) => {
      switch (m.t) {
        case 'welcome':
        case 'state':
          return {
            ...d,
            state: m.state,
            error: undefined,
            startedAt:
              m.state === 'listening'
                ? (d.startedAt ??
                  Date.now() - (m.t === 'state' && m.elapsedSec ? m.elapsedSec * 1000 : 0))
                : undefined,
            level: m.state === 'listening' ? d.level : 0
          }
        case 'level':
          return { ...d, level: m.level }
        case 'result':
          return { ...d, result: { text: m.text, words: m.words }, error: undefined }
        case 'error':
          return { ...d, error: m.message }
        default:
          return d
      }
    })
  }, [])

  const connect = useCallback(
    (receiver: Receiver) => {
      if (!list) return
      linkRef.current?.close()
      setDesktop(receiver)
      setDetail(undefined)
      setDictation(IDLE)
      const link = new PhoneMicLink(signaling, {
        deviceId: phoneDeviceId(typeof localStorage === 'undefined' ? null : localStorage),
        name: phoneName(navigator.userAgent),
        events: {
          phase: (p, d) => {
            if (linkRef.current !== link) return
            setPhase(p)
            setDetail(d)
            if (p === 'closed') setDictation(IDLE)
          },
          message: (m) => {
            if (linkRef.current === link) onMessage(m)
          }
        }
      })
      linkRef.current = link
      link.connect(receiver, list.iceServers).catch((err: unknown) => {
        if (linkRef.current === link) setDetail(friendlyLinkError(err, receiver.name))
      })
    },
    [list, signaling, onMessage]
  )

  const disconnect = (): void => {
    linkRef.current?.close()
    linkRef.current = null
    setPhase('idle')
    setDetail(undefined)
    setDesktop(null)
    setDictation(IDLE)
    load()
  }

  const send = (t: 'start' | 'stop' | 'cancel'): void => {
    if (!linkRef.current?.send({ t }))
      setDictation((d) => ({ ...d, error: 'Not connected to the computer right now.' }))
  }

  // ---- linked ------------------------------------------------------------------------------
  if (desktop && phase !== 'idle') {
    const linked = phase === 'linked'
    const listening = dictation.state === 'listening'
    const processing = dictation.state === 'processing'
    return (
      <Surface className="flex flex-col items-center gap-6 text-center" data-testid="mic-linked">
        <div>
          <p className="text-note text-muted-foreground">Microphone for</p>
          <h2 className="serif-display text-heading">{desktop.name}</h2>
          <p className="mt-1 text-note text-muted-foreground" data-testid="mic-phase">
            {phase === 'connecting' && 'Connecting…'}
            {phase === 'linked' && 'Connected. The text lands where the cursor is on the computer.'}
            {phase === 'interrupted' && 'Connection interrupted. Reconnecting…'}
            {phase === 'closed' && (detail ?? 'Disconnected.')}
          </p>
        </div>

        {phase === 'closed' ? (
          <div className="flex gap-3">
            <Button size="lg" onClick={() => connect(desktop)}>
              Reconnect
            </Button>
            <Button size="lg" variant="ghost" onClick={disconnect}>
              Choose another
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              data-testid="mic-toggle"
              disabled={!linked || processing}
              onClick={() => send(listening ? 'stop' : 'start')}
              aria-pressed={listening}
              className={`relative flex size-44 items-center justify-center rounded-full text-lead font-medium transition-[background-color,transform] duration-200 active:scale-[0.97] disabled:opacity-45 ${
                listening ? 'bg-primary text-primary-foreground' : 'well text-foreground'
              }`}
            >
              {listening && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-primary/25 transition-transform duration-150"
                  style={{ transform: `scale(${1 + dictation.level * 0.25})` }}
                />
              )}
              <span className="relative">
                {listening ? (
                  <>
                    Stop
                    <span className="block text-note tabular-nums opacity-80">
                      {clock(elapsed)}
                    </span>
                  </>
                ) : processing ? (
                  'Writing…'
                ) : (
                  'Start'
                )}
              </span>
            </button>
            <div className="flex gap-3">
              {listening && (
                <Button variant="ghost" onClick={() => send('cancel')}>
                  Discard
                </Button>
              )}
              <Button variant="ghost" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          </>
        )}

        {dictation.error && <p className="text-note text-destructive">{dictation.error}</p>}
        {dictation.result && (
          <div className="well w-full rounded-lg p-card-tight text-left" data-testid="mic-result">
            <p className="text-note text-muted-foreground">
              Inserted {dictation.result.words} word{dictation.result.words === 1 ? '' : 's'}
            </p>
            <p className="mt-1 line-clamp-4 text-body">{dictation.result.text}</p>
          </div>
        )}
        <p className="text-note text-muted-foreground">
          Keep this page open; the screen stays on while you are connected. Your voice goes straight
          to your computer, not through Murmur’s servers.
        </p>
      </Surface>
    )
  }

  // ---- choosing a computer -----------------------------------------------------------------
  return (
    <Surface className="flex flex-col gap-4" data-testid="mic-choose">
      <div>
        <h2 className="serif-display text-heading">Pick a computer</h2>
        <p className="mt-1 text-body text-muted-foreground">
          Computers signed in to this account with <em>Phone as microphone</em> turned on (in
          Murmur’s Microphone settings).
        </p>
      </div>
      {loadError && <p className="text-note text-destructive">{loadError}</p>}
      {!list && !loadError && <div className="well h-12 animate-pulse-soft rounded-lg" />}
      {list && list.receivers.length === 0 && (
        <p className="well rounded-lg p-card-tight text-body text-muted-foreground">
          None yet. On your computer, open Murmur, go to Microphone and turn on{' '}
          <strong>Use a phone as the microphone</strong>, then refresh.
        </p>
      )}
      {list?.receivers.map((r) => (
        <Button
          key={r.deviceId}
          variant="tonal"
          size="lg"
          className="justify-between"
          onClick={() => connect(r)}
        >
          <span>{r.name}</span>
          <span className="text-note text-muted-foreground">{platformLabel(r.platform)}</span>
        </Button>
      ))}
      {detail && <p className="text-note text-destructive">{detail}</p>}
      <Button variant="ghost" onClick={load}>
        Refresh
      </Button>
    </Surface>
  )
}

function platformLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return platform
  }
}
