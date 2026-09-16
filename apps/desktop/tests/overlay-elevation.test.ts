import { describe, expect, it } from 'vitest'
import type { LimitNotice } from '@shared/limits'
import type { OverlayPhase, OverlayState } from '@shared/types'
import { IDLE_SHADOW, PILL_SHADOW, pillElevation } from '../src/renderer/src/overlay/elevation'

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

describe('pill elevation', () => {
  it('lifts the pill by default: a tight shadow under the idle bar, the overlay shadow and light catch otherwise', () => {
    expect(pillElevation({ phase: 'idle' }, true)).toBe(IDLE_SHADOW)
    for (const state of STATES.filter((s) => s.phase !== 'idle')) {
      expect(pillElevation(state, true)).toBe(PILL_SHADOW)
    }
    // The light catch is part of the lifted look, not a separate mark.
    expect(PILL_SHADOW).toContain('inset_0_1px_0')
    expect(IDLE_SHADOW).not.toContain('inset')
  })

  it('draws every state flat when the button shadow is off: no shadow class, so no shadow and no light catch', () => {
    for (const state of STATES) {
      const classes = pillElevation(state, false)
      expect(classes).toBe('')
      expect(classes).not.toMatch(/shadow/)
      expect(classes).not.toMatch(/inset/)
    }
  })
})
