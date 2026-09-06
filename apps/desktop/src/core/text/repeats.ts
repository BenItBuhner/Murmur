import type { RepetitionScope } from '@shared/settings'
import { NUMBER_WORDS } from './numbers'

/**
 * Repetition cleanup, from the safest to the most aggressive:
 *   words     "the the report", "I, I think", part-word stutters "th- the"
 *   phrases   repeated runs of up to five words: "I think, I think we should", "we need to we need to"
 *   thorough  abandoned restarts: "I want to, I need to go" -> "I need to go"
 *
 * Repetition is only noise when it is a stumble. People stumble over the small words that hold a
 * sentence together ("I, I think", "the the report"); they repeat content words on purpose, for
 * emphasis or feeling ("no, no, no", "very, very slowly", "fuck, fuck, fuck", "go go go"). So a
 * repeat separated by pauses, or said three or more times, stays unless the word is one people
 * stumble over; a bare double ("report report") is a stutter unless the word is a usual emphatic.
 */

const W = "[\\p{L}\\p{N}'’]"
const NOT_W = "(?<![\\p{L}\\p{N}'’])"
const END_W = "(?![\\p{L}\\p{N}'’])"

/**
 * Words people stumble over rather than stress: pronouns, articles, prepositions, conjunctions,
 * auxiliaries, question words. Their repeats are stutters whatever the punctuation.
 */
export const STUTTER_PRONE = new Set([
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'to',
  'of',
  'in',
  'at',
  'for',
  'with',
  'from',
  'by',
  'about',
  'into',
  'and',
  'but',
  'or',
  'because',
  'if',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'shall',
  'may',
  'might',
  'must',
  'what',
  'who',
  'where',
  'when',
  'why',
  'how',
  'which',
  'just',
  'like',
  'let',
  'gonna',
  'wanna',
  "i'm",
  "it's",
  "that's",
  "there's",
  "don't"
])

/** Usual emphatics: even a bare double ("very very good", "no no") is on purpose. */
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

const PAUSE = /[,–—-]/

export function collapseRepeats(text: string, scope: RepetitionScope = 'words'): string {
  if (!text) return text
  // Twice: "s- s- something" reveals the first fragment only once the second is gone.
  let out = text.replace(PART_WORD_STUTTER, '').replace(PART_WORD_STUTTER, '')
  out = out.replace(WORD_REPEAT, (match, word: string, rest: string) => {
    const lower = word.toLowerCase()
    // "five five five one two one two" is a phone number, not a stutter.
    if (NUMBER_WORDS.has(lower) || /^\d+$/.test(lower)) return match
    const paused = PAUSE.test(rest)
    if (GRAMMATICAL_DOUBLES.has(lower) && !paused) return match
    // "I, I think", "the the report": a stumble however it was said.
    if (STUTTER_PRONE.has(lower)) return word
    // "fuck, fuck, fuck", "very, very slowly": the pauses are the speaker stressing each copy.
    if (paused) return match
    // "go go go", "no no no": nobody says a word three times by accident.
    const copies = 1 + (rest.match(new RegExp(`${W}+`, 'gu')) ?? []).length
    if (copies >= 3 || EMPHASIS.has(lower)) return match
    return word
  })
  if (scope === 'words') return out

  // Repeat until stable: collapsing one run can expose another ("I think I think, I think").
  for (let guard = 0; guard < 5; guard++) {
    const next = out.replace(PHRASE_REPEAT, (match, phrase: string) => {
      const rest = match.slice(phrase.length)
      const words = (phrase.match(new RegExp(`${W}+`, 'gu')) ?? []).map((w) => w.toLowerCase())
      // "go go go go": one word said many times was already judged by the word pass.
      if (words.every((w) => w === words[0])) return match
      // "go away, go away" is said on purpose; "I think, I think we should" is a restart.
      if (PAUSE.test(rest) && !STUTTER_PRONE.has(words[0])) return match
      return phrase
    })
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
