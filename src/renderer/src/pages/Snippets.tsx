import React, { useState } from 'react'
import { Pencil, Plus, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import type { Snippet } from '@shared/settings'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Empty, PageHeader } from '@renderer/components/SettingRow'
import { useSettings } from '@renderer/hooks/useSettings'
import { uid } from '@renderer/lib/utils'

export function SnippetsPage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [open, setOpen] = useState(false)

  const startNew = (): void => {
    setEditing({ id: uid(), trigger: '', content: '', createdAt: Date.now() })
    setOpen(true)
  }
  const save = async (): Promise<void> => {
    if (!editing) return
    const trigger = editing.trigger.trim()
    if (!trigger || !editing.content.trim()) return
    const dupe = settings.snippets.find(
      (s) => s.id !== editing.id && s.trigger.toLowerCase() === trigger.toLowerCase()
    )
    if (dupe) {
      toast.error(`"${trigger}" is already a snippet trigger`)
      return
    }
    const exists = settings.snippets.some((s) => s.id === editing.id)
    const next = exists
      ? settings.snippets.map((s) => (s.id === editing.id ? { ...editing, trigger } : s))
      : [{ ...editing, trigger }, ...settings.snippets]
    await patch({ snippets: next })
    setOpen(false)
  }
  const remove = (id: string): Promise<void> =>
    patch({ snippets: settings.snippets.filter((s) => s.id !== id) })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Snippets"
        description="Say a short cue and Murmur pastes the full text. Great for links, intros, addresses and replies you type all the time."
        actions={
          <Button onClick={startNew}>
            <Plus /> New snippet
          </Button>
        }
      />
      {settings.snippets.length === 0 ? (
        <Empty
          icon={<Zap />}
          title="No snippets yet"
          description='Create one like "my email" → your address, then say "insert my email" mid-sentence. Placeholders: {date} {time} {day} {clipboard}.'
          action={
            <Button variant="outline" onClick={startNew}>
              <Plus /> Create a snippet
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-xs divide-y">
          {settings.snippets.map((s) => (
            <div key={s.id} className="flex items-start gap-4 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">“{s.trigger}”</div>
                <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-[13px] text-muted-foreground">
                  {s.content}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Edit"
                onClick={() => {
                  setEditing(s)
                  setOpen(true)
                }}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Delete"
                onClick={() => void remove(s.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {settings.snippets.some((s) => s.id === editing?.id) ? 'Edit snippet' : 'New snippet'}
            </DialogTitle>
            <DialogDescription>
              Say the trigger on its own or as “insert &lt;trigger&gt;”. Placeholders{' '}
              {'{date} {time} {day} {clipboard}'} are filled in when inserted.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="snip-trigger">Trigger phrase</Label>
                <Input
                  id="snip-trigger"
                  placeholder="my email"
                  value={editing.trigger}
                  onChange={(e) => setEditing({ ...editing, trigger: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="snip-content">Text to insert</Label>
                <Textarea
                  id="snip-content"
                  className="min-h-28"
                  placeholder="ben@example.com"
                  value={editing.content}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!editing?.trigger.trim() || !editing?.content.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
