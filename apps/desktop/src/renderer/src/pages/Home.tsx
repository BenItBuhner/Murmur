import React, { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Clock3, Flame, Gauge, Type } from 'lucide-react'
import type { HistoryEntry, OverlayState } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Badge, Card, CardContent } from '@renderer/components/ui/misc'
import { KeyCaps, platformFor } from '@renderer/components/KeyCaps'
import { useCloud } from '@renderer/hooks/useCloud'
import { useSettings } from '@renderer/hooks/useSettings'
import { formatDuration, formatNumber, formatRelative } from '@renderer/lib/utils'
import type { Route } from '@renderer/components/Shell'

const TYPING_WPM = 40

export function HomePage({
  state,
  onNavigate
}: {
  state: OverlayState
  onNavigate: (r: Route) => void
}): React.JSX.Element {
  const { settings, info } = useSettings()
  const { clerk, status } = useCloud()
  const [recent, setRecent] = useState<HistoryEntry[]>([])
  const platform = platformFor(info?.platform)
  const firstName = clerk.firstName ?? status?.user?.name?.split(' ')[0]

  useEffect(() => {
    const load = (): void => void window.murmur.history.list(5).then((r) => setRecent(r.entries))
    load()
    const unsubs = [
      window.murmur.history.onAdded((e) =>
        setRecent((prev) => [e, ...prev.filter((x) => x.id !== e.id)].slice(0, 5))
      ),
      window.murmur.history.onChanged(load)
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  const stats = settings.stats
  const speechMin = stats.totalSpeechMs / 60000
  const wpm = speechMin > 0 ? Math.round(stats.totalWords / speechMin) : 0
  const savedMs = Math.max(0, (stats.totalWords / TYPING_WPM) * 60000 - stats.totalSpeechMs)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const configured = !!settings.stt.baseUrl && !!settings.stt.model

  const lastLatency = useMemo(() => recent.find((e) => !e.error)?.timings, [recent])

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">
            {greeting}
            {firstName ? `, ${firstName}` : ''}.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Click into any text field, hold your shortcut, speak, let go.
          </p>
        </div>
        <Badge
          variant={
            state.phase === 'listening'
              ? 'record'
              : state.phase === 'disabled'
                ? 'secondary'
                : 'success'
          }
          className="mt-2 h-6 px-2.5 text-xs"
        >
          {state.phase === 'listening'
            ? 'Listening'
            : state.phase === 'processing'
              ? 'Transcribing'
              : state.phase === 'disabled'
                ? 'Paused'
                : 'Ready'}
        </Badge>
      </div>

      {!configured && (
        <Card className="border-record/40 bg-record/5">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div>
              <div className="text-sm font-medium">Connect a speech model to start dictating</div>
              <div className="text-[13px] text-muted-foreground">
                Murmur needs a transcription endpoint. OpenAI, Groq, Deepgram, or any local whisper
                server works.
              </div>
            </div>
            <Button onClick={() => onNavigate('providers')}>
              Set up <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardContent className="space-y-5 pt-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Hold to dictate</div>
              <KeyCaps
                keys={settings.hotkeys.pushToTalk}
                platform={platform}
                sideSensitive={settings.hotkeys.sideSensitive}
                size="lg"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {settings.hotkeys.handsFreeTrigger === 'tap'
                  ? 'Tap for hands-free'
                  : settings.hotkeys.handsFreeTrigger === 'double-tap'
                    ? 'Double-tap for hands-free'
                    : 'Hands-free'}
              </div>
              <KeyCaps
                keys={
                  settings.hotkeys.handsFreeTrigger === 'off'
                    ? settings.hotkeys.handsFree
                    : settings.hotkeys.pushToTalk
                }
                platform={platform}
                sideSensitive={settings.hotkeys.sideSensitive}
                size="lg"
              />
            </div>
            {settings.hotkeys.commandMode.length > 0 && (
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Edit selected text by voice</div>
                <KeyCaps
                  keys={settings.hotkeys.commandMode}
                  platform={platform}
                  sideSensitive={settings.hotkeys.sideSensitive}
                  size="lg"
                />
              </div>
            )}
            <div className="border-t pt-4">
              <div className="mb-2 text-[13px] text-muted-foreground">
                Practice here — click the box, hold the shortcut and say something.
              </div>
              <Textarea
                placeholder="Your words will appear here…"
                className="min-h-24 resize-none text-[15px]"
              />
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <Stat icon={<Type />} label="Words dictated" value={formatNumber(stats.totalWords)} />
          <Stat
            icon={<Gauge />}
            label="Speaking pace"
            value={wpm ? `${wpm} wpm` : '—'}
            hint={wpm ? `vs ~${TYPING_WPM} typing` : undefined}
          />
          <Stat
            icon={<Clock3 />}
            label="Time saved"
            value={savedMs > 0 ? formatDuration(savedMs) : '—'}
          />
          <Stat
            icon={<Flame />}
            label="Day streak"
            value={stats.streakDays ? String(stats.streakDays) : '—'}
          />
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Recent</h2>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('history')}>
            View all <ArrowRight />
          </Button>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-10 text-center text-[13px] text-muted-foreground">
            Nothing yet. Your dictations show up here with their timing breakdown.
          </div>
        ) : (
          <div className="rounded-xl border bg-card shadow-xs divide-y">
            {recent.map((e) => (
              <div key={e.id} className="flex items-start gap-4 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {e.error ? <span className="text-destructive">{e.error}</span> : e.finalText}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{formatRelative(e.createdAt)}</span>
                    {e.appName && <span>· {e.appName}</span>}
                    <span>· {e.wordCount} words</span>
                    {settings.general.showLatencyInHistory && !e.error && (
                      <span>· {e.timings.totalMs} ms</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {lastLatency && settings.general.showLatencyInHistory && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight">
            Last dictation, where the time went
          </h2>
          <LatencyBar t={lastLatency} />
        </section>
      )}
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground [&>svg]:size-3.5">
          {icon}
          {label}
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export function LatencyBar({ t }: { t: HistoryEntry['timings'] }): React.JSX.Element {
  const parts = [
    { label: 'Silence trim', ms: t.vadMs, color: 'bg-stone-400' },
    { label: 'Speech to text', ms: t.sttMs, color: 'bg-blue-500' },
    { label: 'Cleanup', ms: t.formatMs, color: 'bg-emerald-500' },
    { label: 'Smart format', ms: t.llmMs, color: 'bg-violet-500' },
    { label: 'Insert', ms: t.injectMs, color: 'bg-amber-500' }
  ].filter((p) => p.ms > 0)
  const total = Math.max(1, t.totalMs)
  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {parts.map((p) => (
          <div
            key={p.label}
            className={p.color}
            style={{ width: `${Math.max(1, (p.ms / total) * 100)}%` }}
            title={`${p.label}: ${p.ms} ms`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${p.color}`} /> {p.label}{' '}
            <span className="tabular-nums text-foreground">{p.ms} ms</span>
          </span>
        ))}
        <span className="ml-auto">
          Release to inserted:{' '}
          <span className="font-medium tabular-nums text-foreground">{t.totalMs} ms</span>
        </span>
      </div>
    </div>
  )
}
