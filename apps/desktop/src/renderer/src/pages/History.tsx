import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Clock3,
  Copy,
  CornerDownLeft,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Square,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import type { HistoryEntry } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/misc'
import { Appear, arrive, leave, settle } from '@renderer/components/motion'
import { Empty, PageHeader } from '@renderer/components/SettingRow'
import { SyncBadge } from '@renderer/components/SyncBadge'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn, formatRelative } from '@renderer/lib/utils'
import { LatencyBar } from './Home'

/**
 * What the smart-formatting stage did. The short form sits in the row; the detailed form in the
 * expanded view explains rejections and retries.
 */
function LlmBadge({
  entry,
  detailed
}: {
  entry: HistoryEntry
  detailed?: boolean
}): React.JSX.Element | null {
  const llm = entry.llm
  if (!llm) return entry.llmUsed ? <Badge variant="secondary">smart</Badge> : null
  switch (llm.outcome) {
    case 'used':
      return llm.retriedAfter ? (
        <Badge
          variant="secondary"
          title={`First answer rejected (${llm.retriedAfter}); a strict retry was used`}
        >
          smart · retried
        </Badge>
      ) : (
        <Badge variant="secondary">smart</Badge>
      )
    case 'rejected':
      return detailed ? (
        <Badge
          variant="destructive"
          title="The model's answer failed verification; the rule-based text was inserted"
        >
          model rejected: {llm.detail}
        </Badge>
      ) : (
        <Badge variant="outline" title={`Model rejected (${llm.detail}); rules used`}>
          rules
        </Badge>
      )
    case 'failed':
      return detailed ? (
        <Badge variant="destructive" title={llm.detail}>
          model failed
        </Badge>
      ) : (
        <Badge variant="outline" title={`Model failed (${llm.detail}); rules used`}>
          rules
        </Badge>
      )
    default:
      return detailed ? <Badge variant="outline">model skipped: {llm.detail}</Badge> : null
  }
}

export function HistoryPage(): React.JSX.Element {
  const { settings } = useSettings()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  /** Entry whose recording is being sent again right now. */
  const [retrying, setRetrying] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)

  const load = async (): Promise<void> => {
    const r = await window.murmur.history.list(300)
    setEntries(r.entries)
    setTotal(r.total)
  }
  const stopPlayback = (): void => {
    const p = player.current
    if (!p) return
    p.audio.pause()
    URL.revokeObjectURL(p.url)
    player.current = null
    setPlaying(null)
  }
  useEffect(() => {
    void load()
    const unsubs = [
      window.murmur.history.onAdded((e) => {
        setEntries((prev) => [e, ...prev.filter((x) => x.id !== e.id)])
        setTotal((t) => t + 1)
      }),
      // Entries merged from other devices (or removed there), and dictations sent again, arrive
      // as a whole-list change.
      window.murmur.history.onChanged(() => void load())
    ]
    return () => {
      unsubs.forEach((u) => u())
      stopPlayback()
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.finalText.toLowerCase().includes(q) ||
        e.rawText.toLowerCase().includes(q) ||
        (e.appName ?? '').toLowerCase().includes(q)
    )
  }, [entries, query])

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  }
  const reinsert = async (id: string): Promise<void> => {
    toast('Click where you want the text… inserting in a moment')
    const r = await window.murmur.history.reinsert(id)
    if (!r.ok) toast.error(r.error ?? 'Could not insert')
  }
  const remove = async (id: string): Promise<void> => {
    if (playing === id) stopPlayback()
    await window.murmur.history.delete(id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setTotal((t) => t - 1)
  }
  const clear = async (): Promise<void> => {
    stopPlayback()
    await window.murmur.history.clear()
    setEntries([])
    setTotal(0)
    toast.success('History cleared')
  }
  /** Send the stored audio through the pipeline again; the result is copied, not typed. */
  const retry = async (id: string): Promise<void> => {
    if (retrying) return
    setRetrying(id)
    try {
      const r = await window.murmur.history.retry(id)
      if (r.ok) toast.success('Transcribed — the text is on your clipboard')
      else toast.error(r.error ?? 'Still failing')
    } finally {
      setRetrying(null)
    }
  }
  const togglePlay = async (id: string): Promise<void> => {
    if (playing === id) {
      stopPlayback()
      return
    }
    stopPlayback()
    const bytes = await window.murmur.history.audio(id)
    if (!bytes) {
      toast.error('No recording was kept for this dictation')
      return
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }))
    const audio = new Audio(url)
    audio.onended = () => {
      if (player.current?.audio === audio) stopPlayback()
    }
    audio.onerror = () => {
      toast.error('Could not play the recording')
      if (player.current?.audio === audio) stopPlayback()
    }
    player.current = { audio, url }
    setPlaying(id)
    await audio.play().catch(() => stopPlayback())
  }

  return (
    <div>
      <PageHeader
        title="History"
        description={`${total} dictation${total === 1 ? '' : 's'}, ${
          settings.cloud.historySync ? 'synced across your devices.' : 'stored only on this device.'
        }`}
        actions={
          <>
            {settings.cloud.historySync && <SyncBadge />}
            {entries.length > 0 && (
              <Button variant="outline" size="sm" onClick={clear}>
                <Trash2 /> Clear all
              </Button>
            )}
          </>
        }
      />
      <Appear show={entries.length > 0}>
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search dictations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </Appear>
      {entries.length === 0 ? (
        <Empty
          icon={<Clock3 />}
          title="No dictations yet"
          description="Everything you dictate is listed here with the raw transcript, the cleaned text, the recording, and how long each step took. A dictation that failed can be sent again from here."
        />
      ) : filtered.length === 0 ? (
        <Empty title="No matches" description="Try a different search." />
      ) : (
        <div>
          {/* Rows glide to their new places as a search narrows the list; deleted ones fold away. */}
          <AnimatePresence initial={false}>
            {filtered.map((e) => {
              const expanded = open === e.id
              return (
                <motion.div
                  key={e.id}
                  layout="position"
                  transition={settle}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: arrive } }}
                  exit={{
                    opacity: 0,
                    height: 0,
                    marginBottom: 0,
                    transition: { duration: 0.18, ease: leave }
                  }}
                  className={cn(
                    'group mb-2 overflow-hidden rounded-xl border bg-card shadow-xs transition-colors',
                    expanded && 'border-input'
                  )}
                >
                  {/* A div, not a button: the row carries its own Retry button for failures. */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex w-full cursor-pointer items-start gap-4 px-5 py-3.5 text-left"
                    onClick={() => setOpen(expanded ? null : e.id)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        setOpen(expanded ? null : e.id)
                      }
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className={expanded ? 'whitespace-pre-wrap text-sm' : 'truncate text-sm'}
                      >
                        {e.error && !e.finalText ? (
                          <span className="text-destructive">{e.error}</span>
                        ) : (
                          e.finalText
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{formatRelative(e.createdAt)}</span>
                        {e.appName && <span>· {e.appName}</span>}
                        <span>· {e.wordCount} words</span>
                        {e.mode !== 'hold' && (
                          <Badge variant="secondary" className="ml-1">
                            {e.mode === 'hands-free' ? 'hands-free' : 'command'}
                          </Badge>
                        )}
                        <LlmBadge entry={e} />
                        {e.remote && (
                          <Badge variant="outline" title="Dictated on another device">
                            {e.deviceName ?? 'other device'}
                          </Badge>
                        )}
                        {!e.injected && !e.error && !e.remote && (
                          <Badge variant="outline">clipboard</Badge>
                        )}
                        {e.error && e.finalText && (
                          <Badge variant="destructive">not inserted</Badge>
                        )}
                        {(e.attempts ?? 1) > 1 && (
                          <Badge variant="outline" title="This recording was sent more than once">
                            attempt {e.attempts}
                          </Badge>
                        )}
                        {settings.general.showLatencyInHistory && !e.error && !e.remote && (
                          <span className="ml-auto tabular-nums">{e.timings.totalMs} ms</span>
                        )}
                        {e.error && !e.finalText && e.recording && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto h-7"
                            disabled={retrying !== null}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              void retry(e.id)
                            }}
                          >
                            {retrying === e.id ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <RotateCcw />
                            )}
                            {retrying === e.id ? 'Sending again…' : 'Retry'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  <Appear show={expanded}>
                    <div className="space-y-4 border-t px-5 py-4">
                      {e.rawText && e.rawText.trim() !== e.finalText.trim() && (
                        <div>
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            Raw transcript
                          </div>
                          <div className="whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
                            {e.rawText}
                          </div>
                        </div>
                      )}
                      {settings.general.showLatencyInHistory && !e.error && !e.remote && (
                        <LatencyBar t={e.timings} />
                      )}
                      {(e.stages?.length || e.llm) && (
                        <div className="flex flex-wrap items-center gap-1 text-[11px]">
                          <span className="mr-1 font-medium uppercase tracking-wider text-muted-foreground">
                            Stages
                          </span>
                          {e.stages?.map((s) => (
                            <Badge key={s} variant="outline">
                              {s}
                            </Badge>
                          ))}
                          {e.llm && <LlmBadge entry={e} detailed />}
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                        <span>
                          {e.provider} · {e.model}
                        </span>
                        {e.injectionMethod && <span>· inserted via {e.injectionMethod}</span>}
                        <span className="ml-auto flex gap-1">
                          {e.recording && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void togglePlay(e.id)}
                              title="Play the recording"
                            >
                              {playing === e.id ? <Square /> : <Play />}
                              {playing === e.id ? 'Stop' : 'Play'}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copy(e.finalText)}
                            disabled={!e.finalText}
                          >
                            <Copy /> Copy
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => reinsert(e.id)}
                            disabled={!e.finalText}
                          >
                            <CornerDownLeft /> Insert again
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => remove(e.id)}>
                            <Trash2 /> Delete
                          </Button>
                        </span>
                      </div>
                    </div>
                  </Appear>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
