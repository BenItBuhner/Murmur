import React from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { Slider } from '@renderer/components/ui/slider'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { MicMeter, useMicDevices } from '@renderer/components/MicMeter'
import { useSettings } from '@renderer/hooks/useSettings'

export function AudioPage({ embedded }: { embedded?: boolean }): React.JSX.Element {
  const { settings, patch } = useSettings()
  const a = settings.audio
  const { devices, error } = useMicDevices()

  return (
    <div className="space-y-8">
      {!embedded && (
        <PageHeader
          title="Microphone"
          description="Input device and the timing tricks that make hold-to-talk feel instant."
        />
      )}

      <Section title="Input">
        <SettingRow
          title="Device"
          description={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              'Murmur follows the system default unless you pick one.'
            )
          }
          vertical
        >
          <Select value={a.deviceId} onValueChange={(v) => void patch({ audio: { deviceId: v } })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">System default</SelectItem>
              {devices
                .filter((d) => d.deviceId !== 'default')
                .map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Level"
          description="Speak normally; the bars should move well past the threshold marker."
          vertical
        >
          <MicMeter deviceId={a.deviceId} thresholdDb={a.silenceThresholdDb} className="w-full" />
        </SettingRow>
        <SettingRow
          title="Noise suppression"
          description="Browser-grade noise suppression on the input."
        >
          <Switch
            checked={a.noiseSuppression}
            onCheckedChange={(v) => void patch({ audio: { noiseSuppression: v } })}
          />
        </SettingRow>
        <SettingRow title="Automatic gain" description="Evens out quiet and loud speaking.">
          <Switch
            checked={a.autoGainControl}
            onCheckedChange={(v) => void patch({ audio: { autoGainControl: v } })}
          />
        </SettingRow>
      </Section>

      <Section title="Latency">
        <SettingRow
          title="Keep microphone warm"
          description="Keeps the input open so recording starts the instant you press the key. Your OS will show the mic as in use while Murmur runs."
        >
          <Switch
            checked={a.keepMicWarm}
            onCheckedChange={(v) => void patch({ audio: { keepMicWarm: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Pre-roll"
          description={`Include the ${a.preBufferMs} ms of audio before the key press, so the first word is never clipped. Needs a warm microphone.`}
        >
          <div className="w-52">
            <Slider
              min={0}
              max={1000}
              step={50}
              value={[a.preBufferMs]}
              onValueChange={([v]) => void patch({ audio: { preBufferMs: v } })}
              disabled={!a.keepMicWarm}
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Trim silence"
          description="Cuts leading and trailing silence before upload; smaller files, faster transcripts."
        >
          <Switch
            checked={a.trimSilence}
            onCheckedChange={(v) => void patch({ audio: { trimSilence: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Skip silent recordings"
          description="If you pressed the key but said nothing, nothing is sent and nothing is inserted."
        >
          <Switch
            checked={a.skipIfSilent}
            onCheckedChange={(v) => void patch({ audio: { skipIfSilent: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Speech threshold"
          description={`${a.silenceThresholdDb} dB. Lower is more sensitive. The floor adapts upward automatically in noisy rooms.`}
        >
          <div className="w-52">
            <Slider
              min={-70}
              max={-20}
              step={1}
              value={[a.silenceThresholdDb]}
              onValueChange={([v]) => void patch({ audio: { silenceThresholdDb: v } })}
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Maximum length"
          description="Hands-free sessions stop automatically after this."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={5}
              max={1800}
              className="w-20 text-right"
              value={a.maxDurationSec}
              onChange={(e) =>
                void patch({ audio: { maxDurationSec: Math.max(5, Number(e.target.value)) } })
              }
            />
            <span className="text-sm text-muted-foreground">s</span>
          </div>
        </SettingRow>
      </Section>
    </div>
  )
}
