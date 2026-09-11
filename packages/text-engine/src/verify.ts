import { countUnits, digitSignature, isNumberWord } from './numbers'
import { QUESTION_START, countWords, isQuestion } from './text'

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
