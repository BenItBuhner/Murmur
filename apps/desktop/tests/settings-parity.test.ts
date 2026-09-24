import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LLM_INSTRUCTIONS_MAX,
  SETTINGS_RANGES,
  clampToRange,
  defaultSettings,
  formattingModeSchema,
  toneSchema
} from '@shared/settings'
import { STT_PRESETS } from '@core/stt/presets'

/**
 * The desktop side of the cross-platform settings contract (tests/fixtures/settings-parity.json).
 * The Android store pins itself to the same file (SettingsParityTest), so a default or a bound
 * changed here without the phone following fails one of the two.
 */
const contract = JSON.parse(
  readFileSync(new URL('./fixtures/settings-parity.json', import.meta.url), 'utf8')
) as {
  defaults: Record<string, unknown>
  ranges: Record<string, { min: number; max: number }>
  sttPresets: Array<Record<string, unknown>>
  snippetPlaceholders: string[]
  appRule: { tones: string[]; modes: string[] }
}

describe('settings parity contract', () => {
  it('the defaults are the ones both apps ship', () => {
    const s = defaultSettings()
    expect({
      sttTimeoutMs: s.stt.timeoutMs,
      llmTimeoutMs: s.formatting.llm.timeoutMs,
      limitDuration: s.audio.limitDuration,
      maxDurationSec: s.audio.maxDurationSec,
      keepRecordings: s.audio.keepRecordings,
      useDictionaryPrompt: s.stt.useDictionaryPrompt,
      showLatencyInHistory: s.general.showLatencyInHistory,
      buttonShadow: s.general.buttonShadow,
      formattingMode: s.formatting.mode,
      tone: s.formatting.tone,
      trailingSpace: s.formatting.trailingSpace,
      instructions: s.formatting.instructions,
      language: s.stt.language,
      sttKind: s.stt.kind,
      sttPresetId: s.stt.presetId,
      llmSameAsStt: s.formatting.llm.sameAsStt,
      updateAutoCheck: s.updates.autoCheck,
      updateAutoInstall: s.updates.autoInstall,
      updateIncludePrereleases: s.updates.includePrereleases
    }).toEqual(contract.defaults)
  })

  it('the bounds are the ones both apps clamp to', () => {
    expect({
      ...SETTINGS_RANGES,
      instructionsLength: { min: 0, max: LLM_INSTRUCTIONS_MAX }
    }).toEqual(contract.ranges)
  })

  it('the speech provider presets name the same connections', () => {
    expect(
      STT_PRESETS.map((p) => ({
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        models: p.models,
        requiresKey: p.requiresKey,
        local: !!p.local
      }))
    ).toEqual(contract.sttPresets)
  })

  it('the style vocabularies match', () => {
    expect(toneSchema.options).toEqual(contract.appRule.tones)
    expect(formattingModeSchema.options).toEqual(contract.appRule.modes)
  })

  it('an input clamps into the range instead of handing the schema a value it would reject', () => {
    // A rejected value drops its whole settings section to defaults (parseSettings salvages per
    // section), which for the transcription timeout means losing the provider URL and key.
    expect(clampToRange(121_000, SETTINGS_RANGES.sttTimeoutMs)).toBe(120_000)
    expect(clampToRange(1_000, SETTINGS_RANGES.sttTimeoutMs)).toBe(2_000)
    expect(clampToRange(45_000, SETTINGS_RANGES.sttTimeoutMs)).toBe(45_000)
    expect(clampToRange(Number.NaN, SETTINGS_RANGES.llmTimeoutMs)).toBe(1_000)
    expect(clampToRange(0, SETTINGS_RANGES.maxDurationSec)).toBe(5)
    expect(clampToRange(1_801, SETTINGS_RANGES.maxDurationSec)).toBe(1_800)
  })
})
