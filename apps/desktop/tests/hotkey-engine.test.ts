import { describe, expect, it } from 'vitest'
import { HotkeyEngine, type HotkeyEngineConfig } from '@core/hotkey/engine'
import { Key, chordLabel, electronAccelerator, validateChord } from '@core/hotkey/keys'

const base: HotkeyEngineConfig = {
  pushToTalk: [Key.Ctrl, Key.Meta],
  handsFree: [Key.Ctrl, Key.Meta, Key.Space],
  commandMode: [Key.Alt, Key.Meta],
  handsFreeTrigger: 'tap',
  tapThresholdMs: 350,
  doubleTapWindowMs: 400,
  sideSensitive: false,
  escapeCancels: true
}

function make(overrides: Partial<HotkeyEngineConfig> = {}): HotkeyEngine {
  return new HotkeyEngine({ ...base, ...overrides })
}

describe('HotkeyEngine: push-to-talk hold', () => {
  it('starts on chord press and stops on release after the tap threshold', () => {
    const e = make()
    expect(e.keyDown(Key.Ctrl, 0)).toEqual([])
    expect(e.keyDown(Key.Meta, 10)).toEqual([{ type: 'start', mode: 'hold' }])
    expect(e.isListening).toBe(true)
    expect(e.keyUp(Key.Meta, 1200)).toEqual([{ type: 'stop' }])
    expect(e.keyUp(Key.Ctrl, 1210)).toEqual([])
    expect(e.isListening).toBe(false)
  })

  it('ignores OS key-repeat keydown events', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    expect(e.keyDown(Key.Meta, 10)).toHaveLength(1)
    expect(e.keyDown(Key.Meta, 40)).toEqual([])
    expect(e.keyDown(Key.Ctrl, 41)).toEqual([])
    expect(e.keyDown(Key.Meta, 80)).toEqual([])
  })

  it('accepts right-hand modifiers when not side sensitive', () => {
    const e = make()
    e.keyDown(Key.CtrlRight, 0)
    expect(e.keyDown(Key.MetaRight, 5)).toEqual([{ type: 'start', mode: 'hold' }])
    expect(e.keyUp(Key.CtrlRight, 900)).toEqual([{ type: 'stop' }])
  })

  it('distinguishes sides when side sensitive', () => {
    const e = make({ sideSensitive: true, pushToTalk: [Key.CtrlRight] })
    expect(e.keyDown(Key.Ctrl, 0)).toEqual([])
    expect(e.keyDown(Key.CtrlRight, 1)).toEqual([{ type: 'start', mode: 'hold' }])
  })

  it('releasing a key that is not part of the chord does nothing', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    e.keyDown(Key.A, 500)
    expect(e.keyUp(Key.A, 600)).toEqual([])
    expect(e.isListening).toBe(true)
  })
})

describe('HotkeyEngine: tap -> hands-free (default)', () => {
  it('quick tap locks the session, next press stops it', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    expect(e.keyDown(Key.Meta, 1)).toEqual([{ type: 'start', mode: 'hold' }])
    expect(e.keyUp(Key.Meta, 200)).toEqual([{ type: 'lock' }])
    expect(e.keyUp(Key.Ctrl, 210)).toEqual([])
    expect(e.isLocked).toBe(true)
    // ...user speaks for a while...
    e.keyDown(Key.Ctrl, 9000)
    expect(e.keyDown(Key.Meta, 9001)).toEqual([{ type: 'stop' }])
    expect(e.keyUp(Key.Meta, 9100)).toEqual([])
    expect(e.keyUp(Key.Ctrl, 9101)).toEqual([])
    expect(e.isListening).toBe(false)
  })

  it('a press right after a stop starts a fresh hold session', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    e.keyUp(Key.Meta, 100) // lock
    e.keyUp(Key.Ctrl, 101)
    e.keyDown(Key.Ctrl, 3000)
    e.keyDown(Key.Meta, 3001) // stop
    e.keyUp(Key.Meta, 3050)
    e.keyUp(Key.Ctrl, 3051)
    e.keyDown(Key.Ctrl, 4000)
    expect(e.keyDown(Key.Meta, 4001)).toEqual([{ type: 'start', mode: 'hold' }])
  })
})

describe('HotkeyEngine: double-tap trigger (Wispr Flow parity)', () => {
  it('single quick tap stops; second tap inside the window starts a locked session', () => {
    const e = make({ handsFreeTrigger: 'double-tap' })
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    expect(e.keyUp(Key.Meta, 150)).toEqual([{ type: 'stop' }])
    e.keyUp(Key.Ctrl, 160)
    e.keyDown(Key.Ctrl, 300)
    expect(e.keyDown(Key.Meta, 301)).toEqual([{ type: 'start', mode: 'hands-free' }])
    expect(e.keyUp(Key.Meta, 400)).toEqual([])
    expect(e.isLocked).toBe(true)
  })

  it('second tap outside the window is a normal hold', () => {
    const e = make({ handsFreeTrigger: 'double-tap' })
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    e.keyUp(Key.Meta, 150)
    e.keyUp(Key.Ctrl, 160)
    e.keyDown(Key.Ctrl, 2000)
    expect(e.keyDown(Key.Meta, 2001)).toEqual([{ type: 'start', mode: 'hold' }])
  })
})

describe('HotkeyEngine: trigger off', () => {
  it('quick tap just stops', () => {
    const e = make({ handsFreeTrigger: 'off' })
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    expect(e.keyUp(Key.Ctrl, 100)).toEqual([{ type: 'stop' }])
  })
})

describe('HotkeyEngine: dedicated hands-free chord', () => {
  it('toggles a locked session on press', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1) // starts hold (subset chord)
    expect(e.keyDown(Key.Space, 2)).toEqual([{ type: 'lock' }])
    expect(e.keyUp(Key.Space, 100)).toEqual([])
    expect(e.keyUp(Key.Meta, 101)).toEqual([])
    expect(e.keyUp(Key.Ctrl, 102)).toEqual([])
    expect(e.isLocked).toBe(true)
    e.keyDown(Key.Ctrl, 5000)
    e.keyDown(Key.Meta, 5001)
    // Meta completing the ptt chord while locked stops the session.
    expect(e.snapshot().session).toBeNull()
  })

  it('starts locked directly from idle when pressed as a chord with no subset', () => {
    const e = make({ pushToTalk: [Key.F9], handsFree: [Key.Ctrl, Key.F9] })
    e.keyDown(Key.Ctrl, 0)
    expect(e.keyDown(Key.F9, 1)).toEqual([{ type: 'start', mode: 'hands-free' }])
    expect(e.isLocked).toBe(true)
    expect(e.keyUp(Key.F9, 50)).toEqual([])
  })
})

describe('HotkeyEngine: command mode and cancel', () => {
  it('command chord starts a command session and stops on release even if short', () => {
    const e = make()
    e.keyDown(Key.Alt, 0)
    expect(e.keyDown(Key.Meta, 1)).toEqual([{ type: 'start', mode: 'command' }])
    expect(e.keyUp(Key.Alt, 100)).toEqual([{ type: 'stop' }])
  })

  it('escape cancels a listening session', () => {
    const e = make()
    e.keyDown(Key.Ctrl, 0)
    e.keyDown(Key.Meta, 1)
    expect(e.keyDown(Key.Escape, 500)).toEqual([{ type: 'cancel' }])
    expect(e.isListening).toBe(false)
    expect(e.keyUp(Key.Meta, 600)).toEqual([])
  })

  it('escape does nothing when idle', () => {
    const e = make()
    expect(e.keyDown(Key.Escape, 0)).toEqual([])
  })
})

describe('chord validation and labels', () => {
  it('requires a modifier unless function key', () => {
    expect(validateChord([Key.A]).valid).toBe(false)
    expect(validateChord([Key.F9]).valid).toBe(true)
    expect(validateChord([Key.Ctrl, Key.Meta]).valid).toBe(true)
    expect(validateChord([Key.CtrlRight]).valid).toBe(true)
  })
  it('rejects more than three keys and OS combos', () => {
    expect(validateChord([Key.Ctrl, Key.Alt, Key.Shift, Key.Meta]).valid).toBe(false)
    expect(validateChord([Key.Ctrl, Key.C]).valid).toBe(false)
    expect(validateChord([Key.Alt, Key.F4]).valid).toBe(false)
    expect(validateChord([Key.Ctrl, Key.CtrlRight]).valid).toBe(false)
  })
  it('formats labels per platform', () => {
    expect(chordLabel([Key.Meta, Key.Ctrl], 'win32')).toBe('Ctrl + Win')
    expect(chordLabel([Key.Ctrl, Key.Meta], 'linux')).toBe('Ctrl + Super')
    expect(chordLabel([Key.CtrlRight], 'win32', true)).toBe('Right Ctrl')
    expect(chordLabel([], 'win32')).toBe('Not set')
  })
  it('maps to Electron accelerators when possible', () => {
    expect(electronAccelerator([Key.Ctrl, Key.Meta, Key.Space])).toBe(
      'CommandOrControl+Super+Space'
    )
    expect(electronAccelerator([Key.Ctrl, Key.Meta])).toBeNull()
    expect(electronAccelerator([Key.F9])).toBe('F9')
  })
})
