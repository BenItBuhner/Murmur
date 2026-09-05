import React, { useEffect, useState } from 'react'
import { BookA, Plus, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DictionaryEntry } from '@shared/settings'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Badge } from '@renderer/components/ui/misc'
import { Empty, PageHeader } from '@renderer/components/SettingRow'
import { SyncBadge } from '@renderer/components/SyncBadge'
import { useCloud } from '@renderer/hooks/useCloud'
import { useSettings } from '@renderer/hooks/useSettings'
import { uid } from '@renderer/lib/utils'

export function DictionaryPage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const { status } = useCloud()
  const synced = !!status?.signedIn
  const [word, setWord] = useState('')
  const [aliases, setAliases] = useState('')
  const [fuzzy, setFuzzy] = useState(false)
  const [preview, setPreview] = useState('')
  const [previewOut, setPreviewOut] = useState<{ text: string; stages: string[] } | null>(null)

  const add = async (): Promise<void> => {
    const w = word.trim()
    if (!w) return
    if (settings.dictionary.some((d) => d.word.toLowerCase() === w.toLowerCase())) {
      toast.error(`"${w}" is already in your dictionary`)
      return
    }
    const entry: DictionaryEntry = {
      id: uid(),
      word: w,
      aliases: aliases
        .split(/[,;\n]/)
        .map((a) => a.trim())
        .filter((a) => a && a.toLowerCase() !== w.toLowerCase()),
      fuzzy,
      createdAt: Date.now()
    }
    await patch({ dictionary: [entry, ...settings.dictionary] })
    setWord('')
    setAliases('')
    setFuzzy(false)
  }
  const remove = (id: string): Promise<void> =>
    patch({ dictionary: settings.dictionary.filter((d) => d.id !== id) })
  const toggleFuzzy = (id: string, v: boolean): Promise<void> =>
    patch({ dictionary: settings.dictionary.map((d) => (d.id === id ? { ...d, fuzzy: v } : d)) })

  useEffect(() => {
    if (!preview.trim()) {
      setPreviewOut(null)
      return
    }
    const t = setTimeout(
      () =>
        void window.murmur.pipeline
          .preview(preview)
          .then((r) => setPreviewOut({ text: r.text, stages: r.stages })),
      200
    )
    return () => clearTimeout(t)
  }, [preview, settings.dictionary])

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dictionary"
        description={
          synced
            ? 'Names, jargon, and spellings the transcriber should get right. Saved to your account and shared with every device you sign in on.'
            : 'Names, jargon, and spellings the transcriber should get right. Words are sent to the speech model as a hint and enforced in the text afterwards.'
        }
        actions={<SyncBadge />}
      />

      <div className="rounded-xl border bg-card p-5 shadow-xs">
        <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
          <div className="space-y-1.5">
            <Label htmlFor="dict-word">Word or phrase</Label>
            <Input
              id="dict-word"
              placeholder="e.g. Wispr Flow"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dict-alias">Sounds like (optional)</Label>
            <Input
              id="dict-alias"
              placeholder="whisper flow, wisper flow"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Switch checked={fuzzy} onCheckedChange={setFuzzy} /> Also fix near-misses (one or two
            letters off)
          </label>
          <Button onClick={add} disabled={!word.trim()}>
            <Plus /> Add word
          </Button>
        </div>
      </div>

      {settings.dictionary.length === 0 ? (
        <Empty
          icon={<BookA />}
          title="Your dictionary is empty"
          description="Add the names of people, products and tools you say often. Capitalized names are fuzzy-matched automatically."
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-xs divide-y">
          {settings.dictionary.map((d) => (
            <div key={d.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{d.word}</div>
                {d.aliases.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.aliases.map((a) => (
                      <Badge key={a} variant="secondary">
                        {a}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <label
                className="flex items-center gap-2 text-[12px] text-muted-foreground"
                title="Correct near-miss spellings too"
              >
                <Switch checked={d.fuzzy} onCheckedChange={(v) => void toggleFuzzy(d.id, v)} />{' '}
                fuzzy
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void remove(d.id)}
                title="Remove"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Try the cleanup</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Paste a raw transcript to see what the deterministic pass does with your dictionary,
            snippets and commands.
          </p>
        </div>
        <Textarea
          placeholder="um so send it to whisper flow support, no, wisper flow sales new line thanks"
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          className="min-h-16"
        />
        {previewOut && (
          <div className="rounded-xl border bg-card px-4 py-3 shadow-xs animate-fade-in">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Wand2 className="size-3.5" /> Result
              <span className="ml-auto flex flex-wrap gap-1 normal-case tracking-normal">
                {previewOut.stages.map((s) => (
                  <Badge key={s} variant="secondary">
                    {s}
                  </Badge>
                ))}
              </span>
            </div>
            <div className="mt-2 whitespace-pre-wrap text-sm">
              {previewOut.text || <span className="text-muted-foreground">(nothing)</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
