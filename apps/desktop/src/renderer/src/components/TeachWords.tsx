import React, { useState } from 'react'
import { BookPlus, Check } from 'lucide-react'
import { toast } from 'sonner'
import { findCorrections, type WordCorrection } from '@engine'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { useSettings } from '@renderer/hooks/useSettings'
import { withCorrection } from '@renderer/lib/dictionary'

/**
 * Correct a past dictation and let Murmur learn from it: fix the words it got wrong, and each fix
 * that looks like a mis-heard name or term is offered for the dictionary (with what was heard, so
 * the next dictation gets it right). Rewording is ignored; only spelling fixes are offered.
 */
export function TeachWords({
  text,
  onClose
}: {
  text: string
  onClose: () => void
}): React.JSX.Element {
  const { settings, patch } = useSettings()
  const [draft, setDraft] = useState(text)
  const [found, setFound] = useState<WordCorrection[] | null>(null)
  const [added, setAdded] = useState<string[]>([])

  const look = (): void => setFound(findCorrections(text, draft, settings.dictionary))
  const add = async (c: WordCorrection): Promise<void> => {
    await patch({ dictionary: withCorrection(settings.dictionary, c) })
    setAdded((a) => [...a, c.word])
    toast.success(c.kind === 'alias' ? `“${c.heard}” now types “${c.word}”` : `Added “${c.word}”`)
  }

  return (
    <div className="space-y-2.5">
      <div className="eyebrow">Fix the words it got wrong</div>
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setFound(null)
        }}
        className="min-h-20"
        autoFocus
      />
      {found && found.length === 0 && (
        <p className="text-note text-muted-foreground">
          Nothing to learn here: only fixed spellings of names and terms are added, not rewording.
        </p>
      )}
      {found && found.length > 0 && (
        <div className="space-y-1.5">
          {found.map((c) => {
            const done = added.includes(c.word)
            return (
              <div key={`${c.heard}|${c.word}`} className="flex items-center gap-3 text-note">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.word}</span>{' '}
                  <span className="text-muted-foreground">
                    {c.kind === 'alias'
                      ? `(new way it's heard: “${c.heard}”)`
                      : `(heard “${c.heard}”)`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant={done ? 'ghost' : 'outline'}
                  disabled={done}
                  onClick={() => void add(c)}
                >
                  {done ? <Check /> : <BookPlus />} {done ? 'Added' : 'Add to dictionary'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
        <Button size="sm" onClick={look} disabled={draft.trim() === text.trim()}>
          Find words to learn
        </Button>
      </div>
    </div>
  )
}
