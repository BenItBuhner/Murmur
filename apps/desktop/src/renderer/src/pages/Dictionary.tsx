import React, { useEffect, useState } from 'react'
import { BookA, Plus, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DictionaryEntry } from '@shared/settings'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Badge } from '@renderer/components/ui/misc'
import { Empty, PageHeader } from '@renderer/components/SettingRow'
import { SyncBadge } from '@renderer/components/SyncBadge'
import { useCloud } from '@renderer/hooks/useCloud'
import { useSettings } from '@renderer/hooks/useSettings'
import { uid } from '@renderer/lib/utils'
import { SnippetsSection } from './Snippets'

/**
 * Everything the transcriber should know about how you talk: the words it must get right and the
 * cues that expand into longer text. One page, as on Android, with the cleanup preview that
 * exercises both at the bottom.
 */
export function DictionaryPage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const { status } = useCloud()
  const synced = !!status?.signedIn
  const [word, setWord] = useState('')
  const [aliases, setAliases] = useState('')
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
      fuzzy: false,
      createdAt: Date.now()
    }
    await patch({ dictionary: [entry, ...settings.dictionary] })
    setWord('')
    setAliases('')
  }
  const remove = (id: string): Promise<void> =>
    patch({ dictionary: settings.dictionary.filter((d) => d.id !== id) })

  useEffect(() => {
    if (!preview.trim()) {
      setPreviewOut(null)
      return
    }
    const t = setTimeout(
      () =>
        void window.murmur.pipeline
          .preview({ raw: preview })
          .then((r) => setPreviewOut({ text: r.light.text, stages: r.light.stages })),
      200
    )
    return () => clearTimeout(t)
  }, [preview, settings.dictionary])

  return (
    <div className="space-y-section">
      <PageHeader
        title="Dictionary and snippets"
        description={
          synced
            ? 'Names, jargon and spellings the transcriber should get right, and short cues that paste longer text. Saved to your account and shared with every device you sign in on.'
            : 'Names, jargon and spellings the transcriber should get right, and short cues that paste longer text. Your words go to the speech model as a hint and to the formatting model as your spelling list.'
        }
        actions={<SyncBadge />}
      />

      <section className="space-y-3">
        <div>
          <h2 className="eyebrow">Dictionary</h2>
          <p className="mt-2 text-note text-muted-foreground">
            A plain list of words and phrases, spelled your way. Murmur also learns how each one
            gets mis-heard: use Fix words on a dictation in History and it offers what you
            corrected.
          </p>
        </div>

        <div className="surface-raised rounded-xl p-card">
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
              <Label htmlFor="dict-alias">Often heard as (optional)</Label>
              <Input
                id="dict-alias"
                placeholder="whisper flow, wisper flow"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end">
            <Button onClick={add} disabled={!word.trim()}>
              <Plus /> Add word
            </Button>
          </div>
        </div>

        {settings.dictionary.length === 0 ? (
          <Empty
            icon={<BookA />}
            title="Your dictionary is empty"
            description="Add the names of people, products and tools you say often, spelled the way you write them."
          />
        ) : (
          /* A list card: each word is a row one radius step in from the card (20 - 8 = 12). */
          <div className="surface-raised rounded-xl p-card-tight">
            {settings.dictionary.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-4 rounded-md px-3 py-2.5 transition-colors hover:bg-accent/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{d.word}</div>
                  {d.aliases.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-meta text-muted-foreground">heard as</span>
                      {d.aliases.map((a) => (
                        <Badge key={a} variant="secondary">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
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
      </section>

      <SnippetsSection />

      <section className="space-y-3">
        <div>
          <h2 className="eyebrow">Try the cleanup</h2>
          <p className="mt-2 text-note text-muted-foreground">
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
          <div className="surface-raised rounded-xl px-card py-4 animate-fade-in">
            <div className="flex items-center gap-2 eyebrow">
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
