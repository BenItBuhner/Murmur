import type { RepetitionScope } from '@shared/settings'
import { NUMBER_WORDS } from './numbers'

/**
 * Repetition cleanup, from the safest to the most aggressive:
 *   words     "the the report", "I, I think", part-word stutters "th- the"
 *   phrases   repeated runs of up to five words: "I think, I think we should", "we need to we need to"
 *   thorough  abandoned restarts: "I want to, I need to go" -> "I need to go"
 * Intentional repetition survives: "no, no, no" and "very, very good" keep their commas.
 */

const W = "[\\p{L}\\p{N}'’]"
const NOT_W = "(?<![\\p{L}\\p{N}'’])"
const END_W = "(?![\\p{L}\\p{N}'’])"

/** Words people repeat on purpose; kept when the transcript separates the copies with commas. */
const EMPHASIS = new Set([
  'no',
  'yes',
  'yeah',
  'very',
  'really',
  'so',
  'go',
  'come',
  'please',
  'okay',
  'ok',
  'wait',
  'stop',
  'hey',
  'bye',
  'ha',
  'haha',
  'well',
  'again',
  'never',
  'ever',
  'more',
  'now',
  'quick',
  'quickly',
  'many',
  'much',
  'far',
  'long',
  'down',
  'up',
  'on',
  'out',
  'there',
  'here',
  'ah',
  'oh',
  'wow',
  'hi',
  'hello',
  'hurry',
  'run',
  'sorry',
  'thanks'
])

/** Adjacent doubles that are grammatical English. */
const GRAMMATICAL_DOUBLES = new Set(['that', 'had'])

/** "th- the report", "s- s- something" -> the fragment is a prefix of the next word. */
const PART_WORD_STUTTER = new RegExp(`${NOT_W}(\\p{L}{1,3})[-–—]\\s+(?=\\1\\p{L})`, 'giu')

const WORD_REPEAT = new RegExp(`${NOT_W}(${W}+)((?:\\s*[,–—-]?\\s+\\1${END_W})+)`, 'giu')

const PHRASE_REPEAT = new RegExp(
  `${NOT_W}(${W}+(?:\\s+${W}+){1,4})(?:\\s*[,–—-]?\\s+\\1${END_W})+`,
  'giu'
)

/** The word a speaker stops on when they abandon a phrase and start over. */
const RESTART_TAILS = new Set([
  'to',
  'the',
  'a',
  'an',
  'and',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'that',
  'is',
  'was',
  'are',
  'were',
  'it',
  "it's",
  'should',
  'could',
  'would',
  'can',
  'will',
  'might',
  'may',
  'must',
  'have',
  'has',
  'had',
  'be',
  'been',
  'do',
  'does',
  'did',
  "don't",
  "doesn't",
  "didn't",
  'not',
  'going',
  'gonna',
  'want',
  'wanna',
  'need',
  'my',
  'your',
  'our',
  'their',
  'this',
  'these',
  'those'
])

/** A pause followed by the first two words of the restarted clause. */
const RESTART_SEPARATOR = new RegExp(`\\s*[,–—-]\\s+(${W}+)(\\s+)(${W}+)`, 'giu')
const WORD_TOKEN = new RegExp(`${W}+`, 'gu')

export function collapseRepeats(text: string, scope: RepetitionScope = 'words'): string {
  if (!text) return text
  // Twice: "s- s- something" reveals the first fragment only once the second is gone.
  let out = text.replace(PART_WORD_STUTTER, '').replace(PART_WORD_STUTTER, '')
  out = out.replace(WORD_REPEAT, (match, word: string, rest: string) => {
    const lower = word.toLowerCase()
    // "five five five one two one two" is a phone number, not a stutter.
    if (NUMBER_WORDS.has(lower) || /^\d+$/.test(lower)) return match
    if (GRAMMATICAL_DOUBLES.has(lower) && !/[,–—-]/.test(rest)) return match
    if (EMPHASIS.has(lower) && /[,–—-]/.test(rest)) return match
    return word
  })
  if (scope === 'words') return out

  // Repeat until stable: collapsing one run can expose another ("I think I think, I think").
  for (let guard = 0; guard < 5; guard++) {
    const next = out.replace(PHRASE_REPEAT, '$1')
    if (next === out) break
    out = next
  }
  if (scope !== 'thorough') return out
  return removeFalseStarts(out)
}

/**
 * "I want to, I need to go" -> "I need to go". The abandoned fragment is the last two to four
 * words before the pause; it must start with the same word the speaker restarts with, end on a
 * word nobody stops on deliberately, and differ from the restart in its second word (an
 * identical second word is a plain repeat, handled above).
 */
export function removeFalseStarts(text: string): string {
  let out = ''
  let cursor = 0
  RESTART_SEPARATOR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RESTART_SEPARATOR.exec(text))) {
    const [, c1, gap, c2] = m
    const end = m.index + m[0].length
    const before = text.slice(cursor, m.index)
    const words = [...before.matchAll(WORD_TOKEN)]
    let cut = -1
    let fragFirst = ''
    const tail = words[words.length - 1]
    if (
      tail &&
      RESTART_TAILS.has(tail[0].toLowerCase()) &&
      /^\s*$/.test(before.slice(tail.index + tail[0].length))
    ) {
      for (let n = 2; n <= 4 && n <= words.length; n++) {
        const frag = words.slice(-n)
        const fragText = before.slice(frag[0].index)
        if (/[.,;:!?\n]/.test(fragText)) break
        if (frag[0][0].toLowerCase() !== c1.toLowerCase()) continue
        if (frag[1][0].toLowerCase() === c2.toLowerCase()) break
        cut = frag[0].index
        fragFirst = frag[0][0]
        break
      }
    }
    if (cut >= 0) {
      const restart = /^\p{Lu}/u.test(fragFirst) ? c1[0].toUpperCase() + c1.slice(1) : c1
      out += `${before.slice(0, cut)}${restart}${gap}${c2}`
    } else {
      out += text.slice(cursor, end)
    }
    cursor = end
  }
  return out + text.slice(cursor)
}
