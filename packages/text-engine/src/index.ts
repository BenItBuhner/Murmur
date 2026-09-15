/**
 * Murmur text engine: raw speech transcript in, the text the speaker meant to type out.
 *
 * The model does the language work; the rules do only what a model cannot or must not: exact
 * commands with side effects, dictionary spellings, snippet expansion, and a verifier that makes
 * sure nothing the speaker said (above all, no number) was changed, lost or invented.
 *
 * Pure TypeScript with no dependencies, so the same code runs in the Electron main process and in
 * the Convex gateway; the Android app carries a port pinned to this one by a golden-file test.
 */
export * from './types'
export {
  countWords,
  capitalizeFirst,
  isQuestion,
  normalizeWhitespace,
  fixPunctuationSpacing,
  capitalizeSentences,
  applyTrailing,
  isMeaningful,
  editDistance,
  escapeRegex,
  wordRegex
} from './text'
export {
  extractPressEnter,
  applyLineCommands,
  applyLiteralPunctuation,
  applySpokenQuotes,
  applyScratchThat,
  type CommandResult
} from './commands'
export { removeFillers, DEFAULT_FILLERS } from './fillers'
export { applyDictionary, soundKey, buildSttPrompt, STT_BASE_PROMPT } from './dictionary'
export {
  expandSnippets,
  fillPlaceholders,
  type Snippet,
  type SnippetContext,
  type SnippetResult
} from './snippets'
export { digitSignature, numberList, countUnits, isNumberWord, NUMBER_WORDS } from './numbers'
export {
  classifyApp,
  autoTone,
  isTechnical,
  findRule,
  resolveStyle,
  toneDescription,
  categoryHint,
  type AppContext,
  type StylePrefs,
  type StyleRule,
  type ResolvedStyle
} from './context'
export {
  SYSTEM_PROMPT,
  EXAMPLES,
  buildFormatMessages,
  buildCommandMessages,
  userMessage,
  dictionaryLine,
  languageLine,
  maxTokensFor,
  type FormatPromptOptions,
  type CommandPromptInput
} from './prompt'
export {
  AUTO_LANGUAGE,
  LANGUAGES,
  LANGUAGE_OPTIONS,
  languageName,
  languageLabel,
  type Language
} from './languages'
export {
  cleanModelOutput,
  verifyOutput,
  type Verdict,
  type VerifyReason,
  type VerifyOptions
} from './verify'
export {
  prepareTranscript,
  basicCleanup,
  finish,
  type PreparedTranscript,
  type BasicCleanupOptions,
  type FinishOptions,
  type Finished
} from './cleanup'
export { formatTranscript, type FormatInput } from './format'
