import React from 'react'
import type { OverlayPosition } from '@shared/settings'
import { Switch } from '@renderer/components/ui/switch'
import { Slider } from '@renderer/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { useSettings } from '@renderer/hooks/useSettings'

/**
 * The listening pill: where it sits, how it is drawn and what it sounds like. The same page the
 * Android app has under Settings, with the rows this platform has.
 */
export function DictationButtonPage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const g = settings.general

  return (
    <div className="space-y-section">
      <PageHeader
        title="Dictation button"
        description="The pill that appears while you dictate. Choose where it sits, how it floats and whether it makes a sound."
      />

      <Section title="Position">
        <SettingRow
          title="Overlay position"
          description="Where the listening pill appears on the screen with your cursor."
        >
          <Select
            value={g.overlayPosition}
            onValueChange={(v) =>
              void patch({ general: { overlayPosition: v as OverlayPosition } })
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bottom-center">Bottom center</SelectItem>
              <SelectItem value="top-center">Top center</SelectItem>
              <SelectItem value="bottom-right">Bottom right</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Show idle indicator"
          description="A small bar stays visible when Murmur is ready, so you always know it is running."
        >
          <Switch
            checked={g.showOverlayWhenIdle}
            onCheckedChange={(v) => void patch({ general: { showOverlayWhenIdle: v } })}
          />
        </SettingRow>
      </Section>

      <Section title="Look">
        <SettingRow
          title="Button shadow"
          description="The pill floats with a soft shadow and a light catch on its top edge. Off, it sits flat."
        >
          <Switch
            checked={g.buttonShadow}
            onCheckedChange={(v) => void patch({ general: { buttonShadow: v } })}
          />
        </SettingRow>
      </Section>

      <Section title="Feedback">
        <SettingRow title="Sounds" description="Soft cues when recording starts, stops, or fails.">
          <div className="flex items-center gap-4">
            {g.sounds && (
              <Slider
                className="w-28"
                min={0}
                max={1}
                step={0.05}
                value={[g.soundVolume]}
                onValueChange={([v]) => void patch({ general: { soundVolume: v } })}
              />
            )}
            <Switch
              checked={g.sounds}
              onCheckedChange={(v) => void patch({ general: { sounds: v } })}
            />
          </div>
        </SettingRow>
      </Section>
    </div>
  )
}
