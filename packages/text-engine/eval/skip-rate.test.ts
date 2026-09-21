import { describe, expect, it } from 'vitest'
import { CLEAN_MAX_WORDS, alreadyClean, type NotCleanReason } from '../src/clean'
import { prepareTranscript } from '../src/cleanup'
import { countWords } from '../src/text'
import type { FormatContext } from '../src/types'
import { contextOf, loadFixtures } from './score'

/**
 * How often the clean skip fires, on the corpus and on a synthetic mix of dictations, and what
 * that is worth. The mix is deterministic (seeded) and built from the monetization analysis's
 * personas: dictation length is log-normal around each persona's mean clip (light 8 s, median
 * 14 s, heavy 20 s, free 12 s at 2.5 words/s, sigma 0.9), personas weighted by how many
 * dictations they make (paid base mix 50/35/15 users at 110/550/2,600 dictations a month), and
 * imperfections injected with the probabilities below. Those probabilities are assumptions, not
 * measurements: there is no usage data yet. The run doubles as a generative test of the rules:
 * every injected imperfection must keep the model, every clean dictation within the cap must skip.
 */

const SEED = 7
const N = 10_000
const WORDS_PER_SECOND = 2.5
const SIGMA = 0.9
/**
 * Per-dictation probability of each imperfection; independent of each other. Fillers are rarer
 * in a transcript than in speech because Whisper tends to leave "um" and "uh" out on its own.
 */
const DIRT = {
  filler: 0.15,
  number: 0.18,
  command: 0.05,
  stutter: 0.06,
  correction: 0.04,
  enumeration: 0.03,
  question: 0.02,
  unpunctuated: 0.03,
  foreign: 0.02,
  instructions: 0.08,
  tone: 0.08,
  preceding: 0.1,
  destination: 0.1,
  language: 0.05,
  verbatim: 0.01
} as const
type Dirt = keyof typeof DIRT
/** LLM share of one median dictation's inference cost ($0.00011 of $0.00028) and the Groq Free LLM budget. */
const LLM_SHARE = 0.00011 / 0.00028
const FREE_LLM_DICTATIONS_PER_DAY = 154

interface Persona {
  name: string
  seconds: number
  /** Share of all dictations in the mix. */
  weight: number
}
const PAID: Persona[] = [
  { name: 'light', seconds: 8, weight: 0.5 * 110 },
  { name: 'median', seconds: 14, weight: 0.35 * 550 },
  { name: 'heavy', seconds: 20, weight: 0.15 * 2600 }
]
const FREE: Persona = { name: 'free', seconds: 12, weight: 1 }

const STATEMENTS = [
  'Sounds good, see you tomorrow.',
  "Thanks for the update, I'll take a look this afternoon.",
  'On my way.',
  'Okay, sounds good.',
  'Looks great to me!',
  'Please review the attached document and let me know your thoughts.',
  'Let me know if you have any questions.',
  'Follow up with Sarah about the vendor contract.',
  'Just checking in on the proposal.',
  'No problem, happy to help.',
  "I'll send the notes after the meeting.",
  'The build is green again.',
  'Perfect, thanks a lot.',
  'We moved the deck to the shared drive yesterday.',
  'I think that works for everyone.',
  "Let's push the launch to next week.",
  'She will join the call from the airport.',
  'Kind regards, Ben.',
  'I like the new design a lot.',
  'Sorry for the delay, the train was late.',
  "Yeah, let's do that.",
  "Ping me when you're free.",
  'The client loved the demo.',
  'Lunch is on me today.',
  'Remind me to call the dentist tomorrow morning.',
  'Great work on the release, everyone!',
  'See you at the office.',
  "I'm heading out for the day.",
  'The report is ready for review.',
  "Let's grab coffee after standup.",
  'Thanks again for your patience with this.',
  'Please loop in legal before we sign anything.',
  "It's late, so let's stop here.",
  'That sounds like a plan.',
  'We should revisit the roadmap after the offsite.',
  'Please review the attached document and let me know your thoughts by the end of the week.',
  'I spoke with the vendor this morning and they are happy to extend the trial for us.',
  "Let's move the weekly sync to the afternoon so the London team can join without staying late.",
  'The onboarding flow still drops people at the permissions screen, so we should look at the copy there.'
]
const QUESTIONS = [
  'Can you send me the link to the doc?',
  'Are you coming tonight?',
  'What time works for you tomorrow?',
  'Could you share the slides after the call?',
  'Is the vendor contract signed yet?',
  'Where should we meet for lunch?'
]
const FOREIGN = [
  'Ich schicke dir das morgen.',
  'Je vous envoie le rapport demain.',
  'Te mando el informe, gracias.',
  'Ik stuur het morgen.',
  'Ci vediamo domani, grazie.',
  'Vamos falar amanha, obrigado.',
  'Jag skickar det imorgon.',
  'Tamam, evet.'
]

/** mulberry32: small, seedable, good enough for a mix. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function logNormalWords(random: () => number, meanWords: number): number {
  const u = Math.max(random(), 1e-12)
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
  const mu = Math.log(meanWords) - (SIGMA * SIGMA) / 2
  return Math.min(120, Math.max(3, Math.round(Math.exp(mu + SIGMA * z))))
}

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z']+/g) ?? []
const unpunct = (s: string): string => s.replace(/[.!?]$/, '')
const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)]

/** Would joining `next` after `prev` say a word, or a run of up to three, twice in a row? */
function joinRepeats(prev: string, next: string): boolean {
  const a = wordsOf(prev)
  const b = wordsOf(next)
  for (let n = 1; n <= 3; n++) {
    if (a.length < n || b.length < n) continue
    if (a.slice(-n).join(' ') === b.slice(0, n).join(' ')) return true
  }
  return false
}

/**
 * Concatenate distinct clean sentences up to the word budget (at most two words over it), without
 * creating a stutter at a join.
 */
const POOL = [...STATEMENTS, ...QUESTIONS].map((s) => ({ s, words: countWords(s) }))

function compose(random: () => number, budget: number): string {
  const parts: string[] = []
  let words = 0
  for (;;) {
    const fits = POOL.filter(
      (p) =>
        p.words <= budget - words + 2 &&
        !parts.includes(p.s) &&
        !(parts.length && joinRepeats(parts[parts.length - 1], p.s))
    )
    if (!fits.length) break
    const p = pick(random, fits)
    parts.push(p.s)
    words += p.words
    if (words >= budget) break
  }
  return parts.length ? parts.join(' ') : 'On my way.'
}

function dirty(random: () => number, text: string, dirt: Dirt): string {
  const v = Math.floor(random() * 4)
  switch (dirt) {
    case 'filler':
      return [
        `Um, ${text}`,
        text.replace(/^(\S+)/, '$1, um,'),
        `${unpunct(text)}, you know.`,
        `So ${text.charAt(0).toLowerCase()}${text.slice(1)}`
      ][v]
    case 'number':
      return [
        `${unpunct(text)} at five thirty.`,
        `${unpunct(text)} in 10 minutes.`,
        `Two things. ${text}`,
        `${unpunct(text)} on March third.`
      ][v]
    case 'command':
      return [
        text.replace(/^(\S+)/, '$1 new line'),
        `${unpunct(text)} period.`,
        `Quote ${unpunct(text)} end quote.`,
        `Scratch that, ${text}`
      ][v]
    case 'stutter':
      return v < 2 ? text.replace(/^(\S+?)([,.!?]?)\s/, '$1 $1$2 ') : text.replace(/(\S+) (\S+?)([.!?])$/, '$1 $2, $2$3')
    case 'correction':
      return v < 2 ? `${unpunct(text)}, no, tomorrow.` : `${unpunct(text)}, I meant Wednesday.`
    case 'enumeration':
      return v < 2 ? `Firstly, ${text}` : `${text} Secondly, the vendor.`
    case 'question':
      return pick(random, QUESTIONS).replace(/\?$/, '.')
    case 'unpunctuated':
      return unpunct(text).toLowerCase()
    case 'foreign':
      return pick(random, FOREIGN)
    case 'verbatim':
      return `${unpunct(text)} with my sig.`
    default:
      return text
  }
}

const TEXT_DIRT: Dirt[] = [
  'filler',
  'number',
  'command',
  'stutter',
  'correction',
  'enumeration',
  'question',
  'unpunctuated',
  'foreign',
  'verbatim'
]

interface Sample {
  persona: string
  text: string
  context: FormatContext
  dirt: Dirt[]
}

function generate(random: () => number, personas: Persona[]): Sample[] {
  const total = personas.reduce((s, p) => s + p.weight, 0)
  const out: Sample[] = []
  for (let i = 0; i < N; i++) {
    let r = random() * total
    const persona = personas.find((p) => (r -= p.weight) < 0) ?? personas[personas.length - 1]
    let text = compose(random, logNormalWords(random, persona.seconds * WORDS_PER_SECOND))
    const dirt = (Object.keys(DIRT) as Dirt[]).filter((d) => random() < DIRT[d])
    // Destination is picked first, so the tone the destination implies is known.
    const category: FormatContext['category'] = dirt.includes('destination')
      ? random() < 0.5
        ? 'code'
        : 'terminal'
      : pick(random, ['chat', 'chat', 'email', 'document', 'notes', 'browser', 'unknown'] as const)
    const defaultTone = category === 'chat' ? 'casual' : category === 'email' || category === 'document' ? 'professional' : 'neutral'
    const context: FormatContext = {
      category,
      tone: dirt.includes('tone') ? (defaultTone === 'casual' ? 'professional' : 'casual') : defaultTone,
      dictionary: [],
      language: dirt.includes('language') ? 'de' : 'auto',
      instructions: dirt.includes('instructions') ? 'British spelling.' : undefined,
      precedingText: dirt.includes('preceding') ? 'I think we should' : undefined,
      keepVerbatim: dirt.includes('verbatim') ? ['my sig'] : undefined
    }
    for (const d of TEXT_DIRT) if (dirt.includes(d)) text = dirty(random, text, d)
    out.push({ persona: persona.name, text, context, dirt })
  }
  return out
}

const pct = (n: number, d: number): string => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`

describe('clean skip rate', () => {
  it('every pool sentence is clean on its own', () => {
    const chat: FormatContext = { category: 'chat', tone: 'casual', dictionary: [], language: 'auto' }
    for (const s of [...STATEMENTS, ...QUESTIONS]) {
      const d = alreadyClean(prepareTranscript(s), chat, { maxWords: 100 })
      expect(d.clean, `${s}: ${d.reason}`).toBe(true)
    }
  })

  it('skips exactly the clean short dictations of a synthetic realistic mix, and reports the rate', { timeout: 60_000 }, () => {
    const random = rng(SEED)
    const paid = generate(random, PAID)
    const free = generate(random, [FREE])
    const reasons = new Map<NotCleanReason, number>()
    const byPersona = new Map<string, { n: number; clean: number }>()
    let cleanPaid = 0
    for (const sample of [...paid, ...free]) {
      const d = alreadyClean(prepareTranscript(sample.text), sample.context)
      const words = countWords(prepareTranscript(sample.text).text)
      if (sample.dirt.length) expect(d.clean, `${sample.text} [${sample.dirt}] -> ${d.reason}`).toBe(false)
      else if (words <= CLEAN_MAX_WORDS) expect(d, sample.text).toEqual({ clean: true })
      else expect(d.reason, sample.text).toBe('long')
      const p = byPersona.get(sample.persona) ?? { n: 0, clean: 0 }
      p.n++
      if (d.clean) p.clean++
      byPersona.set(sample.persona, p)
      if (!d.clean) reasons.set(d.reason!, (reasons.get(d.reason!) ?? 0) + 1)
    }
    for (const p of PAID) cleanPaid += byPersona.get(p.name)?.clean ?? 0
    const cleanFree = byPersona.get('free')?.clean ?? 0

    const caps = [12, 16, 20, 25, 1000].map((cap) => {
      const n = paid.filter((s) => alreadyClean(prepareTranscript(s.text), s.context, { maxWords: cap }).clean).length
      return `${cap === 1000 ? 'no cap' : cap} -> ${pct(n, paid.length)}`
    })
    const skip = cleanPaid / paid.length
    console.log(
      [
        `[skip-rate] corpus: ${loadFixtures().filter((f) => alreadyClean(prepareTranscript(f.transcript), contextOf(f)).clean).length}/${loadFixtures().length} fixtures clean`,
        `[skip-rate] synthetic mix (${N} paid + ${N} free dictations, seed ${SEED}, cap ${CLEAN_MAX_WORDS} words): paid base mix ${pct(cleanPaid, paid.length)} clean (${[...byPersona.entries()]
          .filter(([k]) => k !== 'free')
          .map(([k, v]) => `${k} ${pct(v.clean, v.n)}`)
          .join(', ')}); free average ${pct(cleanFree, free.length)}`,
        `[skip-rate] paid base mix by word cap: ${caps.join(', ')}`,
        `[skip-rate] why the rest reach the model: ${[...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r} ${pct(n, 2 * N - cleanPaid - cleanFree)}`)
          .join(', ')}`,
        `[skip-rate] cost: the LLM is ${pct(LLM_SHARE, 1)} of a median dictation's inference, so ${pct(skip, 1)} fewer calls is ${pct(-LLM_SHARE * skip, 1)} total inference for the paid base mix; Groq Free covers ${FREE_LLM_DICTATIONS_PER_DAY} -> ${Math.round(FREE_LLM_DICTATIONS_PER_DAY / (1 - cleanFree / free.length))} free dictations a day`
      ].join('\n')
    )
    expect(skip).toBeGreaterThan(0)
  })
})
