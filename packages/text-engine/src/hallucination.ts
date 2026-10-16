/**
 * Whisper-family models, given a clip with no speech in it (the quiet tail of a streamed
 * dictation, a breath, a click), answer with the closing lines of the videos they were trained
 * on: "Thank you.", "Thanks for watching!", "you". Those words are dropped only when the model
 * itself says the audio held no speech (`no_speech_prob`), or the clip is too short to hold the
 * phrase; a speaker who says "thank you" keeps it.
 */

const PHRASES = [
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'thank you for listening',
  'thank you for watching and see you next time',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'subtitles by the amara org community',
  'transcribed by',
  'you',
  'bye',
  'bye bye',
  'okay',
  'so',
  'uh',
  'um',
  'hmm'
]
const KNOWN = new Set(PHRASES)

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The whole text is one of the phrases a model says to silence (repeats included). */
export function isSilenceHallucination(text: string): boolean {
  const n = normalizePhrase(text)
  if (!n) return false
  if (KNOWN.has(n)) return true
  // "Thank you. Thank you." and the like.
  for (const p of PHRASES) {
    if (n.length % (p.length + 1) !== p.length) continue
    const parts = n.split(' ')
    const pw = p.split(' ').length
    if (parts.length % pw !== 0) continue
    let all = true
    for (let i = 0; i < parts.length; i += pw) if (parts.slice(i, i + pw).join(' ') !== p) all = false
    if (all) return true
  }
  return false
}

/** Shorter than this, a clip cannot hold even "thank you". */
export const TOO_SHORT_FOR_SPEECH_SEC = 0.5
/** A segment the model rates at least this likely to be silence, with only a stock phrase in it. */
export const NO_SPEECH_PROB = 0.6

interface Segment {
  text?: unknown
  no_speech_prob?: unknown
  [k: string]: unknown
}

/**
 * The segments of a verbose answer, minus those that are a stock phrase over silence. Returns
 * null when nothing was dropped (so the answer can be passed through byte for byte).
 */
export function dropSilentSegments(
  answer: { text?: unknown; segments?: unknown },
  clipSec: number | null
): { text: string; segments: Segment[] | undefined } | null {
  const short = clipSec !== null && clipSec < TOO_SHORT_FOR_SPEECH_SEC
  if (Array.isArray(answer.segments) && answer.segments.length) {
    const segments = answer.segments as Segment[]
    const keep = segments.filter((s) => {
      const t = typeof s.text === 'string' ? s.text : ''
      const p = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0
      return !(isSilenceHallucination(t) && (p >= NO_SPEECH_PROB || short))
    })
    if (keep.length === segments.length) return null
    const text = keep
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .join('')
      .trim()
    return { text, segments: keep }
  }
  const text = typeof answer.text === 'string' ? answer.text : ''
  if (short && isSilenceHallucination(text)) return { text: '', segments: undefined }
  return null
}

/** Voiced time below which a stock phrase is taken for silence ("thank you" itself is ~400 ms voiced). */
export const TAIL_PHRASE_MIN_SPEECH_MS = 120

/**
 * A stock phrase is dropped only on audio evidence: the model rated it as silence, or (without a
 * rating) the audio held almost no voiced frames. Never on the text alone.
 */
export function isSilentStockPhrase(text: string, speechMs: number, noSpeechProb?: number): boolean {
  if (!isSilenceHallucination(text)) return false
  if (noSpeechProb !== undefined) return noSpeechProb >= NO_SPEECH_PROB
  return speechMs < TAIL_PHRASE_MIN_SPEECH_MS
}
