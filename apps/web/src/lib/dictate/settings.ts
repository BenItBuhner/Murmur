import type { DictionaryTerm, FormattingMode, Tone } from '@/lib/engine/types'
import type { Snippet } from '@/lib/engine/snippets'

/**
 * The account settings a dictation uses. They are the synced ones: the dictionary (vocabulary),
 * snippets, formatting preferences and language, read from the same Convex tables the desktop
 * and Android apps write. Provider connections and hotkeys are device-local there and so are not
 * read here; the trigger is the desktop default chord.
 */
export interface AccountSettings {
  dictionary: DictionaryTerm[]
  snippets: Snippet[]
  formatting: {
    mode: FormattingMode
    tone: Tone
    trailingSpace: boolean
    instructions: string
  }
  /** 'auto' or ISO-639-1. */
  language: string
  /** Desktop `stt.useDictionaryPrompt` defaults to on; it is device-local, so on here too. */
  useDictionaryPrompt: boolean
}

export const DEFAULT_SETTINGS: AccountSettings = {
  dictionary: [],
  snippets: [],
  formatting: { mode: 'smart', tone: 'auto', trailingSpace: false, instructions: '' },
  language: 'auto',
  useDictionaryPrompt: true
}

interface DictionaryDto {
  word: string
  aliases?: string[]
  fuzzy?: boolean
}
interface SnippetDto {
  trigger: string
  content: string
}
interface PreferencesDto {
  formatting?: {
    mode?: FormattingMode
    tone?: Tone
    trailingSpace?: boolean
    llmInstructions?: string
  }
  language?: string
}

const MODES: readonly FormattingMode[] = ['off', 'light', 'smart']
const TONES: readonly Tone[] = ['auto', 'casual', 'neutral', 'professional']

/** Turn the three Convex answers into settings, keeping the defaults for anything missing. */
export function settingsFromAccount(
  dictionary: DictionaryDto[] | null | undefined,
  snippets: SnippetDto[] | null | undefined,
  prefs: PreferencesDto | null | undefined
): AccountSettings {
  const f = prefs?.formatting ?? {}
  return {
    dictionary: (dictionary ?? [])
      .filter((d) => d && typeof d.word === 'string' && d.word.trim())
      .map((d) => ({ word: d.word, aliases: d.aliases ?? [], fuzzy: !!d.fuzzy })),
    snippets: (snippets ?? [])
      .filter((s) => s && typeof s.trigger === 'string' && typeof s.content === 'string')
      .map((s) => ({ trigger: s.trigger, content: s.content })),
    formatting: {
      mode: MODES.includes(f.mode as FormattingMode) ? (f.mode as FormattingMode) : 'smart',
      tone: TONES.includes(f.tone as Tone) ? (f.tone as Tone) : 'auto',
      trailingSpace: f.trailingSpace ?? false,
      instructions: f.llmInstructions ?? ''
    },
    language: prefs?.language?.trim() || 'auto',
    useDictionaryPrompt: true
  }
}
