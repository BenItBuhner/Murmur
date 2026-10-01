import React, { useState } from 'react'
import { FolderOpen, Loader2, Power, RotateCcw, Type } from 'lucide-react'
import { toast } from 'sonner'
import type { InjectionMethod } from '@shared/settings'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Badge, Segmented } from '@renderer/components/ui/misc'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { UpdatesSection } from '@renderer/components/Updates'
import { useSettings } from '@renderer/hooks/useSettings'
import { describeInstallKind } from '@shared/updates'

/**
 * What is left once the pill, the look and the language have pages of their own: startup, text
 * insertion, updates and the app itself.
 */
export function GeneralPage(): React.JSX.Element {
  const { settings, patch, info } = useSettings()
  const g = settings.general
  const inj = settings.injection
  const [testing, setTesting] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const isWin = info?.platform === 'win32'

  const testInsert = async (): Promise<void> => {
    setTesting(true)
    const r = await window.murmur.inject.test('The quick brown fox jumps over the lazy dog. ')
    setTesting(false)
    if (r.ok) toast.success(`Inserted via ${r.method} in ${r.ms} ms`)
    else toast.error(r.error ?? 'Insertion failed')
  }

  return (
    <div className="space-y-section">
      <PageHeader
        title="General"
        description="How Murmur starts, how it puts text where your cursor is, and the app itself."
      />

      <Section title="Startup">
        <SettingRow
          title="Launch at login"
          description="Start Murmur in the background when you sign in."
        >
          <Switch
            checked={g.launchAtLogin}
            onCheckedChange={(v) => void patch({ general: { launchAtLogin: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Start minimized"
          description="Open to the tray instead of showing this window."
        >
          <Switch
            checked={g.startMinimized}
            onCheckedChange={(v) => void patch({ general: { startMinimized: v } })}
          />
        </SettingRow>
      </Section>

      <Section title="Text insertion" description={`Backend: ${info?.injectionBackend ?? '…'}`}>
        <SettingRow
          title="Method"
          description={
            inj.method === 'type'
              ? isWin
                ? 'Types each character with SendInput. Never touches the clipboard; slower for long text.'
                : 'Types with xdotool/wtype. Never touches the clipboard; slower for long text.'
              : inj.method === 'clipboard'
                ? 'Only copies the text; you paste it yourself.'
                : 'Copies the text and presses Ctrl+V, then restores your previous clipboard. Fastest and works everywhere.'
          }
        >
          <Segmented<InjectionMethod>
            value={inj.method}
            onChange={(v) => void patch({ injection: { method: v } })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'paste', label: 'Paste' },
              { value: 'type', label: 'Type' },
              { value: 'clipboard', label: 'Copy only' }
            ]}
          />
        </SettingRow>
        {inj.method !== 'type' && (
          <>
            <SettingRow
              title="Restore clipboard"
              description="Put whatever was on the clipboard back after pasting."
            >
              <Switch
                checked={inj.restoreClipboard}
                onCheckedChange={(v) => void patch({ injection: { restoreClipboard: v } })}
              />
            </SettingRow>
            {inj.restoreClipboard && (
              <SettingRow
                title="Restore delay"
                description="Some apps read the clipboard lazily; raise this if pasted text sometimes comes out as your old clipboard."
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={50}
                    max={5000}
                    step={50}
                    className="w-24 text-right"
                    value={inj.restoreClipboardDelayMs}
                    onChange={(e) =>
                      void patch({
                        injection: { restoreClipboardDelayMs: Math.max(50, Number(e.target.value)) }
                      })
                    }
                  />
                  <span className="text-sm text-muted-foreground">ms</span>
                </div>
              </SettingRow>
            )}
          </>
        )}
        <SettingRow
          title="Test insertion"
          description="Click the box below, press the button, and the sample sentence lands in it about a second later."
          vertical
        >
          <div className="flex w-full flex-col gap-2">
            <Textarea placeholder="Click here first…" className="min-h-16" />
            <div>
              <Button variant="outline" onClick={testInsert} disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <Type />} Insert sample text
              </Button>
            </div>
          </div>
        </SettingRow>
      </Section>

      <UpdatesSection />

      <Section title="About">
        <SettingRow
          title={`Murmur ${info?.version ?? ''}`}
          description={info ? `Electron ${info.electron} · ${info.platform}/${info.arch}` : ''}
        >
          <div className="flex flex-wrap gap-1.5">
            {info && <Badge variant="outline">{describeInstallKind(info.installKind)}</Badge>}
            <Badge variant="outline">hook: {info?.hookBackend ?? '…'}</Badge>
            {info?.sessionType && <Badge variant="outline">{info.sessionType}</Badge>}
          </div>
        </SettingRow>
        <SettingRow title="Logs and data" description={info?.userDataPath}>
          <Button variant="outline" size="sm" onClick={() => void window.murmur.app.openLogs()}>
            <FolderOpen /> Open log
          </Button>
        </SettingRow>
        <SettingRow
          title="Reset settings"
          description="Restores defaults. Dictionary, snippets and history are kept unless you clear them separately."
        >
          <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw /> Reset
          </Button>
        </SettingRow>
        <SettingRow title="Quit Murmur" description="Stops the background listener.">
          <Button variant="outline" size="sm" onClick={() => void window.murmur.app.quit()}>
            <Power /> Quit
          </Button>
        </SettingRow>
      </Section>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset all settings?</DialogTitle>
            <DialogDescription>
              Shortcuts, providers, style and audio settings go back to defaults. API keys are
              removed. Your dictionary, snippets and history are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const keep = {
                  dictionary: settings.dictionary,
                  snippets: settings.snippets,
                  stats: settings.stats
                }
                await window.murmur.settings.reset()
                await patch(keep)
                setResetOpen(false)
                toast.success('Settings reset')
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
