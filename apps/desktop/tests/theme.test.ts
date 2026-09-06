import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  ACCENT_PRESET_IDS,
  THEME_TOKENS,
  buildTheme,
  harmonizeHue,
  hexToOklch,
  hueDelta,
  isHexColor,
  oklchToHex,
  parseElectronAccent,
  parseGnomeAccent,
  parseKdeAccent,
  resolveSeed,
  toneToLightness
} from '@shared/theme'

function channels(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

describe('oklch conversions', () => {
  it('round-trips sRGB colours through OKLCH within a rounding step', () => {
    for (const hex of [
      '#ff5a36',
      '#3b82f6',
      '#000000',
      '#ffffff',
      '#808080',
      '#2fa84f',
      '#ec4899'
    ]) {
      const back = oklchToHex(hexToOklch(hex))
      const a = channels(hex)
      const b = channels(back)
      for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1)
    }
  })

  it('places known colours where OKLCH says they belong', () => {
    const white = hexToOklch('#ffffff')
    expect(white.l).toBeCloseTo(1, 2)
    expect(white.c).toBe(0)
    const black = hexToOklch('#000000')
    expect(black.l).toBeCloseTo(0, 2)
    // Murmur's coral is a light, saturated red-orange.
    const coral = hexToOklch('#ff5a36')
    expect(coral.l).toBeGreaterThan(0.6)
    expect(coral.c).toBeGreaterThan(0.18)
    expect(coral.h).toBeGreaterThan(25)
    expect(coral.h).toBeLessThan(45)
    // Blue sits around 260 degrees.
    expect(hexToOklch('#3b82f6').h).toBeGreaterThan(240)
    expect(hexToOklch('#3b82f6').h).toBeLessThan(275)
  })

  it('clips out-of-gamut colours by dropping chroma, keeping the hue', () => {
    const hex = oklchToHex({ l: 0.6, c: 0.4, h: 150 })
    expect(isHexColor(hex)).toBe(true)
    const back = hexToOklch(hex)
    expect(Math.abs(hueDelta(back.h, 150))).toBeLessThan(2)
    expect(back.c).toBeLessThan(0.4)
    expect(back.c).toBeGreaterThan(0.1)
  })

  it('maps Material tones onto OKLCH lightness linearly', () => {
    expect(toneToLightness(100)).toBe(1)
    expect(toneToLightness(40)).toBeCloseTo(56 / 116, 5)
    expect(toneToLightness(0)).toBeGreaterThanOrEqual(0)
    // A tone-50 grey really is L* 50.
    const grey = oklchToHex({ l: toneToLightness(50), c: 0, h: 0 })
    expect(channels(grey)[0]).toBeGreaterThan(115)
    expect(channels(grey)[0]).toBeLessThan(125)
  })
})

describe('hue helpers', () => {
  it('measures the shortest signed distance', () => {
    expect(hueDelta(350, 10)).toBe(20)
    expect(hueDelta(10, 350)).toBe(-20)
    expect(hueDelta(0, 180)).toBe(-180)
  })

  it('harmonizes at most a few degrees toward the seed', () => {
    expect(harmonizeHue(25, null)).toBe(25)
    expect(harmonizeHue(25, 30)).toBeCloseTo(27.5)
    expect(harmonizeHue(25, 260)).toBeCloseTo(13) // 12 degree cap, toward 260 the short way round
    expect(harmonizeHue(150, 35)).toBeCloseTo(138)
  })
})

describe('buildTheme', () => {
  it('produces every token as a CSS colour and a hex in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = buildTheme({ mode, seed: '#3b82f6', tinted: true })
      for (const token of THEME_TOKENS) {
        expect(t.vars[token]).toMatch(/^oklch\(/)
        expect(isHexColor(t.hex[token])).toBe(true)
      }
    }
  })

  it('reproduces the original neutral palette when there is no seed', () => {
    const light = buildTheme({ mode: 'light', seed: null, tinted: true })
    expect(light.vars.background).toBe('oklch(0.985 0.002 90)')
    expect(light.vars.primary).toBe('oklch(0.22 0.01 60)')
    expect(light.vars.card).toBe('oklch(1 0 0)')
    expect(light.tinted).toBe(false)
    const dark = buildTheme({ mode: 'dark', seed: null, tinted: false })
    expect(dark.vars.background).toBe('oklch(0.16 0.004 60)')
    expect(dark.vars.primary).toBe('oklch(0.93 0.004 80)')
    expect(dark.vars.sidebar).toBe('oklch(0.14 0.004 60)')
  })

  it('colours the primary role from the seed and keeps its foreground legible', () => {
    const light = buildTheme({ mode: 'light', seed: '#3b82f6', tinted: false })
    expect(Math.abs(hueDelta(light.colors.primary.h, hexToOklch('#3b82f6').h))).toBeLessThan(1)
    expect(light.colors.primary.c).toBeGreaterThan(0.09)
    // Light mode: mid-lightness primary, white text on it.
    expect(light.colors.primary.l).toBeLessThan(0.62)
    expect(light.colors['primary-foreground'].l).toBeGreaterThan(0.95)
    // Dark mode: light primary, dark tinted text on it (Material's tone 80 / tone 20).
    const dark = buildTheme({ mode: 'dark', seed: '#3b82f6', tinted: false })
    expect(dark.colors.primary.l).toBeGreaterThan(0.7)
    expect(dark.colors['primary-foreground'].l).toBeLessThan(0.3)
    expect(dark.colors.ring.h).toBeCloseTo(dark.colors.primary.h, 3)
  })

  it('tints surfaces only when asked, and only with a seed', () => {
    const neutral = buildTheme({ mode: 'light', seed: '#ec4899', tinted: false })
    expect(neutral.colors.background.c).toBeLessThan(0.005)
    expect(neutral.colors.background.h).toBe(90)
    const tinted = buildTheme({ mode: 'light', seed: '#ec4899', tinted: true })
    expect(tinted.colors.background.c).toBeGreaterThan(0.005)
    expect(Math.abs(hueDelta(tinted.colors.background.h, hexToOklch('#ec4899').h))).toBeLessThan(1)
    expect(Math.abs(hueDelta(tinted.colors.overlay.h, hexToOklch('#ec4899').h))).toBeLessThan(1)
    // Tinted surfaces stay surfaces: barely any chroma, lightness untouched.
    expect(tinted.colors.background.c).toBeLessThan(0.03)
    expect(tinted.colors.background.l).toBe(neutral.colors.background.l)
  })

  it('keeps a grey seed grey instead of inventing a colour', () => {
    const t = buildTheme({ mode: 'light', seed: '#808080', tinted: true })
    expect(t.colors.primary.c).toBeLessThan(0.04)
  })

  it('harmonizes status colours toward the seed without changing their meaning', () => {
    const neutral = buildTheme({ mode: 'light', seed: null, tinted: false })
    const themed = buildTheme({ mode: 'light', seed: '#3b82f6', tinted: false })
    const shift = Math.abs(hueDelta(neutral.colors.success.h, themed.colors.success.h))
    expect(shift).toBeGreaterThan(0)
    expect(shift).toBeLessThanOrEqual(12)
    expect(themed.colors.record.h).toBeGreaterThan(20)
    expect(themed.colors.record.h).toBeLessThan(50)
  })

  it('spreads the chart colours around the seed hue', () => {
    const t = buildTheme({ mode: 'light', seed: '#2fa84f', tinted: false })
    const hues = [1, 2, 3, 4, 5].map((i) => t.colors[`chart-${i}` as const].h)
    expect(Math.abs(hueDelta(hues[0], hexToOklch('#2fa84f').h))).toBeLessThan(1)
    for (let i = 1; i < hues.length; i++) {
      expect(Math.abs(hueDelta(hues[i - 1], hues[i]))).toBeCloseTo(55, 3)
    }
  })

  it('ignores garbage seeds', () => {
    const t = buildTheme({ mode: 'dark', seed: 'not a colour', tinted: true })
    expect(t.seed).toBeNull()
    expect(t.vars.primary).toBe('oklch(0.93 0.004 80)')
  })
})

describe('resolveSeed', () => {
  it('follows the accent choice', () => {
    expect(resolveSeed({ accent: 'neutral', accentColor: '#ff0000' }, '#3b82f6')).toBeNull()
    expect(resolveSeed({ accent: 'system', accentColor: '#ff0000' }, '#3B82F6')).toBe('#3b82f6')
    expect(resolveSeed({ accent: 'system', accentColor: '#ff0000' }, null)).toBeNull()
    expect(resolveSeed({ accent: 'custom', accentColor: '#FF0000' }, '#3b82f6')).toBe('#ff0000')
    expect(resolveSeed({ accent: 'custom', accentColor: 'nope' }, '#3b82f6')).toBeNull()
    for (const id of ACCENT_PRESET_IDS) {
      expect(resolveSeed({ accent: id, accentColor: '' }, null)).toBe(ACCENT_PRESETS[id].seed)
    }
  })
})

describe('system accent parsers', () => {
  it('reads Electron RRGGBBAA values', () => {
    expect(parseElectronAccent('0078D7FF')).toBe('#0078d7')
    expect(parseElectronAccent('#0078d7')).toBe('#0078d7')
    expect(parseElectronAccent('')).toBeNull()
    expect(parseElectronAccent(undefined)).toBeNull()
    expect(parseElectronAccent('nope')).toBeNull()
  })

  it('maps GNOME accent names', () => {
    expect(parseGnomeAccent("'blue'\n")).toBe('#3584e4')
    expect(parseGnomeAccent('purple')).toBe('#9141ac')
    expect(parseGnomeAccent("'no-such-colour'")).toBeNull()
    expect(parseGnomeAccent(null)).toBeNull()
  })

  it('reads the KDE accent from kdeglobals', () => {
    const kdeglobals = [
      '[ColorEffects:Disabled]',
      'AccentColor=1,2,3',
      '',
      '[General]',
      'ColorScheme=BreezeDark',
      'AccentColor=61,174,233',
      '',
      '[Icons]',
      'Theme=breeze'
    ].join('\n')
    expect(parseKdeAccent(kdeglobals)).toBe('#3daee9')
    expect(parseKdeAccent('[General]\nColorScheme=Breeze\n')).toBeNull()
    expect(parseKdeAccent('')).toBeNull()
  })
})
