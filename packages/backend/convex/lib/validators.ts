import { v, type Infer } from 'convex/values'

/**
 * Validators shared by the schema, the public function signatures and the tests. The wire shapes
 * returned to clients deliberately mirror the desktop app's local types (apps/desktop/src/shared)
 * so a synced record drops straight into the offline mirror.
 */

export const toneValidator = v.union(
  v.literal('auto'),
  v.literal('casual'),
  v.literal('neutral'),
  v.literal('professional')
)
export type Tone = Infer<typeof toneValidator>

export const formattingModeValidator = v.union(v.literal('off'), v.literal('light'), v.literal('smart'))
export type FormattingMode = Infer<typeof formattingModeValidator>

export const platformValidator = v.union(
  v.literal('win32'),
  v.literal('darwin'),
  v.literal('linux'),
  v.literal('android'),
  v.literal('ios'),
  v.literal('web')
)
export type Platform = Infer<typeof platformValidator>

export const dictationModeValidator = v.union(
  v.literal('hold'),
  v.literal('hands-free'),
  v.literal('command')
)

/** Style preferences that follow the user across devices. Provider connections and API keys never sync. */
export const formattingPreferencesValidator = v.object({
  mode: v.optional(formattingModeValidator),
  tone: v.optional(toneValidator),
  removeFillers: v.optional(v.boolean()),
  fillerWords: v.optional(v.array(v.string())),
  collapseRepeats: v.optional(v.boolean()),
  spokenCommands: v.optional(v.boolean()),
  selfCorrections: v.optional(v.boolean()),
  autoCapitalize: v.optional(v.boolean()),
  trailingSpace: v.optional(v.boolean()),
  pressEnterCommand: v.optional(v.boolean())
})
export type FormattingPreferences = Infer<typeof formattingPreferencesValidator>

export const syncPreferencesValidator = v.object({
  /** Opt-in: mirror dictation history across devices. Off by default because it contains dictated text. */
  history: v.optional(v.boolean())
})
export type SyncPreferences = Infer<typeof syncPreferencesValidator>

export const preferencesPatchValidator = v.object({
  formatting: v.optional(formattingPreferencesValidator),
  /** Spoken language hint for the speech model ("auto" or a BCP-47 code). */
  language: v.optional(v.string()),
  sync: v.optional(syncPreferencesValidator)
})
export type PreferencesPatch = Infer<typeof preferencesPatchValidator>

export const preferencesDtoValidator = v.object({
  formatting: v.optional(formattingPreferencesValidator),
  language: v.optional(v.string()),
  sync: v.optional(syncPreferencesValidator),
  updatedAt: v.number()
})
export type PreferencesDto = Infer<typeof preferencesDtoValidator>

export const dictionaryEntryDtoValidator = v.object({
  id: v.id('dictionaryEntries'),
  word: v.string(),
  aliases: v.array(v.string()),
  fuzzy: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number()
})
export type DictionaryEntryDto = Infer<typeof dictionaryEntryDtoValidator>

export const dictionaryEntryInputValidator = v.object({
  word: v.string(),
  aliases: v.optional(v.array(v.string())),
  fuzzy: v.optional(v.boolean()),
  createdAt: v.optional(v.number())
})
export type DictionaryEntryInput = Infer<typeof dictionaryEntryInputValidator>

export const snippetDtoValidator = v.object({
  id: v.id('snippets'),
  trigger: v.string(),
  content: v.string(),
  createdAt: v.number(),
  updatedAt: v.number()
})
export type SnippetDto = Infer<typeof snippetDtoValidator>

export const snippetInputValidator = v.object({
  trigger: v.string(),
  content: v.string(),
  createdAt: v.optional(v.number())
})
export type SnippetInput = Infer<typeof snippetInputValidator>

export const appRuleDtoValidator = v.object({
  id: v.id('appRules'),
  match: v.string(),
  tone: toneValidator,
  formatting: v.optional(formattingModeValidator),
  trailingSpace: v.optional(v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number()
})
export type AppRuleDto = Infer<typeof appRuleDtoValidator>

export const appRuleInputValidator = v.object({
  match: v.string(),
  tone: v.optional(toneValidator),
  formatting: v.optional(formattingModeValidator),
  trailingSpace: v.optional(v.boolean()),
  createdAt: v.optional(v.number())
})
export type AppRuleInput = Infer<typeof appRuleInputValidator>

export const statsDtoValidator = v.object({
  totalWords: v.number(),
  totalSessions: v.number(),
  totalSpeechMs: v.number(),
  streakDays: v.number(),
  lastSessionDay: v.string(),
  updatedAt: v.number()
})
export type StatsDto = Infer<typeof statsDtoValidator>

export const deviceDtoValidator = v.object({
  id: v.id('devices'),
  deviceId: v.string(),
  name: v.string(),
  platform: platformValidator,
  appVersion: v.string(),
  lastSeenAt: v.number(),
  createdAt: v.number()
})
export type DeviceDto = Infer<typeof deviceDtoValidator>

export const historyEntryInputValidator = v.object({
  entryId: v.string(),
  createdAt: v.number(),
  mode: dictationModeValidator,
  rawText: v.optional(v.string()),
  finalText: v.string(),
  wordCount: v.number(),
  speechMs: v.number(),
  appName: v.optional(v.string()),
  provider: v.string(),
  model: v.string(),
  llmUsed: v.boolean()
})
export type HistoryEntryInput = Infer<typeof historyEntryInputValidator>

export const historyEntryDtoValidator = v.object({
  id: v.id('historyEntries'),
  entryId: v.string(),
  deviceId: v.string(),
  deviceName: v.optional(v.string()),
  createdAt: v.number(),
  mode: dictationModeValidator,
  rawText: v.optional(v.string()),
  finalText: v.string(),
  wordCount: v.number(),
  speechMs: v.number(),
  appName: v.optional(v.string()),
  provider: v.string(),
  model: v.string(),
  llmUsed: v.boolean()
})
export type HistoryEntryDto = Infer<typeof historyEntryDtoValidator>

export const userDtoValidator = v.object({
  id: v.id('users'),
  clerkId: v.string(),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  onboardingCompletedAt: v.optional(v.number()),
  onboardingVersion: v.optional(v.number()),
  createdAt: v.number()
})
export type UserDto = Infer<typeof userDtoValidator>
