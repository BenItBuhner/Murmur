import React from 'react'
import { AppearanceSettings } from '@renderer/components/AppearanceSettings'
import { Switch } from '@renderer/components/ui/switch'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { useSettings } from '@renderer/hooks/useSettings'

/** Light or dark, the accent, and the few details of how the app draws itself; the Android app's Appearance page. */
export function AppearancePage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const g = settings.general

  return (
    <div className="space-y-section">
      <PageHeader
        title="Appearance"
        description="Light or dark, and where the palette comes from: your system's accent, or one of your choice."
      />

      <Section title="Theme">
        <AppearanceSettings />
      </Section>

      <Section title="Details">
        <SettingRow
          title="Show latency in history"
          description="Per-stage timing bars on Home and History."
        >
          <Switch
            checked={g.showLatencyInHistory}
            onCheckedChange={(v) => void patch({ general: { showLatencyInHistory: v } })}
          />
        </SettingRow>
      </Section>
    </div>
  )
}
