import React, { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Clock3, Flame, Gauge, Type } from 'lucide-react'
import type { HistoryEntry, OverlayState } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Badge, Card, CardContent } from '@renderer/components/ui/misc'
import { KeyCaps, platformFor } from '@renderer/components/KeyCaps'
import { Appear, CountUp, Rolling, arrive, item, leave, list } from '@renderer/components/motion'
import { UpdateBanner } from '@renderer/components/Updates'
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
    <div className="space-y-9">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="serif-display text-[40px]">
            {greeting}
            {firstName ? `, ${firstName}` : ''}.
          </h1>
          <p className="mt-2.5 text-[15px] text-muted-foreground">
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
          className="mt-3 h-6 px-2.5 text-xs transition-colors duration-300"
        >
          <Rolling
            text={
              state.phase === 'listening'
                ? 'Listening'
                : state.phase === 'processing'
                  ? 'Transcribing'
                  : state.phase === 'disabled'
                    ? 'Paused'
                    : 'Ready'
            }
          />
        </Badge>
      </div>

      <Appear show={!configured}>
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
      </Appear>

      <UpdateBanner onNavigate={onNavigate} />

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

        <motion.div
          className="grid grid-cols-2 gap-3"
          variants={list}
          initial="initial"
          animate="enter"
        >
          <Stat icon={<Type />} label="Words dictated">
            <CountUp value={stats.totalWords} format={formatNumber} />
          </Stat>
          <Stat
            icon={<Gauge />}
            label="Speaking pace"
            hint={wpm ? `vs ~${TYPING_WPM} typing` : undefined}
          >
            {wpm ? <CountUp value={wpm} format={(n) => `${Math.round(n)} wpm`} /> : '—'}
          </Stat>
          <Stat icon={<Clock3 />} label="Time saved">
            {savedMs > 0 ? <CountUp value={savedMs} format={formatDuration} /> : '—'}
          </Stat>
          <Stat icon={<Flame />} label="Day streak">
            {stats.streakDays ? <CountUp value={stats.streakDays} /> : '—'}
          </Stat>
        </motion.div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Recent</h2>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('history')}>
            View all <ArrowRight />
          </Button>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-2xl border px-6 py-12 text-center text-[13px] text-muted-foreground">
            Nothing yet. Your dictations show up here with their timing breakdown.
          </div>
        ) : (
          <motion.div
            className="overflow-hidden rounded-2xl border bg-card"
            variants={list}
            initial="initial"
            animate="enter"
          >
            {/* Entries dictated while this page is open slide in at the top. */}
            <AnimatePresence>
              {recent.map((e) => (
                <motion.div
                  key={e.id}
                  layout="position"
                  variants={item}
                  exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease: leave } }}
                  className="overflow-hidden border-b last:border-b-0"
                >
                  <div className="flex items-start gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px]">
                        {e.error ? (
                          <span className="text-destructive">{e.error}</span>
                        ) : (
                          e.finalText
                        )}
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
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </section>

      <Appear show={!!lastLatency && settings.general.showLatencyInHistory}>
        <section className="space-y-3">
          <h2 className="eyebrow">Last dictation, where the time went</h2>
          {lastLatency && <LatencyBar t={lastLatency} />}
        </section>
      </Appear>
    </div>
  )
}

function Stat({
  icon,
  label,
  children,
  hint
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <motion.div variants={item}>
      <Card className="h-full">
        <CardContent className="pt-5">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground [&>svg]:size-3.5 [&>svg]:stroke-[1.75]">
            {icon}
            {label}
          </div>
          <div className="serif-display mt-3 text-[34px] tabular-nums">{children}</div>
          {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/**
 * Where a dictation's time went, stage by stage. The bar grows in from the left the first time it
 * is shown, and its segments glide to their new shares when it is fed another dictation.
 */
export function LatencyBar({ t }: { t: HistoryEntry['timings'] }): React.JSX.Element {
  const parts = [
    { label: 'Silence trim', ms: t.vadMs, color: 'bg-chart-1' },
    { label: 'Speech to text', ms: t.sttMs, color: 'bg-chart-2' },
    { label: 'Cleanup', ms: t.formatMs, color: 'bg-chart-3' },
    { label: 'Smart format', ms: t.llmMs, color: 'bg-chart-4' },
    { label: 'Insert', ms: t.injectMs, color: 'bg-chart-5' }
  ].filter((p) => p.ms > 0)
  const total = Math.max(1, t.totalMs)
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {parts.map((p, i) => (
          <motion.div
            key={p.label}
            className={p.color}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(1, (p.ms / total) * 100)}%` }}
            transition={{ duration: 0.7, ease: arrive, delay: 0.1 + i * 0.05 }}
            title={`${p.label}: ${p.ms} ms`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${p.color}`} /> {p.label}{' '}
            <span className="tabular-nums text-foreground">
              <CountUp value={p.ms} duration={0.7} format={(n) => `${Math.round(n)} ms`} />
            </span>
          </span>
        ))}
        <span className="ml-auto">
          Release to inserted:{' '}
          <span className="font-medium tabular-nums text-foreground">
            <CountUp value={t.totalMs} duration={0.7} format={(n) => `${Math.round(n)} ms`} />
          </span>
        </span>
      </div>
    </div>
  )
}
