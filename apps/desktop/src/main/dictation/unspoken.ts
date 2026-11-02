import { pitchedMs } from '@core/audio/vad'
import type { TranscribeOutput } from '@core/stt'
import {
  dropLastWords,
  STOCK_PHRASE_MIN_PITCHED_MS,
  trailingStockPhrase,
  type TimedWord
} from '@engine'
import { createLogger } from '../logger'

const log = createLogger('session')
const SAMPLE_RATE = 16000

/**
 * A transcript that ends with a stock phrase ("…right to me. Thank you.") whose words, by the
 * model's own timings, sit on audio with no pitch in it (a breath, a rustle, the quiet after the
 * last word) loses that phrase. Whisper adds such endings to noise; a speaker who says "thank you"
 * leaves a few hundred ms of voiced sound under it, and keeps it. Needs word timings, and a
 * transcript that is one answer for exactly this clip (not resumed or joined).
 */
export function dropUnspokenEnding<T extends TranscribeOutput & { resumed?: number }>(
  out: T,
  clip: Int16Array,
  tag = ''
): T {
  if (out.resumed) return out
  const raw = (out.raw as { words?: Array<{ word?: unknown; start?: unknown; end?: unknown }> })
    ?.words
  if (!Array.isArray(raw) || !raw.length) return out
  const words: TimedWord[] = raw.flatMap((w) =>
    typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number'
      ? [{ word: w.word, start: w.start, end: w.end }]
      : []
  )
  if (words.length !== raw.length) return out
  const phrase = trailingStockPhrase(words)
  // The whole transcript being the phrase is the "nothing heard" check's job.
  if (!phrase || phrase.count >= words.length) return out
  const pitched = pitchedMs(clip, SAMPLE_RATE, phrase.start - 0.1, phrase.end + 0.1)
  if (pitched >= STOCK_PHRASE_MIN_PITCHED_MS) return out
  const text = dropLastWords(out.text, phrase.count)
  if (!text || text === out.text) return out
  log.info(
    `session ${tag}: dropped "${out.text.slice(text.length).trim()}" at the end: no voice under it (${pitched} ms pitched)`
  )
  return { ...out, text }
}
