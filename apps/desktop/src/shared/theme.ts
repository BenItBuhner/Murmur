/**
 * Murmur's colour engine. Every design token the UI uses is derived here from three inputs:
 *
 *  - the *mode* (light or dark),
 *  - an optional *seed* colour (the accent: the OS accent colour, a preset, or a custom hex), and
 *  - whether surfaces should be *tinted* with the seed's hue (Material You style tonal surfaces)
 *    or stay neutral grey.
 *
 * Colours are computed in OKLCH so lightness and chroma stay perceptually consistent across hues;
 * the same maths (and the same Material tone table) is mirrored in the Android app so a seed colour
 * yields the same palette on both platforms. Pure functions only: this file is shared by the main
 * process, both renderers and the tests.
 */

// ---- OKLCH maths -----------------------------------------------------------------------------

export interface Oklch {
  /** 0 (black) .. 1 (white) */
  l: number
  /** 0 (grey) .. ~0.4 (most saturated sRGB colours reach ~0.3) */
  c: number
  /** Hue in degrees, 0..360 */
  h: number
}

const HEX_RE = /^#?([0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

export function normalizeHex(value: string): string {
  const m = HEX_RE.exec(value.trim())
  if (!m) throw new Error(`Not a #rrggbb colour: ${value}`)
  return `#${m[1].toLowerCase()}`
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(normalizeHex(hex).slice(1), 16)
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** OKLab -> linear sRGB, unclamped (values outside 0..1 mean "out of gamut"). */
function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex)
  const [L, a, bb] = rgbToOklab(r, g, b)
  const c = Math.sqrt(a * a + bb * bb)
  let h = (Math.atan2(bb, a) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c: c < 1e-4 ? 0 : c, h: c < 1e-4 ? 0 : h }
}

function inGamut(rgb: [number, number, number]): boolean {
  const eps = 1e-4
  return rgb.every((v) => v >= -eps && v <= 1 + eps)
}

/**
 * OKLCH -> sRGB hex. Colours the display cannot show keep their lightness and hue and lose chroma
 * until they fit, which is what keeps a vivid seed from turning into a clipped neon.
 */
export function oklchToHex({ l, c, h }: Oklch): string {
  const L = Math.min(1, Math.max(0, l))
  const rad = (h * Math.PI) / 180
  const toRgb = (chroma: number): [number, number, number] =>
    oklabToLinearRgb(L, chroma * Math.cos(rad), chroma * Math.sin(rad))
  let rgb = toRgb(c)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(toRgb(mid))) lo = mid
      else hi = mid
    }
    rgb = toRgb(lo)
  }
  return rgbToHex(linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2]))
}

/** CSS `oklch()` string with sane precision. */
export function oklchCss({ l, c, h }: Oklch): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)})`
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits)
  return Math.round(n * f) / f
}

function norm(h: number): number {
  return ((h % 360) + 360) % 360
}

/** Signed shortest angular distance from `from` to `to`, in degrees. */
export function hueDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/**
 * Material's "harmonize": nudge a fixed semantic hue (red for errors, green for success) part of
 * the way toward the seed so status colours feel like they belong to the palette without losing
 * their meaning. At most `maxShift` degrees.
 */
export function harmonizeHue(hue: number, toward: number | null, maxShift = 12): number {
  if (toward === null) return norm(hue)
  const delta = hueDelta(hue, toward)
  const shift = Math.sign(delta) * Math.min(Math.abs(delta) * 0.5, maxShift)
  return norm(hue + shift)
}

/**
 * Material 3 tone (0..100, the CIELAB L* of the colour) -> OKLCH lightness. For neutral colours
 * OKLab L is exactly the cube root of luminance, and L* = 116 * cbrt(Y) - 16, so the mapping is
 * linear. This lets both apps speak in Material's tone table.
 */
export function toneToLightness(tone: number): number {
  return Math.min(1, Math.max(0, (tone + 16) / 116))
}

// ---- Accent presets -------------------------------------------------------------------------

export const ACCENT_PRESET_IDS = [
  'coral',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink'
] as const
export type AccentPreset = (typeof ACCENT_PRESET_IDS)[number]

/** Seed colours for the presets; the palette is derived from these, they are not used verbatim. */
export const ACCENT_PRESETS: Record<AccentPreset, { label: string; seed: string }> = {
  coral: { label: 'Coral', seed: '#ff5a36' },
  amber: { label: 'Amber', seed: '#f59e0b' },
  green: { label: 'Green', seed: '#2fa84f' },
  teal: { label: 'Teal', seed: '#14b8a6' },
  blue: { label: 'Blue', seed: '#3b82f6' },
  indigo: { label: 'Indigo', seed: '#6366f1' },
  violet: { label: 'Violet', seed: '#8b5cf6' },
  pink: { label: 'Pink', seed: '#ec4899' }
}

export type AccentChoice = 'neutral' | 'system' | AccentPreset | 'custom'

export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark'
  accent: AccentChoice
  /** Seed for the `custom` accent, `#rrggbb`. */
  accentColor: string
  /** Material You style: backgrounds, cards and borders carry a soft tint of the accent hue. */
  tintedSurfaces: boolean
}

/**
 * Which seed colour the palette should grow from. `null` means neutral (monochrome primary, grey
 * surfaces). "System" falls back to neutral when the desktop does not publish an accent colour.
 */
export function resolveSeed(
  appearance: Pick<AppearanceSettings, 'accent' | 'accentColor'>,
  systemAccent: string | null
): string | null {
  switch (appearance.accent) {
    case 'neutral':
      return null
    case 'system':
      return systemAccent && isHexColor(systemAccent) ? normalizeHex(systemAccent) : null
    case 'custom':
      return isHexColor(appearance.accentColor) ? normalizeHex(appearance.accentColor) : null
    default:
      return ACCENT_PRESETS[appearance.accent]?.seed ?? null
  }
}

// ---- Palette ---------------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark'

export const THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'sidebar',
  'record',
  'success',
  'warning',
  'info',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  // The floating pill is always dark; these keep it in the palette's family.
  'overlay',
  'overlay-foreground',
  'overlay-command',
  'overlay-command-foreground',
  'overlay-success',
  'overlay-success-foreground',
  'overlay-error',
  'overlay-error-foreground',
  'overlay-disabled'
] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]

export interface ThemeInput {
  mode: ThemeMode
  /** `#rrggbb` accent seed, or `null` for the neutral palette. */
  seed: string | null
  tinted: boolean
}

export interface ResolvedTheme {
  mode: ThemeMode
  seed: string | null
  tinted: boolean
  /** Token -> OKLCH colour. */
  colors: Record<ThemeToken, Oklch>
  /** Token -> CSS `oklch()` string, ready for `--token` custom properties. */
  vars: Record<ThemeToken, string>
  /** Token -> `#rrggbb`, for consumers that cannot take CSS colours (window chrome, Clerk). */
  hex: Record<ThemeToken, string>
}

const WHITE: Oklch = { l: 1, c: 0, h: 0 }

function ok(l: number, c: number, h: number): Oklch {
  return { l, c, h: norm(h) }
}

/** Chroma the primary role gets from a seed: vivid enough to read as a colour, never neon. */
function primaryChroma(seed: Oklch): number {
  if (seed.c < 0.04) return seed.c // a grey seed stays grey on purpose
  return Math.min(0.19, Math.max(0.1, seed.c))
}

/**
 * Build the full token set. When there is no seed the result reproduces Murmur's original neutral
 * look exactly, so existing installs see no change until they pick an accent.
 */
export function buildTheme(input: ThemeInput): ResolvedTheme {
  const { mode } = input
  const seedHex = input.seed && isHexColor(input.seed) ? normalizeHex(input.seed) : null
  const seed = seedHex ? hexToOklch(seedHex) : null
  const tinted = !!seed && input.tinted
  const h = seed?.h ?? 0
  const pc = seed ? primaryChroma(seed) : 0
  const dark = mode === 'dark'

  // Surfaces: tinted palettes carry the seed hue at a whisper of chroma; neutral ones keep the
  // warm grey Murmur shipped with.
  const surf = (l: number, cNeutral: number, cTint: number, hNeutral: number): Oklch =>
    tinted ? ok(l, cTint, h) : ok(l, cNeutral, hNeutral)
  // Semantic hues lean slightly toward the seed (Material's harmonization).
  const hz = (hue: number): number => harmonizeHue(hue, seed ? h : null)

  const c = {} as Record<ThemeToken, Oklch>
  if (!dark) {
    c.background = surf(0.985, 0.002, 0.008, 90)
    c.foreground = surf(0.2, 0.01, 0.02, 60)
    c.card = tinted ? ok(0.998, 0.003, h) : WHITE
    c['card-foreground'] = c.foreground
    c.popover = c.card
    c['popover-foreground'] = c.foreground
    c.secondary = surf(0.955, 0.004, 0.018, 80)
    c['secondary-foreground'] = surf(0.25, 0.01, 0.03, 60)
    c.muted = c.secondary
    c['muted-foreground'] = surf(0.5, 0.01, 0.03, 60)
    c.accent = surf(0.94, 0.005, 0.028, 80)
    c['accent-foreground'] = surf(0.22, 0.01, 0.03, 60)
    c.border = surf(0.9, 0.005, 0.02, 80)
    c.input = c.border
    c.sidebar = surf(0.965, 0.003, 0.012, 85)
    c.primary = seed ? ok(0.55, pc, h) : ok(0.22, 0.01, 60)
    c['primary-foreground'] = seed ? WHITE : ok(0.985, 0.002, 90)
    c.ring = seed ? ok(0.6, pc * 0.9, h) : ok(0.55, 0.02, 60)
    c.destructive = ok(0.6, 0.2, hz(25))
    c.record = ok(0.68, 0.21, hz(35))
    c.success = ok(0.65, 0.16, hz(150))
    c.warning = ok(0.75, 0.16, hz(75))
    c.info = ok(0.62, 0.16, hz(250))
  } else {
    c.background = surf(0.16, 0.004, 0.012, 60)
    c.foreground = surf(0.93, 0.004, 0.008, 80)
    c.card = surf(0.2, 0.005, 0.014, 60)
    c['card-foreground'] = c.foreground
    c.popover = surf(0.21, 0.005, 0.014, 60)
    c['popover-foreground'] = c.foreground
    c.secondary = surf(0.26, 0.005, 0.016, 60)
    c['secondary-foreground'] = c.foreground
    c.muted = surf(0.25, 0.005, 0.016, 60)
    c['muted-foreground'] = surf(0.68, 0.008, 0.02, 70)
    c.accent = surf(0.27, 0.006, 0.02, 60)
    c['accent-foreground'] = c.foreground
    c.border = surf(0.28, 0.006, 0.016, 60)
    c.input = surf(0.3, 0.006, 0.016, 60)
    c.sidebar = surf(0.14, 0.004, 0.012, 60)
    c.primary = seed ? ok(0.78, pc * 0.8, h) : ok(0.93, 0.004, 80)
    c['primary-foreground'] = seed ? ok(0.22, Math.min(0.05, pc * 0.4), h) : ok(0.18, 0.005, 60)
    c.ring = seed ? ok(0.72, pc * 0.7, h) : ok(0.6, 0.01, 60)
    c.destructive = ok(0.62, 0.19, hz(25))
    c.record = ok(0.7, 0.2, hz(35))
    c.success = ok(0.7, 0.15, hz(150))
    c.warning = ok(0.8, 0.15, hz(75))
    c.info = ok(0.7, 0.14, hz(250))
  }
  c['destructive-foreground'] = ok(0.985, 0, 0)

  // Latency-bar segments: analogous hues around the seed, or the fixed set from the neutral look.
  if (seed) {
    const l = dark ? 0.72 : 0.66
    ;[0, 55, 110, 165, 220].forEach((d, i) => {
      c[`chart-${i + 1}` as ThemeToken] = ok(l, 0.14, h + d)
    })
  } else {
    c['chart-1'] = ok(0.71, 0.01, 56)
    c['chart-2'] = ok(0.62, 0.21, 260)
    c['chart-3'] = ok(0.7, 0.15, 162)
    c['chart-4'] = ok(0.61, 0.22, 293)
    c['chart-5'] = ok(0.77, 0.16, 70)
  }

  // The pill floats over other apps and stays dark in both modes; the seed tints it.
  c.overlay = tinted ? ok(0.2, 0.02, h) : ok(0.18, 0, 0)
  c['overlay-foreground'] = WHITE
  c['overlay-command'] = seed ? ok(0.27, 0.06, h) : ok(0.24, 0.06, 290)
  c['overlay-command-foreground'] = seed
    ? ok(0.82, Math.max(0.08, pc * 0.6), h)
    : ok(0.72, 0.16, 293)
  c['overlay-success'] = ok(0.25, 0.05, hz(150))
  c['overlay-success-foreground'] = ok(0.84, 0.12, hz(155))
  c['overlay-error'] = ok(0.26, 0.07, hz(25))
  c['overlay-error-foreground'] = ok(0.78, 0.13, hz(30))
  c['overlay-disabled'] = ok(0.3, 0, 0)

  const vars = {} as Record<ThemeToken, string>
  const hex = {} as Record<ThemeToken, string>
  for (const token of THEME_TOKENS) {
    vars[token] = oklchCss(c[token])
    hex[token] = oklchToHex(c[token])
  }
  return { mode, seed: seedHex, tinted, colors: c, vars, hex }
}

// ---- System accent parsing ----------------------------------------------------------------------

/** Electron's `systemPreferences.getAccentColor()` returns `RRGGBBAA` without a hash. */
export function parseElectronAccent(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim())
  return m ? `#${m[1].toLowerCase()}` : null
}

/** libadwaita accent colours (`org.gnome.desktop.interface accent-color`, GNOME 47+). */
const GNOME_ACCENTS: Record<string, string> = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396'
}

export function parseGnomeAccent(output: string | null | undefined): string | null {
  if (!output) return null
  const name = output
    .trim()
    .replace(/^'+|'+$/g, '')
    .toLowerCase()
  return GNOME_ACCENTS[name] ?? null
}

/** `AccentColor=r,g,b` from the `[General]` section of KDE's `kdeglobals`. */
export function parseKdeAccent(contents: string | null | undefined): string | null {
  if (!contents) return null
  let inGeneral = false
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inGeneral = line === '[General]'
      continue
    }
    if (!inGeneral) continue
    const m = /^AccentColor\s*=\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(line)
    if (!m) continue
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)))
    return rgbToHex(r / 255, g / 255, b / 255)
  }
  return null
}
