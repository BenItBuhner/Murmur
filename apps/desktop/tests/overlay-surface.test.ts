import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LimitNotice } from '@shared/limits'
import type { OverlayPhase, OverlayState } from '@shared/types'
import { PILL_SURFACES, pillSurface } from '../src/renderer/src/overlay/surface'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')
const PHASES: OverlayPhase[] = ['idle', 'listening', 'processing', 'success', 'error', 'disabled']

const words: LimitNotice = {
  limit: 'wordsPerWeek',
  plan: 'free',
  planState: 'free',
  used: 503,
  allowed: 500,
  resetsAt: 0,
  upgradeUrl: null,
  accountUrl: null,
  message: "This week's 500 free words are used up."
}

/** Every look the pill takes, including the limit notice and the soft-limit success line. */
const STATES: OverlayState[] = [
  ...PHASES.map((phase) => ({ phase })),
  { phase: 'listening', mode: 'command' },
  { phase: 'listening', locked: true },
  { phase: 'error', message: 'Timed out', retryId: 'entry-1' },
  { phase: 'error', message: words.message, retryId: 'entry-1', limit: words },
  { phase: 'success', limit: { ...words, limit: 'llmTokensPerMonth' } }
]

/** A Tailwind colour utility with an opacity modifier, e.g. `bg-overlay/95`. */
const TRANSLUCENT_SURFACE = /\bbg-[\w-]+\/\d+/

describe('pill surface', () => {
  it('gives every state a solid body colour: no opacity modifier, no translucent fill', () => {
    for (const state of STATES) {
      for (const micError of [false, true]) {
        const classes = pillSurface(state, micError)
        expect(classes, `${state.phase} micError=${micError}`).toMatch(/\bbg-/)
        expect(classes, `${state.phase} micError=${micError}`).not.toMatch(TRANSLUCENT_SURFACE)
        expect(classes).not.toMatch(/backdrop|opacity/)
      }
    }
    for (const surface of Object.values(PILL_SURFACES)) {
      expect(surface).not.toMatch(TRANSLUCENT_SURFACE)
    }
  })

  it('keeps the colours themselves: the overlay tints per state, destructive for a mic fault at rest', () => {
    expect(pillSurface({ phase: 'idle' })).toBe('bg-overlay')
    expect(pillSurface({ phase: 'idle' }, true)).toBe('bg-destructive')
    expect(pillSurface({ phase: 'listening' })).toBe('bg-overlay')
    expect(pillSurface({ phase: 'listening', mode: 'command' })).toBe('bg-overlay-command')
    expect(pillSurface({ phase: 'processing' })).toBe('bg-overlay')
    expect(pillSurface({ phase: 'success' })).toBe('bg-overlay-success')
    expect(pillSurface({ phase: 'success', limit: words })).toBe('bg-overlay-success')
    expect(pillSurface({ phase: 'error' })).toBe('bg-overlay-error')
    // A plan limit is not a fault: the pill keeps its own colour.
    expect(pillSurface({ phase: 'error', limit: words })).toBe('bg-overlay')
    expect(pillSurface({ phase: 'disabled' })).toMatch(/^bg-overlay-disabled\b/)
    // A mic fault only colours the idle bar.
    expect(pillSurface({ phase: 'listening' }, true)).toBe('bg-overlay')
  })

  it('backs those classes with opaque colour tokens and no blur on the pill', () => {
    const css = readFileSync(join(RENDERER, 'styles', 'globals.css'), 'utf8')
    const tokens = [...css.matchAll(/^\s*(--overlay[\w-]*|--destructive):\s*([^;]+);/gm)]
    expect(tokens.length).toBeGreaterThanOrEqual(10)
    for (const [, name, value] of tokens) {
      // An oklch()/rgb() colour with an alpha channel carries a slash; none of these may.
      expect(value, name).not.toMatch(/\//)
      expect(value, name).not.toMatch(/rgba|hsla|transparent/)
    }
    const pillRule = /\.overlay-pill\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(pillRule).not.toMatch(/backdrop-filter|opacity/)
  })

  it('is the only body colour the overlay component applies', () => {
    const source = readFileSync(join(RENDERER, 'overlay', 'Overlay.tsx'), 'utf8')
    expect(source).toContain('pillSurface(state')
    // The body's colour comes from surface.ts alone; the component adds no translucent surface.
    const pill = /className=\{cn\(\s*'overlay-pill[\s\S]*?\)\}/.exec(source)?.[0] ?? ''
    expect(pill).toContain("'overlay-pill")
    expect(pill).not.toMatch(TRANSLUCENT_SURFACE)
    expect(pill).not.toMatch(/backdrop-blur|opacity-/)
  })
})
