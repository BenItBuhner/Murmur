import React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { HandsFreeTrigger } from '@shared/settings'
import { Switch } from '@renderer/components/ui/switch'
import { Slider } from '@renderer/components/ui/slider'
import { Banner, Segmented } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { HotkeyRecorder } from '@renderer/components/HotkeyRecorder'
import { platformFor } from '@renderer/components/KeyCaps'
import { useSettings } from '@renderer/hooks/useSettings'

export function ShortcutsPage(): React.JSX.Element {
  const { settings, patch, info } = useSettings()
  const h = settings.hotkeys
  const platform = platformFor(info?.platform)
  const fallback = info?.hookBackend === 'globalShortcut'

  return (
    <div className="space-y-section">
      <PageHeader
        title="Shortcuts"
        description="One key does everything: hold it to talk, tap it to go hands-free. All bindings are global and work in any app."
      />

      {fallback && (
        <Banner tone="warning" className="flex items-start gap-3 text-note">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <div className="font-medium">Hold-to-talk is unavailable in this session</div>
            <div className="text-muted-foreground">
              The low-level keyboard hook could not start
              {info?.sessionType === 'wayland'
                ? ' (Wayland restricts global input hooks; apps running through XWayland still work)'
                : ''}
              . Shortcuts fall back to press-to-toggle, and modifier-only combinations such as Ctrl
              + Win cannot be registered — pick a combination that includes a regular key.
            </div>
          </div>
        </Banner>
      )}

      <Section title="Dictation">
        <SettingRow
          title="Push to talk"
          description="Hold to record, release to insert. Tap it to lock hands-free (see below)."
        >
          <HotkeyRecorder
            value={h.pushToTalk}
            onChange={(keys) => void patch({ hotkeys: { pushToTalk: keys } })}
            platform={platform}
            sideSensitive={h.sideSensitive}
          />
        </SettingRow>
        <SettingRow
          title="Hands-free trigger"
          description={
            h.handsFreeTrigger === 'tap'
              ? 'A quick tap of the push-to-talk key starts hands-free mode; press again to stop and insert.'
              : h.handsFreeTrigger === 'double-tap'
                ? 'Double-tap the push-to-talk key to lock hands-free, like Wispr Flow. A single tap is ignored.'
                : 'The push-to-talk key only works while held. Use the dedicated shortcut for hands-free.'
          }
        >
          <Segmented<HandsFreeTrigger>
            value={h.handsFreeTrigger}
            onChange={(v) => void patch({ hotkeys: { handsFreeTrigger: v } })}
            options={[
              { value: 'tap', label: 'Tap' },
              { value: 'double-tap', label: 'Double-tap' },
              { value: 'off', label: 'Off' }
            ]}
          />
        </SettingRow>
        <SettingRow
          title="Tap threshold"
          description={`Presses shorter than ${h.tapThresholdMs} ms count as a tap.`}
        >
          <div className="w-52">
            <Slider
              min={120}
              max={800}
              step={10}
              value={[h.tapThresholdMs]}
              onValueChange={([v]) => void patch({ hotkeys: { tapThresholdMs: v } })}
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Hands-free shortcut"
          description="Optional dedicated key to start or stop a hands-free session. Pressing it while holding push-to-talk locks the session."
        >
          <HotkeyRecorder
            value={h.handsFree}
            onChange={(keys) => void patch({ hotkeys: { handsFree: keys } })}
            platform={platform}
            sideSensitive={h.sideSensitive}
            allowClear
          />
        </SettingRow>
      </Section>

      <Section title="Command mode">
        <SettingRow
          title="Edit selection"
          description="Highlight text anywhere, hold this key and say what to do: “make it shorter”, “translate to French”, “turn into bullet points”. Requires a smart formatting model."
        >
          <HotkeyRecorder
            value={h.commandMode}
            onChange={(keys) => void patch({ hotkeys: { commandMode: keys } })}
            platform={platform}
            sideSensitive={h.sideSensitive}
            allowClear
          />
        </SettingRow>
      </Section>

      <Section title="Behavior">
        <SettingRow
          title="Distinguish left and right modifiers"
          description="When off, Right Ctrl matches a shortcut recorded with Left Ctrl. Turn on to bind e.g. Right Ctrl alone."
        >
          <Switch
            checked={h.sideSensitive}
            onCheckedChange={(v) => void patch({ hotkeys: { sideSensitive: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Esc cancels"
          description="Press Escape while listening to throw the recording away."
        >
          <Switch
            checked={h.escapeCancels}
            onCheckedChange={(v) => void patch({ hotkeys: { escapeCancels: v } })}
          />
        </SettingRow>
      </Section>

      <p className="text-meta text-muted-foreground">
        Rules: a shortcut needs a modifier or a function key, at most three keys, and cannot mix
        left and right versions of the same modifier. OS shortcuts like Ctrl+C or Alt+F4 are
        blocked. Middle click and mouse buttons 4+ can be used.
      </p>
    </div>
  )
}
