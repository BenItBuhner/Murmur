import { describe, expect, it } from 'vitest'
import {
  SETTINGS_VERSION,
  defaultSettings,
  migrateSettings,
  parseSettings,
  sessionDurationLimitMs
} from '@shared/settings'
import { Key } from '@core/hotkey/keys'

describe('settings schema', () => {
  it('fills every nested default from an empty object', () => {
    const s = parseSettings({})
    expect(s.hotkeys.pushToTalk).toEqual([Key.Ctrl, Key.Meta])
    expect(s.hotkeys.handsFreeTrigger).toBe('tap')
    expect(s.audio.keepMicWarm).toBe(true)
    expect(s.audio.limitDuration).toBe(false)
    expect(sessionDurationLimitMs(s.audio)).toBeNull()
    expect(s.formatting.llm.minWords).toBe(4)
    expect(s.formatting.fillerWords).toContain('um')
    expect(s.stt.kind).toBe('openai-compatible')
    expect(s.stats.totalWords).toBe(0)
    // Appearance defaults keep the original look until the user opts in.
    expect(s.general.theme).toBe('system')
    expect(s.general.accent).toBe('neutral')
    expect(s.general.accentColor).toBe('#ff5a36')
    expect(s.general.tintedSurfaces).toBe(false)
  })

  it('accepts every accent choice and repairs a broken custom colour', () => {
    expect(parseSettings({ general: { accent: 'system' } }).general.accent).toBe('system')
    expect(parseSettings({ general: { accent: 'violet' } }).general.accent).toBe('violet')
    const custom = parseSettings({
      general: { accent: 'custom', accentColor: '#1E90FF', tintedSurfaces: true }
    })
    expect(custom.general.accent).toBe('custom')
    expect(custom.general.accentColor).toBe('#1E90FF')
    expect(custom.general.tintedSurfaces).toBe(true)
    // A malformed colour falls back to the default instead of resetting the whole section.
    const broken = parseSettings({
      general: { accent: 'custom', accentColor: 'blue-ish', theme: 'dark' }
    })
    expect(broken.general.accentColor).toBe('#ff5a36')
    expect(broken.general.theme).toBe('dark')
    // An unknown accent id (older or newer build) drops to the section defaults, nothing else lost.
    const unknown = parseSettings({ general: { accent: 'rainbow' }, stats: { totalWords: 7 } })
    expect(unknown.general.accent).toBe('neutral')
    expect(unknown.stats.totalWords).toBe(7)
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

  it('does not apply a duration cap unless the user turns it on', () => {
    // Existing installs only stored maxDurationSec (default 300). Missing limitDuration
    // must stay off so those files stop cutting people off at five minutes.
    const leftover = parseSettings({ audio: { maxDurationSec: 300 } })
    expect(leftover.audio.limitDuration).toBe(false)
    expect(sessionDurationLimitMs(leftover.audio)).toBeNull()

    const optedIn = parseSettings({ audio: { limitDuration: true, maxDurationSec: 120 } })
    expect(sessionDurationLimitMs(optedIn.audio)).toBe(120_000)
  })

  it('handles garbage input', () => {
    expect(parseSettings(null)).toEqual(defaultSettings())
    expect(parseSettings('x' as unknown)).toEqual(defaultSettings())
  })

  describe('model sources', () => {
    it('default to the instance models (ignored by local builds, see shared/inference.ts)', () => {
      const s = parseSettings({})
      expect(s.stt.source).toBe('murmur')
      expect(s.formatting.llm.source).toBe('murmur')
      expect(s.formatting.llm.sameAsStt).toBe(true)
      expect(parseSettings({ stt: { source: 'custom' } }).stt.source).toBe('custom')
      expect(parseSettings({ stt: { source: 'cloud' } }).stt.source).toBe('murmur')
    })

    it('keep a pre-existing bring-your-own setup when the file predates sources', () => {
      const v1 = {
        version: 1,
        stt: {
          kind: 'openai-compatible',
          baseUrl: 'https://api.groq.com/openai/v1',
          model: 'whisper-large-v3-turbo'
        },
        formatting: { llm: { sameAsStt: true, model: 'llama-3.1-8b-instant' }, tone: 'casual' }
      }
      const migrated = migrateSettings(v1) as {
        version: number
        stt: { source: string }
        formatting: { llm: { source: string } }
      }
      expect(migrated.version).toBe(SETTINGS_VERSION)
      expect(migrated.stt.source).toBe('custom')
      expect(migrated.formatting.llm.source).toBe('custom')
      const s = parseSettings(v1)
      expect(s.stt.source).toBe('custom')
      expect(s.stt.baseUrl).toBe('https://api.groq.com/openai/v1')
      expect(s.formatting.llm.source).toBe('custom')
      expect(s.formatting.llm.sameAsStt).toBe(true)
      expect(s.formatting.tone).toBe('casual')
      // A separate formatting server is kept too.
      const separate = parseSettings({
        stt: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1' },
        formatting: {
          llm: { sameAsStt: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' }
        }
      })
      expect(separate.formatting.llm).toMatchObject({
        source: 'custom',
        sameAsStt: false,
        baseUrl: 'http://127.0.0.1:11434/v1'
      })
    })

    it('leave files that already know about sources, and unset providers, alone', () => {
      const explicit = {
        stt: { source: 'murmur', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' }
      }
      expect(migrateSettings(explicit)).toBe(explicit)
      expect(parseSettings(explicit).stt.source).toBe('murmur')
      // Never connected a provider: nothing to preserve, so the new defaults apply.
      const fresh = { version: 1, stt: { kind: 'openai-compatible', baseUrl: '', model: '' } }
      expect(migrateSettings(fresh)).toBe(fresh)
      expect(parseSettings(fresh).stt.source).toBe('murmur')
      expect(migrateSettings(null)).toBeNull()
      expect(migrateSettings([1, 2])).toEqual([1, 2])
    })
  })
})
