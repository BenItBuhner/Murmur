/**
 * Dictation languages. ISO-639-1 codes, which every supported speech provider accepts
 * (OpenAI-compatible `language`, Deepgram `language`, ElevenLabs `language_code`), paired with the
 * English name the formatting model is told about. The Android app carries the same table in
 * app/murmur/android/settings/Languages.kt; keep the two identical so both apps offer the same
 * choices and build the same prompt.
 */

export const AUTO_LANGUAGE = 'auto'

export interface Language {
  code: string
  name: string
}

export const LANGUAGES: readonly Language[] = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'et', name: 'Estonian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'ms', name: 'Malay' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' },
  { code: 'ta', name: 'Tamil' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' }
]

/** What the pickers show: auto-detect first, then every language by name. */
export const LANGUAGE_OPTIONS: readonly Language[] = [
  { code: AUTO_LANGUAGE, name: 'Auto-detect' },
  ...LANGUAGES
]

/**
 * English name of a dictation language, or undefined for auto-detect, blanks and codes we do not
 * know. Region subtags are ignored ("pt-BR" -> Portuguese) so a value synced from another client
 * still resolves.
 */
export function languageName(code: string | undefined | null): string | undefined {
  if (!code) return undefined
  const base = code.trim().toLowerCase().split(/[-_]/)[0]
  if (!base || base === AUTO_LANGUAGE) return undefined
  return LANGUAGES.find((l) => l.code === base)?.name
}

/** Picker label for a stored value; unknown codes are shown as-is rather than disappearing. */
export function languageLabel(code: string | undefined | null): string {
  if (!code || code.trim().toLowerCase() === AUTO_LANGUAGE) return 'Auto-detect'
  return languageName(code) ?? code
}
