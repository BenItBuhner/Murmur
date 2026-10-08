import React from 'react'
import type { OverlayPosition } from '@shared/settings'
import { OVERLAY_BAR_HEIGHT, OVERLAY_BAR_WIDTH } from '@shared/overlay-bar'
import { Button } from '@renderer/components/ui/button'
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
        description="The pill that appears while you dictate. Drag the bar to move it, drag its edges to resize it, and choose how it floats."
      />

      <Section title="Position">
        <SettingRow
          title="Overlay position"
          description={
            g.overlayBar.anchor === 'free'
              ? 'The bar is where you dragged it. Choose a preset to snap it back, or drag it again.'
              : 'Where the listening pill appears. Drag the bar itself to place it anywhere else.'
          }
        >
          <Select
            value={g.overlayBar.anchor === 'free' ? 'custom' : g.overlayPosition}
            onValueChange={(v) => {
              if (v === 'custom') return
              void patch({
                general: {
                  overlayPosition: v as OverlayPosition,
                  overlayBar: { ...g.overlayBar, anchor: 'preset' }
                }
              })
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {g.overlayBar.anchor === 'free' && (
                <SelectItem value="custom">Custom</SelectItem>
              )}
              <SelectItem value="bottom-center">Bottom center</SelectItem>
              <SelectItem value="top-center">Top center</SelectItem>
              <SelectItem value="bottom-right">Bottom right</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Bar width"
          description="How wide the idle bar is. The listening pill still grows to fit what it has to say."
        >
          <div className="flex w-44 items-center gap-3">
            <Slider
              min={OVERLAY_BAR_WIDTH.min}
              max={OVERLAY_BAR_WIDTH.max}
              step={2}
              value={[g.overlayBar.width]}
              onValueChange={([v]) =>
                void patch({ general: { overlayBar: { ...g.overlayBar, width: v ?? g.overlayBar.width } } })
              }
            />
            <span className="w-8 text-right text-note tabular-nums text-muted-foreground">
              {g.overlayBar.width}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          title="Bar height"
          description="How tall the idle bar is. Drag the bar's top or bottom edge to change it too."
        >
          <div className="flex w-44 items-center gap-3">
            <Slider
              min={OVERLAY_BAR_HEIGHT.min}
              max={OVERLAY_BAR_HEIGHT.max}
              step={1}
              value={[g.overlayBar.height]}
              onValueChange={([v]) =>
                void patch({
                  general: { overlayBar: { ...g.overlayBar, height: v ?? g.overlayBar.height } }
                })
              }
            />
            <span className="w-8 text-right text-note tabular-nums text-muted-foreground">
              {g.overlayBar.height}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          title="Reset the bar"
          description="Back to the centered bar at the bottom, at its original size."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void patch({
                general: {
                  overlayPosition: 'bottom-center',
                  overlayBar: { anchor: 'preset', x: 0.5, y: 0.5, width: 56, height: 6 }
                }
              })
            }
          >
            Reset
          </Button>
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
