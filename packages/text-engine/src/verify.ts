import { countUnits, digitSignature, isNumberWord } from './numbers'
import { ABBREVIATION, QUESTION_START, countWords, isQuestion } from './text'
import type { FormatContext } from './types'

/**
 * Trust, but verify. The model's answer is first cleaned of the wrapping models add (reasoning
 * tags, fences, labels, commentary) and then checked against a handful of invariants that can be
 * decided without understanding the text:
 *
 *   - it is not empty, chatty, or an echo of the prompt;
 *   - it did not answer a question or turn the dictation into a reply;
 *   - it is roughly as long as the transcript (numbers counted as one unit each);
 *   - it shares most of its content words with the transcript;
 *   - it contains exactly the same numbers, in the same order (see numbers.ts).
 *
 * Anything else is the model's call. A rejection makes the caller try once more in strict mode
 * and then fall back to the rule-based cleanup of the transcript itself.
 */

// ---- cleaning -------------------------------------------------------------------------------

const THINK_BLOCK = /<(think|thinking|reasoning|analysis|scratchpad)>[\s\S]*?<\/\1>\s*/gi
const UNTERMINATED_THINK = /^<(?:think|thinking|reasoning|analysis|scratchpad)>[\s\S]*$/i
const LABEL_PREFIX =
  /^(?:(?:here(?:'s| is) |this is )?(?:the |your |my )?(?:cleaned(?:[- ]up)?|formatted|polished|final|corrected|edited|revised|fixed|rewritten|improved)(?: up)?(?: text| version| transcript| dictation| sentence| output)?|output|result|text|transcript|answer|response)\s*:\s*\n?/i
const COMMENTARY_LINE =
  /^(?:let me know|hope (?:this|that) helps|i(?:'ve| have)? (?:cleaned|removed|fixed|corrected|kept|changed|also|made|applied)|note:|notes:|changes(?: made)?:|i removed|i corrected|i changed|here(?:'s| is) (?:the|your|a)|this (?:version|text|keeps|removes)|the (?:cleaned|corrected|revised) (?:text|version)|\(?(?:no|nothing) (?:changes?|to (?:change|clean))|feel free)/i

export function cleanModelOutput(output: string, transcript: string): string {
  let text = output.replace(/\r\n?/g, '\n')
  text = text.replace(THINK_BLOCK, '')
  if (UNTERMINATED_THINK.test(text.trim())) return ''
  text = text.trim()
  const fence = /^```[a-z]*\n?([\s\S]*?)\n?```$/i.exec(text)
  if (fence) text = fence[1].trim()
  text = text.replace(/^<\/?transcript>\s*|\s*<\/?transcript>$/gi, '')
  text = text.replace(LABEL_PREFIX, '').trim()
  if (/^["“”'‘’].*["“”'‘’]$/s.test(text) && !/^["“”'‘’]/.test(transcript.trim()))
    text = text.slice(1, -1).trim()
  // Markdown the speaker never asked for.
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  if (!transcript.includes('`')) text = text.replace(/`([^`\n]+)`/g, '$1')
  const lines = text.split('\n')
  while (
    lines.length > 1 &&
    (COMMENTARY_LINE.test(lines[lines.length - 1].trim()) || lines[lines.length - 1].trim() === '')
  )
    lines.pop()
  if (lines.length > 2 && COMMENTARY_LINE.test(lines[0].trim()) && lines[1].trim() === '')
    lines.splice(0, 2)
  text = lines.join('\n').trim()
  // A fence that was followed by commentary only closes once the commentary is gone.
  const fenced = /^```[a-z]*\n?([\s\S]*?)\n?```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  return text.replace(LABEL_PREFIX, '').trim()
}

// ---- invariants -----------------------------------------------------------------------------

const CHATTY_PREFIX =
  /^(?:sure|certainly|of course|absolutely|here(?:'s| is| are)|i(?:'m| am) sorry|as an ai|i can(?:'t|not)|the cleaned|cleaned text|here you go|i'd be happy|i (?:have|'ve) (?:cleaned|removed)|okay,? here)\b/i
const PROMPT_ECHO =
  /\b(?:you clean up voice dictation|speech recognizer transcribed|^destination:|^transcript:|^keep verbatim:|^before the cursor:)/im

export type VerifyReason =
  | 'empty'
  | 'chatty'
  | 'echo'
  | 'too-short'
  | 'too-long'
  | 'answered'
  | 'diverged'
  | 'numbers-changed'
  | 'verbatim-lost'
  | 'repeated'

export interface Verdict {
  ok: boolean
  reason?: VerifyReason
  /** For `numbers-changed`: the two signatures, for logs and History. */
  expected?: string
  actual?: string
}

export interface VerifyOptions {
  /** The transcript was noise and an empty answer is the right one. */
  allowEmpty?: boolean
  /**
   * The dictation language ('auto' or ISO-639-1). The number reader only knows English number
   * words; for another pinned language the model may write spoken numbers as digits the reader
   * cannot see in the transcript, so only the digits the transcript already had are enforced.
   */
  language?: string
  /** Phrases that must survive verbatim (snippet triggers); checked case-insensitively. */
  keepVerbatim?: readonly string[]
}

/** Content words: letters only, three or more, not part of a number. */
function contentWords(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? []) {
    if (w.length >= 3 && !isNumberWord(w)) out.add(w.replace(/^['’]+|['’]+$/g, ''))
  }
  return out
}

/** `text` is the cleaned model output; `transcript` is what the model was given. */
export function verifyOutput(transcript: string, text: string, opts: VerifyOptions = {}): Verdict {
  const raw = transcript.trim()
  if (!text.trim()) return opts.allowEmpty ? { ok: true } : { ok: false, reason: 'empty' }
  if (CHATTY_PREFIX.test(text) && !CHATTY_PREFIX.test(raw)) return { ok: false, reason: 'chatty' }
  if (PROMPT_ECHO.test(text) && !PROMPT_ECHO.test(raw)) return { ok: false, reason: 'echo' }

  const rawUnits = countUnits(raw)
  const outUnits = countUnits(text)
  if (rawUnits >= 6) {
    const ratio = outUnits / rawUnits
    if (ratio < 0.3) return { ok: false, reason: 'too-short' }
    if (ratio > 2.2) return { ok: false, reason: 'too-long' }
  } else if (outUnits > rawUnits + 6) {
    return { ok: false, reason: 'too-long' }
  }

  // A dictated question must still be a question; an answer is the classic failure.
  if (isQuestion(raw) && countWords(raw) >= 3 && !text.includes('?')) {
    const firstOut = text.split(/(?<=[.!?])\s+/)[0] ?? text
    if (!QUESTION_START.test(firstOut)) return { ok: false, reason: 'answered' }
  }

  // The rewrite must share most of its content words with the transcript.
  const rawSet = contentWords(raw)
  const outSet = contentWords(text)
  if (rawSet.size >= 4 && outSet.size >= 3) {
    let shared = 0
    for (const w of outSet) if (rawSet.has(w)) shared++
    if (shared / outSet.size < 0.45) return { ok: false, reason: 'diverged' }
  }

  // Content said twice that the speaker said once (a looping or padding model).
  if (repeatedRuns(raw, text, 4).length) return { ok: false, reason: 'repeated' }

  // Phrases the caller needs verbatim (a snippet trigger the client expands afterwards).
  for (const phrase of opts.keepVerbatim ?? []) {
    const p = phrase.trim().toLowerCase()
    if (p && raw.toLowerCase().includes(p) && !text.toLowerCase().includes(p))
      return { ok: false, reason: 'verbatim-lost', expected: phrase }
  }

  // Same numbers, same order. List numbering the model added is not a number the speaker said,
  // unless the speaker said it ("number one ..., number two ...").
  const expected = digitSignature(raw)
  const withoutMarkers = digitSignature(text, true)
  const withMarkers = digitSignature(text, false)
  const lang = (opts.language ?? 'auto').trim().toLowerCase().split(/[-_]/)[0]
  if (lang && lang !== 'auto' && lang !== 'en') {
    // Number words in this language are invisible to the reader: the model may legitimately turn
    // them into digits, but every digit the transcript already had must still be there, in order.
    if (!withoutMarkers.includes(expected) && !withMarkers.includes(expected))
      return { ok: false, reason: 'numbers-changed', expected, actual: withoutMarkers }
    return { ok: true }
  }
  if (withoutMarkers !== expected && withMarkers !== expected)
    return { ok: false, reason: 'numbers-changed', expected, actual: withoutMarkers }
  return { ok: true }
}

// ---- repetition and layout ------------------------------------------------------------------

const runWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

function runCounts(w: readonly string[], n: number): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i + n <= w.length; i++) {
    const k = w.slice(i, i + n).join(' ')
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/**
 * Word runs the answer repeats more often than the transcript did: any three-word run, or a word
 * doubled in place ("LibriVox.org LibriVox.org"). A model that loops, or pads a short piece by
 * saying part of it twice, shows up here; a speaker who repeated themselves does not.
 */
export function repeatedRuns(transcript: string, text: string, n = 3): string[] {
  const a = runWords(transcript)
  const b = runWords(text)
  const out: string[] = []
  const inA = runCounts(a, n)
  for (const [k, v] of runCounts(b, n)) if (v >= 2 && v > (inA.get(k) ?? 0)) out.push(k)
  const doubledInA = new Set<string>()
  for (let i = 1; i < a.length; i++) if (a[i] === a[i - 1]) doubledInA.add(a[i])
  for (let i = 1; i < b.length; i++)
    if (b[i] === b[i - 1] && b[i].length > 2 && !doubledInA.has(b[i])) out.push(`${b[i]} ${b[i]}`)
  return out
}

/** The speaker asked for layout: a dictated break, a break already in the text, or a list. */
const LAYOUT_CUE =
  /\n|\b(?:new|next) (?:line|paragraph)\b|\b(?:bullet|number) (?:one|two|1|2)\b|\b(?:first(?:ly)?|second(?:ly)?)\b[\s\S]*\b(?:second(?:ly)?|third(?:ly)?|finally|lastly)\b|:\s*\S/i
const LIST_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/m

/**
 * Repairs that cost no round trip, applied before the invariants:
 *   - a word or short run the model said twice in a row, where the transcript did not, is said once;
 *   - line breaks in a dictation that asked for no layout become spaces (lists are kept).
 */
export function repairOutput(transcript: string, text: string): string {
  let out = text
  {
    // Immediate repeats of 1–6 words ("a b c a b c" -> "a b c"), only where the transcript has none.
    out = out.replace(
      /(?<![\p{L}\p{N}])((?:[\p{L}\p{N}][\p{L}\p{N}'’.@/-]*[\s,]+){0,5}[\p{L}\p{N}][\p{L}\p{N}'’.@/-]*)(?:[\s,.;]+\1)+(?![\p{L}\p{N}])/giu,
      (match, run: string) => {
        // Numbers are the speaker's: a repeated amount was read out on purpose (see numbers.ts).
        if (/\d/.test(run)) return match
        const key = runWords(run).join(' ')
        const inInput = runWords(transcript).join(' ')
        return inInput.includes(`${key} ${key}`) ? match : run
      }
    )
  }
  if (out.includes('\n') && !LAYOUT_CUE.test(transcript) && !LIST_LINE.test(out))
    out = out.replace(/[ \t]*\n+[ \t]*/g, ' ')
  return out.trim()
}

/** The pronoun "i" alone or in a contraction, but not "i.e." or part of a longer word. */
const LOWER_I = /(?<![\p{L}\p{N}'’._@/\\-])i(?=(?:['’](?:m|ll|ve|d))?(?![\p{L}\p{N}'’_@/\\-])(?!\.\p{L}))/gu
const SENTENCE_LOWER = /([.!?]["')\]]*\s+)(\p{Ll}[\p{L}\p{N}'’-]*)/gu

/**
 * Capitals the model dropped. Told a piece continues an unfinished sentence ("mid-sentence means
 * no capital"), a model sometimes lower-cases far more than the first word: "i need you to…",
 * whole sentences after a period (Oct 27 2026, phone dictations). The pronoun "I" and a lower-case
 * word right after a sentence end get their capital back, unless the transcript itself wrote them
 * that way, the word is mixed-case ("iPhone"), or the period ends an abbreviation or an ellipsis.
 * The first word is left alone (it may continue the text before the cursor). Not in code or a
 * terminal, nor when the user's instructions ask for lower case or the text before the cursor is
 * written all in lower case (the model was told to match its style).
 */
export function repairCase(
  transcript: string,
  text: string,
  ctx: Pick<FormatContext, 'category' | 'instructions' | 'precedingText'>
): string {
  if (ctx.category === 'code' || ctx.category === 'terminal') return text
  if (/lower[\s-]?case|no capital/i.test(ctx.instructions ?? '')) return text
  const before = ctx.precedingText ?? ''
  if (countWords(before) >= 3 && !/\p{Lu}/u.test(before)) return text
  let out = text
  if (!new RegExp(LOWER_I.source, 'u').test(transcript)) out = out.replace(LOWER_I, 'I')
  out = out.replace(SENTENCE_LOWER, (m: string, sep: string, word: string, offset: number, whole: string) => {
    if (/\p{Lu}/u.test(word)) return m
    const before = whole.slice(0, offset + 1)
    if (sep.startsWith('.') && (ABBREVIATION.test(before) || /\.\.$/u.test(before) || /\.\p{L}+\.$/u.test(before)))
      return m
    if (transcript.includes(`${sep.trim()} ${word}`)) return m
    return sep + word.charAt(0).toUpperCase() + word.slice(1)
  })
  return out
}

/**
 * Did the formatted text keep how the transcript ends? The last two words of 3+ letters must
 * appear, in order, among the last 10 words of the output. A formatter that dropped or moved
 * trailing words ("…and performance" gone, "chat" carried into the next sentence) fails, and the
 * caller uses the rule-based text instead. Cheap and local: no extra round trip.
 */
export function endingKept(transcript: string, text: string): boolean {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[’]/g, "'")
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean)
  const want = norm(transcript)
    .filter((w) => w.replace(/'/g, '').length >= 3)
    .slice(-2)
  if (!want.length) return true
  const tail = norm(text).slice(-10)
  let at = 0
  for (const w of want) {
    const i = tail.indexOf(w, at)
    if (i < 0) return false
    at = i + 1
  }
  return true
}
