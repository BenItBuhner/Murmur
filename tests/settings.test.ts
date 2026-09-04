import { describe, expect, it } from 'vitest'
import { defaultSettings, parseSettings } from '@shared/settings'
import { Key } from '@core/hotkey/keys'

describe('settings schema', () => {
  it('fills every nested default from an empty object', () => {
    const s = parseSettings({})
    expect(s.hotkeys.pushToTalk).toEqual([Key.Ctrl, Key.Meta])
    expect(s.hotkeys.handsFreeTrigger).toBe('tap')
    expect(s.audio.keepMicWarm).toBe(true)
    expect(s.formatting.llm.minWords).toBe(4)
    expect(s.formatting.fillerWords).toContain('um')
    expect(s.stt.kind).toBe('openai-compatible')
    expect(s.stats.totalWords).toBe(0)
  })

  it('keeps valid values and repairs invalid sections independently', () => {
    const s = parseSettings({
      general: { theme: 'dark', soundVolume: 0.9 },
      hotkeys: { tapThresholdMs: 'nope' },
      dictionary: [{ id: 'a', word: 'Murmur' }]
    })
    expect(s.general.theme).toBe('dark')
    expect(s.general.soundVolume).toBe(0.9)
    expect(s.general.sounds).toBe(true)
    // Broken hotkeys section falls back to defaults rather than discarding the whole file.
    expect(s.hotkeys.tapThresholdMs).toBe(350)
    expect(s.dictionary[0]).toMatchObject({ word: 'Murmur', aliases: [], fuzzy: false })
  })

  it('handles garbage input', () => {
    expect(parseSettings(null)).toEqual(defaultSettings())
    expect(parseSettings('x' as unknown)).toEqual(defaultSettings())
  })
})
