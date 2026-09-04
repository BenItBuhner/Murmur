import { z } from 'zod'

export const SETTINGS_VERSION = 1

export const handsFreeTriggerSchema = z.enum(['tap', 'double-tap', 'off'])
export type HandsFreeTrigger = z.infer<typeof handsFreeTriggerSchema>

export const formattingModeSchema = z.enum(['off', 'light', 'smart'])
export type FormattingMode = z.infer<typeof formattingModeSchema>

export const toneSchema = z.enum(['auto', 'casual', 'neutral', 'professional'])
export type Tone = z.infer<typeof toneSchema>

export const injectionMethodSchema = z.enum(['auto', 'paste', 'type', 'clipboard'])
export type InjectionMethod = z.infer<typeof injectionMethodSchema>

export const overlayPositionSchema = z.enum(['bottom-center', 'top-center', 'bottom-right'])
export type OverlayPosition = z.infer<typeof overlayPositionSchema>

export const themeSchema = z.enum(['system', 'light', 'dark'])
export type Theme = z.infer<typeof themeSchema>

export const sttProviderKindSchema = z.enum(['openai-compatible', 'deepgram', 'elevenlabs'])
export type SttProviderKind = z.infer<typeof sttProviderKindSchema>

export const dictionaryEntrySchema = z.object({
  id: z.string(),
  word: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  fuzzy: z.boolean().default(false),
  createdAt: z.number().default(0)
})
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>

export const snippetSchema = z.object({
  id: z.string(),
  trigger: z.string().min(1),
  content: z.string(),
  createdAt: z.number().default(0)
})
export type Snippet = z.infer<typeof snippetSchema>

export const appRuleSchema = z.object({
  id: z.string(),
  match: z.string().min(1),
  tone: toneSchema.default('auto'),
  formatting: formattingModeSchema.optional(),
  trailingSpace: z.boolean().optional()
})
export type AppRule = z.infer<typeof appRuleSchema>

export const hotkeySchema = z.array(z.number().int()).max(3)

export const settingsSchema = z.object({
  version: z.number().default(SETTINGS_VERSION),
  onboardingComplete: z.boolean().default(false),
  general: z
    .object({
      launchAtLogin: z.boolean().default(false),
      startMinimized: z.boolean().default(true),
      theme: themeSchema.default('system'),
      sounds: z.boolean().default(true),
      soundVolume: z.number().min(0).max(1).default(0.35),
      overlayPosition: overlayPositionSchema.default('bottom-center'),
      showOverlayWhenIdle: z.boolean().default(true),
      showLatencyInHistory: z.boolean().default(true)
    })
    .prefault({}),
  hotkeys: z
    .object({
      // uiohook keycodes (see core/hotkey/keys.ts). Empty array disables the binding.
      pushToTalk: hotkeySchema.default([29, 3675]), // Ctrl + Meta/Win
      handsFree: hotkeySchema.default([29, 3675, 57]), // Ctrl + Meta + Space
      commandMode: hotkeySchema.default([56, 3675]), // Alt + Meta
      handsFreeTrigger: handsFreeTriggerSchema.default('tap'),
      tapThresholdMs: z.number().int().min(80).max(1500).default(350),
      doubleTapWindowMs: z.number().int().min(100).max(1500).default(400),
      sideSensitive: z.boolean().default(false),
      escapeCancels: z.boolean().default(true)
    })
    .prefault({}),
  audio: z
    .object({
      deviceId: z.string().default('default'),
      keepMicWarm: z.boolean().default(true),
      preBufferMs: z.number().int().min(0).max(1500).default(350),
      trimSilence: z.boolean().default(true),
      skipIfSilent: z.boolean().default(true),
      silenceThresholdDb: z.number().min(-80).max(-10).default(-48),
      maxDurationSec: z.number().int().min(5).max(1800).default(300),
      noiseSuppression: z.boolean().default(true),
      autoGainControl: z.boolean().default(true)
    })
    .prefault({}),
  stt: z
    .object({
      kind: sttProviderKindSchema.default('openai-compatible'),
      presetId: z.string().default('custom'),
      baseUrl: z.string().default(''),
      // Encrypted with Electron safeStorage when available; see main/store/secrets.ts
      apiKeyEnc: z.string().default(''),
      model: z.string().default(''),
      fallbackModel: z.string().default(''),
      language: z.string().default('auto'),
      useDictionaryPrompt: z.boolean().default(true),
      timeoutMs: z.number().int().min(2000).max(120000).default(45000)
    })
    .prefault({}),
  formatting: z
    .object({
      mode: formattingModeSchema.default('smart'),
      removeFillers: z.boolean().default(true),
      fillerWords: z
        .array(z.string())
        .default(['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm', 'hm']),
      collapseRepeats: z.boolean().default(true),
      spokenCommands: z.boolean().default(true),
      selfCorrections: z.boolean().default(true),
      autoCapitalize: z.boolean().default(true),
      trailingSpace: z.boolean().default(true),
      pressEnterCommand: z.boolean().default(true),
      tone: toneSchema.default('auto'),
      appRules: z.array(appRuleSchema).default([]),
      llm: z
        .object({
          sameAsStt: z.boolean().default(true),
          baseUrl: z.string().default(''),
          apiKeyEnc: z.string().default(''),
          model: z.string().default(''),
          minWords: z.number().int().min(1).max(50).default(4),
          timeoutMs: z.number().int().min(1000).max(60000).default(8000),
          maxTokensMultiplier: z.number().min(1).max(4).default(2)
        })
        .prefault({})
    })
    .prefault({}),
  injection: z
    .object({
      method: injectionMethodSchema.default('auto'),
      restoreClipboard: z.boolean().default(true),
      restoreClipboardDelayMs: z.number().int().min(50).max(5000).default(400),
      typeChunkSize: z.number().int().min(1).max(512).default(64),
      typeChunkDelayMs: z.number().int().min(0).max(100).default(2)
    })
    .prefault({}),
  dictionary: z.array(dictionaryEntrySchema).default([]),
  snippets: z.array(snippetSchema).default([]),
  stats: z
    .object({
      totalWords: z.number().default(0),
      totalSessions: z.number().default(0),
      totalSpeechMs: z.number().default(0),
      streakDays: z.number().default(0),
      lastSessionDay: z.string().default('')
    })
    .prefault({})
})

export type Settings = z.infer<typeof settingsSchema>
export type SettingsInput = z.input<typeof settingsSchema>

export function parseSettings(raw: unknown): Settings {
  const result = settingsSchema.safeParse(raw ?? {})
  if (result.success) return result.data
  // Salvage whatever validates by re-parsing section by section so one bad field
  // never wipes the whole configuration.
  const base = settingsSchema.parse({})
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Record<string, unknown>
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(settingsSchema.shape) as Array<keyof Settings>) {
    if (!(key in input)) continue
    const sectionSchema = settingsSchema.shape[key]
    const parsed = sectionSchema.safeParse(input[key])
    if (parsed.success) out[key] = parsed.data
  }
  return settingsSchema.parse(out)
}

export const defaultSettings = (): Settings => settingsSchema.parse({})
