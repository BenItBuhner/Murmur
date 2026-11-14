'use client'

import { SignIn, useAuth, useClerk, useUser } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { api } from '@/lib/backend-api'
import { dictate, GATEWAY_BASE, GatewayError } from '@/lib/dictate/pipeline'
import { Recorder } from '@/lib/dictate/recorder'
import { DEFAULT_SETTINGS, settingsFromAccount } from '@/lib/dictate/settings'
import { Trigger } from '@/lib/dictate/trigger'
import {
  appendDictation,
  isMac,
  isStandalone,
  MINI_FEATURES,
  MINI_SIZE,
  miniUrl
} from '@/lib/dictate/ui'

/** The Clerk JWT template the gateway and Convex accept (desktop DEFAULT_JWT_TEMPLATE). */
const JWT_TEMPLATE = 'convex'
const TEXT_KEY = 'murmur-dictate-text'

type InstallPrompt = Event & { prompt: () => Promise<void> }

export function DictateView() {
  // Chrome offers the install once, early: listen from the first render, before sign-in.
  const [install, setInstall] = useState<InstallPrompt | null>(null)
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstall(e as InstallPrompt)
    }
    const onInstalled = () => setInstall(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  useEffect(() => {
    const isMini = isMiniWindow()
    document.documentElement.classList.toggle('dictate-compact', isMini)
    // Some browsers open the pop-up at the opener's size whatever the features say.
    if (isMini && window.opener && window.outerWidth > 520) {
      try {
        window.resizeTo(MINI_SIZE.width, MINI_SIZE.height)
      } catch {
        /* not allowed here */
      }
    }
    if ('serviceWorker' in navigator)
      navigator.serviceWorker
        .register('/dictate-sw.js', { scope: '/dictate' })
        .catch(() => undefined)
    return () => document.documentElement.classList.remove('dictate-compact')
  }, [])

  return (
    <div data-dictate className="flex flex-col gap-6">
      <AuthLoading>
        <Surface className="min-h-64 animate-pulse-soft" />
      </AuthLoading>
      <Unauthenticated>
        <div className="flex flex-col items-center gap-6">
          <p className="max-w-prose text-center text-lead text-muted-foreground">
            Sign in with your Murmur account. Your dictionary and settings come with it.
          </p>
          <SignIn routing="hash" />
        </div>
      </Unauthenticated>
      <Authenticated>
        <Dictation install={install} setInstall={setInstall} />
      </Authenticated>
    </div>
  )
}

type Phase = 'idle' | 'hold' | 'handsfree' | 'working'

function isMiniWindow(): boolean {
  return new URLSearchParams(location.search).has('mini')
}

function readText(): string {
  try {
    return sessionStorage.getItem(TEXT_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Rendered only once signed in, which happens in the browser, so it may read browser state. */
function Dictation({
  install,
  setInstall
}: {
  install: InstallPrompt | null
  setInstall: (p: InstallPrompt | null) => void
}) {
  const [mini] = useState(isMiniWindow)
  const { getToken } = useAuth()
  const { signOut } = useClerk()
  const { user } = useUser()
  const dictionary = useQuery(api.dictionary.list, {})
  const snippets = useQuery(api.snippets.list, {})
  const preferences = useQuery(api.preferences.get, {})
  const settings = useMemo(
    () =>
      dictionary === undefined || snippets === undefined || preferences === undefined
        ? DEFAULT_SETTINGS
        : settingsFromAccount(dictionary, snippets, preferences),
    [dictionary, snippets, preferences]
  )

  const [phase, setPhaseState] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }
  const [status, setStatus] = useState<{ text: string; tone?: 'rec' | 'error' }>({ text: '' })
  const [text, setText] = useState(readText)
  const [copied, setCopied] = useState(false)
  const [standalone] = useState(isStandalone)
  const [mod] = useState(() => (isMac() ? '⌘' : 'Win'))
  const recorder = useMemo(() => new Recorder(), [])
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const save = (value: string) => {
    setText(value)
    try {
      sessionStorage.setItem(TEXT_KEY, value)
    } catch {
      /* storage blocked */
    }
  }

  const begin = useCallback(
    async (next: 'hold' | 'handsfree') => {
      const current = phaseRef.current
      if (current === 'working') return
      if (current !== 'idle') {
        setPhase(next)
        return
      }
      setPhase(next)
      setStatus({
        text:
          next === 'hold'
            ? 'Listening… release to transcribe'
            : 'Listening hands-free… press again to stop',
        tone: 'rec'
      })
      try {
        await recorder.start()
      } catch (err) {
        setPhase('idle')
        const denied = (err as DOMException)?.name === 'NotAllowedError'
        setStatus({
          text: denied ? 'Allow the microphone for this site to dictate' : 'No microphone found',
          tone: 'error'
        })
      }
    },
    [recorder]
  )

  const end = useCallback(async () => {
    if (phaseRef.current !== 'hold' && phaseRef.current !== 'handsfree') return
    setPhase('working')
    setStatus({ text: 'Transcribing…' })
    try {
      const clip = await recorder.stop()
      if (!clip) {
        setPhase('idle')
        setStatus({ text: 'Too short. Hold the key while you speak.' })
        return
      }
      const result = await dictate(clip.wav, settingsRef.current, {
        gatewayUrl: GATEWAY_BASE,
        token: (force) => getToken({ template: JWT_TEMPLATE, skipCache: force })
      })
      setPhase('idle')
      if (!result.text) {
        setStatus({ text: 'No speech heard. Try again a little closer to the microphone.' })
        return
      }
      setText((prev) => {
        const next = appendDictation(prev, result.text)
        try {
          sessionStorage.setItem(TEXT_KEY, next)
        } catch {
          /* storage blocked */
        }
        return next
      })
      setStatus({ text: `Done in ${(result.ms / 1000).toFixed(1)} s. Ready for the next one.` })
    } catch (err) {
      setPhase('idle')
      setStatus({
        text:
          err instanceof GatewayError || err instanceof Error
            ? err.message
            : 'Transcription failed',
        tone: 'error'
      })
    }
  }, [getToken, recorder])

  // The desktop trigger, while this window has focus. One Trigger for the page's lifetime (it
  // holds the key state), calling the current begin/end through refs.
  const actions = useRef({ begin, end })
  useEffect(() => {
    actions.current = { begin, end }
  }, [begin, end])
  useEffect(() => {
    const trigger = new Trigger((e) => {
      const { begin, end } = actions.current
      if (e === 'hold-start') void begin('hold')
      else if (e === 'hold-end') {
        if (phaseRef.current === 'hold') void end()
      } else if (phaseRef.current === 'handsfree') void end()
      else void begin('handsfree')
    })
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (trigger.down(e, typing(e.target))) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => {
      if (trigger.up(e)) e.preventDefault()
    }
    const blur = () => trigger.blur()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const copy = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.getElementById('dictate-text') as HTMLTextAreaElement | null
      ta?.select()
      document.execCommand('copy')
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const recording = phase === 'hold' || phase === 'handsfree'
  const words = settings.dictionary.length
  const mode = { smart: 'Smart formatting', light: 'Light formatting', off: 'No formatting' }[
    settings.formatting.mode
  ]

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <span className="truncate text-note font-medium text-muted-foreground">
          {user?.primaryEmailAddress?.emailAddress ?? ''}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {install && !standalone && (
            <Button
              id="install"
              variant="tonal"
              size="sm"
              onClick={async () => {
                await install.prompt()
                setInstall(null)
              }}
            >
              Install app
            </Button>
          )}
          {!mini && !standalone && (
            <Button
              id="popout"
              variant="tonal"
              size="sm"
              onClick={() => {
                const w = window.open(miniUrl(location.href), 'murmur-dictate-mini', MINI_FEATURES)
                if (!w)
                  setStatus({
                    text: 'Allow pop-ups for this site to open the small window',
                    tone: 'error'
                  })
              }}
            >
              Small window
            </Button>
          )}
          <Button id="signout" variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>

      <button
        id="mic"
        type="button"
        aria-label={recording ? 'Stop and transcribe' : 'Hold to talk'}
        data-state={phase}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          if (phaseRef.current === 'handsfree') void end()
          else void begin('hold')
        }}
        onPointerUp={() => phaseRef.current === 'hold' && void end()}
        onPointerCancel={() => phaseRef.current === 'hold' && void end()}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (phaseRef.current === 'handsfree') void end()
          else if (phaseRef.current === 'idle') void begin('handsfree')
        }}
        className={`relative grid touch-none place-items-center rounded-full shadow-raised transition-[transform,background-color] duration-200 active:scale-95 ${
          mini ? 'size-18' : 'size-24'
        } ${recording ? 'bg-record text-white' : 'bg-primary text-primary-foreground'}`}
      >
        <span
          className={`absolute -inset-1.5 rounded-full border-[3px] ${
            recording
              ? 'animate-ping border-record/60'
              : phase === 'working'
                ? 'animate-spin border-muted-foreground border-x-transparent'
                : 'border-transparent'
          }`}
        />
        <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Zm6-3.5a.9.9 0 0 0-1.8 0 4.2 4.2 0 0 1-8.4 0 .9.9 0 0 0-1.8 0 6 6 0 0 0 5.1 5.9V20H9a.9.9 0 0 0 0 1.8h6a.9.9 0 0 0 0-1.8h-2.1v-2.6A6 6 0 0 0 18 11.5Z"
          />
        </svg>
      </button>

      <p
        id="status"
        aria-live="polite"
        className={`min-h-6 text-center text-note ${
          status.tone === 'rec'
            ? 'font-medium text-record'
            : status.tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground'
        }`}
      >
        {status.text || (
          <>
            Hold <Key>Ctrl</Key> + <Key>{mod}</Key> or <Key>Space</Key> to talk · <Key>Ctrl</Key> +{' '}
            <Key>{mod}</Key> + <Key>Space</Key> hands-free
          </>
        )}
      </p>

      <ul className="flex flex-wrap justify-center gap-1.5" aria-label="Your settings">
        <li
          className="well rounded-full px-3 py-1 text-note text-muted-foreground"
          title={settings.dictionary.map((d) => d.word).join(', ')}
        >
          {words} dictionary word{words === 1 ? '' : 's'}
        </li>
        <li className="well rounded-full px-3 py-1 text-note text-muted-foreground">{mode}</li>
        <li className="well rounded-full px-3 py-1 text-note text-muted-foreground">
          {settings.language === 'auto' ? 'Any language' : settings.language.toUpperCase()}
        </li>
        {settings.snippets.length > 0 && (
          <li className="well rounded-full px-3 py-1 text-note text-muted-foreground">
            {settings.snippets.length} snippet{settings.snippets.length === 1 ? '' : 's'}
          </li>
        )}
      </ul>

      <div className="flex w-full flex-col gap-2">
        <label htmlFor="dictate-text" className="text-note font-medium text-muted-foreground">
          Transcript
        </label>
        <textarea
          id="dictate-text"
          value={text}
          onChange={(e) => save(e.target.value)}
          placeholder="Your words appear here."
          className={`well w-full resize-y rounded-xl p-4 text-body leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/35 ${
            mini ? 'min-h-36' : 'min-h-56'
          }`}
        />
        <div className="flex justify-end gap-2">
          <Button id="clear" variant="ghost" size="sm" onClick={() => save('')}>
            Clear
          </Button>
          <Button
            id="copy"
            onClick={() => void copy()}
            className={copied ? 'bg-success hover:bg-success' : ''}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-xs bg-card px-1.5 py-0.5 font-mono text-[11px] shadow-raised">
      {children}
    </kbd>
  )
}
