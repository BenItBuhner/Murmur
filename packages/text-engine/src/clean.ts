import type { PreparedTranscript } from './cleanup'
import { autoTone } from './context'
import { DEFAULT_FILLERS } from './fillers'
import { isNumberWord } from './numbers'
import { QUESTION_START, countWords } from './text'
import type { FormatContext } from './types'

/**
 * The "needs no model" decision. Every formatting call carries a ~1,200-token fixed prompt, and a
 * short dictation the speech model already punctuated gains nothing from it: the model would hand
 * back the same words. This module decides, deterministically and conservatively, whether the
 * rule-based cleanup is the whole job. A transcript qualifies only when nothing in it or around it
 * could make the model change the text: it is short, already punctuated, plain English prose with
 * no filler, stutter, spoken command, self-correction, number or list cue, going to a destination
 * with no special needs, under default style settings. Every rule errs toward calling the model:
 * a false "not clean" costs one round trip, which is the status quo; a false "clean" inserts text
 * the model would have fixed.
 *
 * Mirrored by the Android port (Clean.kt) and pinned to it by the golden contract, which records
 * the decision for every eval fixture and the word lists below.
 */

/**
 * Longest transcript, in words, the rules may finish on their own. Chosen from the eval corpus
 * (5 to 24 words, median 13): every fixture up to 12 words is a single clause, or a spoken list,
 * line break or repeated number the content rules catch; from 13 words the corpus turns to
 * two-clause dictations ("what time is the meeting tomorrow and do i need to bring anything")
 * where the speech model's punctuation has to be trusted across a boundary the rules cannot see.
 * Up to the cap, terminal punctuation is evidence that the whole transcript is punctuated; beyond
 * it, it is not. Twelve words is about five seconds of speech: the quick-reply regime.
 */
export const CLEAN_MAX_WORDS = 12

/** Why a transcript still needs the model; `undefined` when it does not. */
export type NotCleanReason =
  | 'destination'
  | 'instructions'
  | 'tone'
  | 'language'
  | 'preceding-text'
  | 'verbatim'
  | 'command'
  | 'long'
  | 'unpunctuated'
  | 'characters'
  | 'truncated'
  | 'filler'
  | 'stutter'
  | 'correction'
  | 'enumeration'
  | 'number'
  | 'question'
  | 'foreign'

export interface CleanDecision {
  /** True when the rule-based cleanup is the whole job and the model is not called. */
  clean: boolean
  /** The first rule that kept the model in, when `clean` is false. */
  reason?: NotCleanReason
}

export interface CleanOptions {
  /** Override of {@link CLEAN_MAX_WORDS}; 0 disables the skip entirely. */
  maxWords?: number
}

// ---- lexicon ----------------------------------------------------------------------------------
// Lower-case, ASCII only (the transcript is checked to be ASCII before these run). Every list is
// part of the golden contract, so the Kotlin port carries the same words.

/** Hesitation sounds and words the model removes; the rules only remove the sounds. */
export const HESITATION_WORDS: readonly string[] = [
  ...DEFAULT_FILLERS,
  'oh',
  'basically',
  'actually',
  'literally',
  'honestly',
  'anyway',
  'anyways',
  'kinda',
  'sorta'
]

export const HESITATION_PHRASES: readonly string[] = ['you know', 'i mean', 'kind of', 'sort of']

/** Spoken punctuation, layout and editing commands, as single words... */
export const COMMAND_WORDS: readonly string[] = [
  'quote',
  'quotes',
  'unquote',
  'comma',
  'period',
  'colon',
  'semicolon',
  'hyphen',
  'dash',
  'ampersand',
  'asterisk',
  'underscore',
  'slash',
  'backslash',
  'parenthesis',
  'parentheses',
  'bracket',
  'brackets',
  'ellipsis',
  'newline',
  'backspace',
  'caps',
  'capital',
  'capitalize',
  'uppercase',
  'lowercase'
]

/** ...and as phrases. The layout ones are normally consumed by `prepareTranscript` first. */
export const COMMAND_PHRASES: readonly string[] = [
  'new line',
  'new paragraph',
  'line break',
  'paragraph break',
  'question mark',
  'exclamation point',
  'exclamation mark',
  'full stop',
  'open paren',
  'close paren',
  'all caps',
  'scratch that',
  'delete that',
  'strike that',
  'undo that',
  'erase that',
  'press enter',
  'hit enter',
  'select all',
  'open quote',
  'close quote',
  'end quote'
]

/** Spoken self-corrections ("Tuesday, no, Wednesday" is handled by a pattern below). */
export const CORRECTION_PHRASES: readonly string[] = [
  'i meant',
  'no wait',
  'wait no',
  'or rather',
  'make that',
  'never mind',
  'nevermind',
  'forget that',
  'correction'
]

/** Cues that the speaker is enumerating; ordinals and counts fall under the number rule. */
export const ENUMERATION_WORDS: readonly string[] = [
  'firstly',
  'secondly',
  'thirdly',
  'lastly',
  'bullet',
  'bullets'
]

export const ENUMERATION_PHRASES: readonly string[] = [
  'bullet point',
  'bullet points',
  'next item',
  'next point'
]

/**
 * Frequent function words of other languages written in plain ASCII. The rules only know English
 * fillers, numbers and commands, so a transcript that carries one of these goes to the model even
 * when the language setting is "auto". Words that are also English ("is", "no", "met", "con",
 * "van") are left out on purpose.
 */
export const FOREIGN_WORDS: readonly string[] = [
  // German
  'aber', 'auch', 'bist', 'bitte', 'danke', 'das', 'dass', 'der', 'dich', 'die', 'du', 'ein',
  'eine', 'einem', 'einen', 'einer', 'es', 'euch', 'gibt', 'habe', 'haben', 'heute', 'hier',
  'ich', 'ihm', 'ihn', 'ihr', 'im', 'ist', 'ja', 'jetzt', 'kann', 'mich', 'mir', 'morgen',
  'muss', 'nein', 'nicht', 'noch', 'oder', 'schon', 'sehr', 'sie', 'sind', 'soll', 'und',
  'uns', 'wenn', 'wie', 'wir', 'wird', 'wo', 'zu',
  // French (also "de", shared with Spanish, Portuguese and Dutch)
  'alors', 'au', 'aussi', 'aux', 'avec', 'avez', 'avons', 'bonjour', 'ce', 'ces', 'cette',
  'dans', 'de', 'demain', 'des', 'elle', 'elles', 'et', 'il', 'ils', 'je', 'la', 'le', 'les',
  'mais', 'merci', 'moi', 'notre', 'nous', 'oui', 'pas', 'peut', 'peux', 'qui', 'que', 'sommes',
  'sont', 'suis', 'sur', 'toi', 'tu', 'une', 'vais', 'votre', 'vous',
  // Spanish
  'del', 'el', 'ellas', 'ellos', 'eres', 'esta', 'este', 'esto', 'gracias', 'hola', 'hoy',
  'las', 'lo', 'los', 'muy', 'nosotros', 'pero', 'por', 'porque', 'puede', 'puedes', 'puedo',
  'quiero', 'quieres', 'se', 'si', 'somos', 'tengo', 'tiene', 'tienes', 'un', 'una', 'unas',
  'unos', 'usted', 'ustedes',
  // Italian
  'anche', 'che', 'ciao', 'cosa', 'degli', 'dei', 'della', 'delle', 'dello', 'di', 'domani',
  'gli', 'grazie', 'lei', 'loro', 'lui', 'nel', 'nella', 'noi', 'oggi', 'posso', 'puoi',
  'questa', 'questo', 'sei', 'siamo', 'sono', 'tutto', 'voi', 'vorrei',
  // Portuguese
  'agora', 'aqui', 'bom', 'da', 'dos', 'ela', 'elas', 'ele', 'eles', 'essa', 'esse', 'hoje',
  'isso', 'isto', 'mas', 'muito', 'nas', 'nos', 'obrigada', 'obrigado', 'quero', 'tem', 'tenho',
  'tudo', 'uma', 'vamos',
  // Dutch
  'alle', 'deze', 'dit', 'een', 'en', 'geen', 'graag', 'heb', 'hebben', 'heeft', 'het', 'ik',
  'jij', 'jullie', 'maar', 'mijn', 'naar', 'niet', 'nog', 'nu', 'ook', 'voor', 'wel', 'wij',
  'wordt', 'ze', 'zij', 'zijn', 'zou',
  // Swedish, Norwegian, Danish
  'det', 'ett', 'ikke', 'inte', 'jag', 'jeg', 'och', 'og', 'som',
  // Polish
  'czy', 'dla', 'jest', 'nie', 'tak',
  // Turkish
  'ama', 'bir', 'bu', 'evet', 'tamam', 've', 'yok',
  // Indonesian, Malay
  'akan', 'bisa', 'dengan', 'ini', 'itu', 'kasih', 'saya', 'sudah', 'terima', 'tidak', 'untuk',
  'yang',
  // Tagalog
  'ako', 'ang', 'mga', 'salamat'
]

// ---- patterns ---------------------------------------------------------------------------------

/** Only what a punctuated English sentence is made of. Digits pass here and fail the number rule. */
const ALLOWED_CHARS = /^[a-z0-9 .,!?'’-]*$/
/**
 * A word ending in a bare apostrophe that is not a plural possessive ("dogs'"): a contraction the
 * speech model cut and `repairContractions` could not restore, which only the model can finish.
 */
const CUT_WORD = /[a-z](?<!s)['’](?![a-z0-9])/
/** One terminal mark at the very end; "..." is trailing off, not punctuation. */
const TERMINAL = /(?<!\.)[.!?]$/
/** The cursor sits at a sentence or paragraph start: the dictation is a fresh sentence. */
const PRECEDING_BOUNDARY = /(?:[.!?…]["'”’)\]]*[ \t]*|\n[ \t]*)$/
/** Openers the model drops as false starts ("so", "well", "okay so"). */
const OPENER = /^(?:so|well|alright|(?:okay|ok|yeah|yes|right|and|but|now|then)\s*,?\s*so)(?![a-z'’])/
/** A pause "like": next to a comma or opening the sentence. */
const PAUSE_LIKE = /(?:^|,\s*)like(?![a-z'’])|(?<![a-z'’])like\s*,/
/** "Tuesday, no, Wednesday" and a "wait" that opens a clause. */
const CORRECTION = /,\s*no(?![a-z'’])|(?:^|[,.]\s*)wait(?![a-z'’])/
const WORD = /[a-z]+(?:['’][a-z]+)?/g
const SENTENCE_SPLIT = /(?<=[.!?])\s+/

/** One alternation for a phrase list, bounded so "i mean" does not match "semi meant". */
const phraseRegex = (phrases: readonly string[]): RegExp =>
  new RegExp(`(?<![a-z'’])(?:${phrases.map((p) => p.replace(/ /g, '\\s+')).join('|')})(?![a-z'’])`)
const HESITATION_PHRASE_RE = phraseRegex(HESITATION_PHRASES)
const COMMAND_PHRASE_RE = phraseRegex(COMMAND_PHRASES)
const CORRECTION_PHRASE_RE = phraseRegex(CORRECTION_PHRASES)
const ENUMERATION_PHRASE_RE = phraseRegex(ENUMERATION_PHRASES)
const HESITATION_SET = new Set(HESITATION_WORDS)
const COMMAND_SET = new Set(COMMAND_WORDS)
const ENUMERATION_SET = new Set(ENUMERATION_WORDS)
const FOREIGN_SET = new Set(FOREIGN_WORDS)

/** A word, or a run of two or three words, said twice in a row: "the the", "I, I think", "we need to we need to". */
function hasStutter(words: readonly string[]): boolean {
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      let same = true
      for (let k = 0; k < n && same; k++) same = words[i + k] === words[i + n + k]
      if (same) return true
    }
  }
  return false
}

/**
 * Decide whether the prepared transcript needs the model. `prepared` is what `prepareTranscript`
 * returned (line commands applied, "press enter" removed); the decision reads its text and stages.
 */
export function alreadyClean(
  prepared: Pick<PreparedTranscript, 'text' | 'stages'>,
  ctx: FormatContext,
  opts: CleanOptions = {}
): CleanDecision {
  const no = (reason: NotCleanReason): CleanDecision => ({ clean: false, reason })

  // Where the text goes and how the user wants it: anything beyond the defaults is the model's job.
  if (ctx.category === 'code' || ctx.category === 'terminal') return no('destination')
  if (ctx.instructions?.trim()) return no('instructions')
  if (ctx.tone !== autoTone(ctx.category)) return no('tone')
  const lang = (ctx.language ?? 'auto').trim().toLowerCase().split(/[-_]/)[0]
  if (lang && lang !== 'auto' && lang !== 'en') return no('language')
  const preceding = ctx.precedingText ?? ''
  if (preceding.trim() && !PRECEDING_BOUNDARY.test(preceding)) return no('preceding-text')

  const text = prepared.text
  const lower = text.toLowerCase()
  for (const phrase of ctx.keepVerbatim ?? []) {
    const p = phrase.trim().toLowerCase()
    if (p && lower.includes(p)) return no('verbatim')
  }

  // The transcript itself.
  if (
    prepared.stages.includes('line-commands') ||
    prepared.stages.includes('literal-punctuation') ||
    text.includes('\n')
  )
    return no('command')
  if (countWords(text) > (opts.maxWords ?? CLEAN_MAX_WORDS)) return no('long')
  if (!TERMINAL.test(text)) return no('unpunctuated')
  if (!ALLOWED_CHARS.test(lower)) return no('characters')
  if (CUT_WORD.test(lower)) return no('truncated')

  const words = lower.match(WORD) ?? []
  const has = (set: ReadonlySet<string>): boolean => words.some((w) => set.has(w))
  if (has(HESITATION_SET) || HESITATION_PHRASE_RE.test(lower)) return no('filler')
  if (OPENER.test(lower) || PAUSE_LIKE.test(lower)) return no('filler')
  if (hasStutter(words)) return no('stutter')
  if (CORRECTION_PHRASE_RE.test(lower) || CORRECTION.test(lower)) return no('correction')
  if (has(COMMAND_SET) || COMMAND_PHRASE_RE.test(lower)) return no('command')
  if (has(ENUMERATION_SET) || ENUMERATION_PHRASE_RE.test(lower)) return no('enumeration')
  if (/[0-9]/.test(lower) || words.some(isNumberWord)) return no('number')
  // A question the speech model ended with a period would come back with its "?".
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (QUESTION_START.test(sentence) && !/\?$/.test(sentence)) return no('question')
  }
  if (has(FOREIGN_SET)) return no('foreign')
  return { clean: true }
}
