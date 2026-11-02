import { SPLIT_WORDS } from './clean'
import { COMMON_WORDS } from './common-words'

/**
 * Sentence ends the speech model put at a pause, where no sentence can end. Whisper ends a
 * sentence wherever the speaker paused, so "the fix is to. Remember the window" and "I could. Not
 * reproduce it" arrive with a stray period and capital. Two cases are certain enough to repair
 * without the model (which is told to repair the rest, and does not always run):
 *  - the sentence ends on an article, possessive, preposition or conjunction (SPLIT_WORDS);
 *  - it ends on a modal or auxiliary and the next starts "Not" followed by a word that carries
 *    the clause on ("I could. Not reproduce it"), not a short reply ("I wish I could. Not today.").
 * The next word is written in lower case only when it is a frequent word (COMMON_WORDS) that is not
 * capitalized mid-sentence elsewhere in the text; anything else (a name, "I") keeps its capital. Mirrored by the Android port (PauseStops.kt).
 */

const SPLIT = new Set(SPLIT_WORDS)

const AUXILIARY = new Set(
  (
    'could would should can will did does do is are was were has have had might must may ' +
    'need shall'
  ).split(' ')
)

/** After "Not", words that make it a reply or fragment of its own ("Not today", "Not at all"). */
const NOT_FRAGMENT = new Set(
  (
    'today tonight now yet really sure quite much exactly at always anymore even in for that this ' +
    'me you us them him her it a an the so too again ever necessarily everyone everything all ' +
    'only just bad great good likely possible mine here there when if because with without to ' +
    'after before until since one any like enough necessarily entirely completely'
  ).split(' ')
)

const STOP = /(\p{L}+)(['’]\p{L}+)?\.(\s+)(\p{Lu}[\p{L}'’]*)(?=(\s+([\p{L}'’]+))?)/gu

function isName(word: string, text: string): boolean {
  if (/^I(['’](m|ll|ve|d))?$/u.test(word)) return true
  if (word.length > 1 && word === word.toUpperCase()) return true
  // Capitalized after a word or a comma somewhere: a name, not a sentence start.
  return new RegExp(`[\\p{L}\\p{N},;:]\\s+${word}(?![\\p{L}'’])`, 'u').test(text)
}

export function joinPauseStops(text: string): string {
  return text.replace(
    STOP,
    (
      m: string,
      last: string,
      clitic: string | undefined,
      _space: string,
      next: string,
      _rest: string | undefined,
      after: string | undefined
    ) => {
      // "plan A. Then": a capital letter is a name for an option, not an article.
      if (clitic || !/^\p{Ll}/u.test(last)) return m
      const key = last.toLowerCase()
      const split = SPLIT.has(key)
      const not =
        AUXILIARY.has(key) &&
        next === 'Not' &&
        after !== undefined &&
        !NOT_FRAGMENT.has(after.toLowerCase())
      if (!split && !not) return m
      const lower = next.toLowerCase()
      const kept = COMMON_WORDS.has(lower) && !isName(next, text) ? lower : next
      return `${last} ${kept}`
    }
  )
}
