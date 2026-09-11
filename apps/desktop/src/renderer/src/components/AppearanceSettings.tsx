import React, { useRef, useState } from 'react'
import { Check, Monitor, Pipette } from 'lucide-react'
import type { Accent, Theme } from '@shared/settings'
import { ACCENT_PRESETS, ACCENT_PRESET_IDS, hexToOklch, isHexColor } from '@shared/theme'
import { SettingRow } from '@renderer/components/SettingRow'
import { Input } from '@renderer/components/ui/input'
import { Segmented } from '@renderer/components/ui/misc'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTheme } from '@renderer/hooks/useTheme'
import { cn } from '@renderer/lib/utils'

/**
 * The Appearance rows of the General page: light/dark mode, where the accent colour comes from,
 * and Material You style tinted surfaces. The whole window is the live preview.
 */
export function AppearanceSettings(): React.JSX.Element {
  const { settings, patch, info } = useSettings()
  const { theme, systemAccent } = useTheme()
  const g = settings.general
  const setAccent = (accent: Accent): void => void patch({ general: { accent } })

  return (
    <>
      <SettingRow title="Theme" description="Light, dark, or whatever your system is using.">
        <Segmented<Theme>
          value={g.theme}
          onChange={(v) => void patch({ general: { theme: v } })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </SettingRow>

      <SettingRow
        title="Accent colour"
        description={accentDescription(g.accent, systemAccent, info?.platform)}
        vertical
      >
        <div
          role="radiogroup"
          aria-label="Accent colour"
          className="flex w-full flex-wrap items-center gap-2.5"
        >
          <Swatch
            label="Neutral"
            hint="Murmur's monochrome look"
            selected={g.accent === 'neutral'}
            onSelect={() => setAccent('neutral')}
            className="bg-[linear-gradient(135deg,var(--color-muted)_50%,var(--color-foreground)_50%)]"
          />
          <Swatch
            label="System"
            hint={
              systemAccent
                ? `Follow your system accent (${systemAccent})`
                : 'Follow your system accent (none published right now)'
            }
            selected={g.accent === 'system'}
            onSelect={() => setAccent('system')}
            color={systemAccent ?? undefined}
            className={cn(!systemAccent && 'well text-muted-foreground')}
          >
            {!systemAccent && <Monitor className="size-3.5" />}
          </Swatch>
          {ACCENT_PRESET_IDS.map((id) => (
            <Swatch
              key={id}
              label={ACCENT_PRESETS[id].label}
              selected={g.accent === id}
              onSelect={() => setAccent(id)}
              color={ACCENT_PRESETS[id].seed}
            />
          ))}
          <CustomSwatch
            selected={g.accent === 'custom'}
            color={g.accentColor}
            onPick={(hex) => void patch({ general: { accent: 'custom', accentColor: hex } })}
          />
        </div>
        {g.accent === 'custom' && (
          <HexField
            value={g.accentColor}
            onCommit={(hex) => void patch({ general: { accentColor: hex } })}
          />
        )}
      </SettingRow>

      <SettingRow
        title="Tinted surfaces"
        description={
          theme.seed
            ? 'Material You style: backgrounds, cards and borders take a soft tint of your accent.'
            : 'Pick an accent colour first; neutral surfaces have nothing to tint with.'
        }
      >
        <Switch
          checked={g.tintedSurfaces}
          disabled={!theme.seed}
          onCheckedChange={(v) => void patch({ general: { tintedSurfaces: v } })}
        />
      </SettingRow>
    </>
  )
}

function accentDescription(
  accent: Accent,
  systemAccent: string | null,
  platform: string | undefined
): string {
  if (accent === 'system') {
    if (systemAccent) return `Following your system accent colour, ${systemAccent}.`
    if (platform === 'linux')
      return 'Your desktop is not publishing an accent colour (GNOME 47+ and KDE Plasma do), so Murmur stays neutral until it does.'
    return 'Your system has not published an accent colour yet, so Murmur stays neutral for now.'
  }
  if (accent === 'neutral') return 'Buttons, switches and highlights stay monochrome.'
  if (accent === 'custom')
    return 'Buttons, switches, highlights and the dictation pill use your colour.'
  return `Buttons, switches, highlights and the dictation pill use ${ACCENT_PRESETS[accent].label.toLowerCase()}.`
}

interface SwatchProps {
  label: string
  hint?: string
  selected: boolean
  onSelect: () => void
  color?: string
  className?: string
  children?: React.ReactNode
}

function Swatch({
  label,
  hint,
  selected,
  onSelect,
  color,
  className,
  children
}: SwatchProps): React.JSX.Element {
  const light = color ? hexToOklch(color).l > 0.7 : false
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={hint ?? label}
      onClick={onSelect}
      style={color ? { backgroundColor: color } : undefined}
      className={cn(
        'relative flex size-7 items-center justify-center rounded-full shadow-raised transition-[transform,box-shadow] outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
        className
      )}
    >
      {children}
      {selected && !children && (
        <Check className={cn('size-3.5', light ? 'text-black/80' : 'text-white')} strokeWidth={3} />
      )}
    </button>
  )
}

function CustomSwatch({
  selected,
  color,
  onPick
}: {
  selected: boolean
  color: string
  onPick: (hex: string) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <span className="relative inline-flex">
      <Swatch
        label="Custom"
        hint={selected ? `Custom colour ${color}; click to change` : 'Pick any colour'}
        selected={selected}
        onSelect={() => input.current?.click()}
        color={selected ? color : undefined}
        className={cn(
          !selected &&
            'bg-[conic-gradient(from_180deg,oklch(0.7_0.18_25),oklch(0.8_0.16_90),oklch(0.72_0.16_150),oklch(0.7_0.15_230),oklch(0.65_0.2_300),oklch(0.7_0.18_25))]'
        )}
      >
        {!selected && <Pipette className="size-3.5 text-white drop-shadow" />}
      </Swatch>
      <input
        ref={input}
        type="color"
        aria-label="Custom accent colour"
        tabIndex={-1}
        value={color}
        onChange={(e) => onPick(e.target.value)}
        className="pointer-events-none absolute inset-0 size-7 opacity-0"
      />
    </span>
  )
}

/** Hex entry for people who know the colour they want; commits on blur/Enter once it is valid. */
function HexField({
  value,
  onCommit
}: {
  value: string
  onCommit: (hex: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  // A colour picked with the swatch replaces whatever was being typed.
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  const commit = (): void => {
    const hex = draft.trim().startsWith('#') ? draft.trim() : `#${draft.trim()}`
    if (isHexColor(hex) && hex.toLowerCase() !== value.toLowerCase()) onCommit(hex.toLowerCase())
    else setDraft(value)
  }
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="size-4 rounded-full shadow-raised" style={{ backgroundColor: value }} />
      <Input
        aria-label="Custom accent colour hex"
        className="w-28 font-mono text-note"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <span className="text-meta text-muted-foreground">#rrggbb</span>
    </div>
  )
}
