import React, { useEffect, useMemo, useState } from 'react'
import { Clock3, Copy, CornerDownLeft, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { HistoryEntry } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/misc'
import { Empty, PageHeader } from '@renderer/components/SettingRow'
import { useSettings } from '@renderer/hooks/useSettings'
import { formatRelative } from '@renderer/lib/utils'
import { LatencyBar } from './Home'

export function HistoryPage(): React.JSX.Element {
  const { settings } = useSettings()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const r = await window.murmur.history.list(300)
    setEntries(r.entries)
    setTotal(r.total)
  }
  useEffect(() => {
    void load()
    return window.murmur.history.onAdded((e) => {
      setEntries((prev) => [e, ...prev])
      setTotal((t) => t + 1)
    })
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
    await window.murmur.history.delete(id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setTotal((t) => t - 1)
  }
  const clear = async (): Promise<void> => {
    await window.murmur.history.clear()
    setEntries([])
    setTotal(0)
    toast.success('History cleared')
  }

  return (
    <div>
      <PageHeader
        title="History"
        description={`${total} dictation${total === 1 ? '' : 's'}, stored only on this device.`}
        actions={
          entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={clear}>
              <Trash2 /> Clear all
            </Button>
          )
        }
      />
      {entries.length > 0 && (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search dictations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}
      {entries.length === 0 ? (
        <Empty
          icon={<Clock3 />}
          title="No dictations yet"
          description="Everything you dictate is listed here with the raw transcript, the cleaned text, and how long each step took."
        />
      ) : filtered.length === 0 ? (
        <Empty title="No matches" description="Try a different search." />
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => {
            const expanded = open === e.id
            return (
              <div
                key={e.id}
                className="group rounded-xl border bg-card shadow-xs transition-colors"
              >
                <button
                  className="flex w-full items-start gap-4 px-5 py-3.5 text-left"
                  onClick={() => setOpen(expanded ? null : e.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className={expanded ? 'whitespace-pre-wrap text-sm' : 'truncate text-sm'}>
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
                      {e.llmUsed && <Badge variant="secondary">smart</Badge>}
                      {!e.injected && !e.error && <Badge variant="outline">clipboard</Badge>}
                      {e.error && e.finalText && <Badge variant="destructive">not inserted</Badge>}
                      {settings.general.showLatencyInHistory && !e.error && (
                        <span className="ml-auto tabular-nums">{e.timings.totalMs} ms</span>
                      )}
                    </div>
                  </div>
                </button>
                {expanded && (
                  <div className="space-y-4 border-t px-5 py-4 animate-fade-in">
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
                    {settings.general.showLatencyInHistory && !e.error && (
                      <LatencyBar t={e.timings} />
                    )}
                    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <span>
                        {e.provider} · {e.model}
                      </span>
                      {e.injectionMethod && <span>· inserted via {e.injectionMethod}</span>}
                      <span className="ml-auto flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => copy(e.finalText)}>
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
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
