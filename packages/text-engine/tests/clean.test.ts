import { describe, expect, it } from 'vitest'
import {
  CLEAN_MAX_WORDS,
  COMMAND_PHRASES,
  COMMAND_WORDS,
  CORRECTION_PHRASES,
  ENUMERATION_PHRASES,
  ENUMERATION_WORDS,
  FOREIGN_WORDS,
  HESITATION_PHRASES,
  HESITATION_WORDS,
  alreadyClean,
  type NotCleanReason
} from '../src/clean'
import { prepareTranscript } from '../src/cleanup'
import type { FormatContext } from '../src/types'

const chat: FormatContext = { category: 'chat', tone: 'casual', dictionary: [], language: 'auto' }
const email: FormatContext = {
  category: 'email',
  tone: 'professional',
  dictionary: [],
  language: 'auto'
}

const decide = (
  transcript: string,
  ctx: FormatContext = chat,
  maxWords?: number
): { clean: boolean; reason?: NotCleanReason } =>
  alreadyClean(prepareTranscript(transcript), ctx, { maxWords })

const reason = (transcript: string, ctx: FormatContext = chat): NotCleanReason | undefined =>
  decide(transcript, ctx).reason

describe('alreadyClean', () => {
  it('finishes a short, punctuated, plain dictation without the model', () => {
    for (const t of [
      'Sounds good, see you tomorrow.',
      "Thanks for the update, I'll take a look this afternoon.",
      'Can you send me the link to the doc?',
      'On my way.',
      'Okay, sounds good.',
      "Yeah, let's do that.",
      'Looks great to me!',
      'Hey Sarah, can you send the report to John on Wednesday?',
      'No problem, happy to help.',
      "Let’s ship it today."
    ])
      expect(decide(t), t).toEqual({ clean: true })
    expect(decide('Please review the attached document and let me know your thoughts.', email)).toEqual({
      clean: true
    })
  })

  it('never takes over a code editor or a terminal', () => {
    expect(reason('Sounds good.', { ...chat, category: 'code', tone: 'neutral' })).toBe('destination')
    expect(reason('Sounds good.', { ...chat, category: 'terminal', tone: 'neutral' })).toBe('destination')
  })

  it('keeps the model whenever the user asked for something (instructions, a forced tone)', () => {
    expect(reason('Sounds good.', { ...chat, instructions: 'British spelling.' })).toBe('instructions')
    expect(reason('Sounds good.', { ...chat, instructions: '  ' })).toBeUndefined()
    // The destination implies casual for chat and professional for email; anything else was set by hand.
    expect(reason('Sounds good.', { ...chat, tone: 'professional' })).toBe('tone')
    expect(reason('Sounds good.', { ...email, tone: 'casual' })).toBe('tone')
    expect(reason('Sounds good.', { ...chat, category: 'notes', tone: 'neutral' })).toBeUndefined()
  })

  it('only knows English: a pinned other language goes to the model, "auto" and "en" may skip', () => {
    expect(reason('Sounds good.', { ...chat, language: 'de' })).toBe('language')
    expect(reason('Sounds good.', { ...chat, language: 'pt-BR' })).toBe('language')
    expect(reason('Sounds good.', { ...chat, language: 'en-US' })).toBeUndefined()
    expect(reason('Sounds good.', { ...chat, language: undefined })).toBeUndefined()
  })

  it('needs the model to continue text before the cursor mid-sentence, not after a full stop or a new line', () => {
    expect(reason('Sounds good.', { ...chat, precedingText: 'I think we should' })).toBe(
      'preceding-text'
    )
    expect(reason('Sounds good.', { ...chat, precedingText: 'Hi Sarah,' })).toBe('preceding-text')
    expect(reason('Sounds good.', { ...chat, precedingText: 'Thanks for the update. ' })).toBeUndefined()
    expect(reason('Sounds good.', { ...chat, precedingText: 'Hi Sarah,\n\n' })).toBeUndefined()
    expect(reason('Sounds good.', { ...chat, precedingText: '   ' })).toBeUndefined()
  })

  it('never skips when a keep-verbatim phrase is in the transcript', () => {
    const ctx = { ...email, keepVerbatim: ['my sig', ' '] }
    expect(reason('Sign it with my sig.', ctx)).toBe('verbatim')
    expect(reason('Sign it with My Sig.', ctx)).toBe('verbatim')
    expect(reason('Sign it and send it back.', ctx)).toBeUndefined()
  })

  it('leaves spoken layout commands to the model even after prepareTranscript applied them', () => {
    expect(reason('Thanks a lot new line see you tomorrow.')).toBe('command')
    expect(reason('Are you coming question mark')).toBe('command')
    // "press enter" is a side effect, not text: what is left decides on its own.
    expect(reason('See you tomorrow press enter')).toBe('unpunctuated')
    expect(decide('See you tomorrow. Press enter.')).toEqual({ clean: true })
  })

  it(`stops at ${CLEAN_MAX_WORDS} words and can be tuned or turned off`, () => {
    const twelve = 'Please review the attached document and let me know your thoughts today.'
    const thirteen = 'Please review the attached document and let me know your thoughts by tomorrow.'
    expect(decide(twelve)).toEqual({ clean: true })
    expect(reason(thirteen)).toBe('long')
    expect(decide(thirteen, chat, 20)).toEqual({ clean: true })
    expect(decide('Sounds good.', chat, 0).reason).toBe('long')
  })

  it('trusts only a transcript the speech model already punctuated', () => {
    expect(reason('thanks for the update i will look tomorrow')).toBe('unpunctuated')
    expect(reason('See you tomorrow...')).toBe('unpunctuated')
    expect(reason('See you tomorrow…')).toBe('unpunctuated')
    expect(decide('thanks for the update.')).toEqual({ clean: true })
  })

  it('accepts only the characters of plain English prose', () => {
    expect(reason("Let's do it — tomorrow.")).toBe('characters')
    expect(reason('Send it to Zoë.')).toBe('characters')
    expect(reason('Ping me @ noon.')).toBe('characters')
    expect(reason('He said "hands off".')).toBe('characters')
    expect(reason('Todo: fix the build.')).toBe('characters')
  })

  it('finishes a cut negative contraction itself and sends any other bare apostrophe to the model', () => {
    expect(decide("I don' think so.")).toEqual({ clean: true })
    expect(decide('They didn’ call back.')).toEqual({ clean: true })
    expect(reason("It' fine, we' see.")).toBe('truncated')
    expect(reason('That’ right.')).toBe('truncated')
    expect(decide("The dogs' bowls are empty.")).toEqual({ clean: true })
  })

  it('sends every filler, hesitation, opener and pause "like" to the model', () => {
    expect(reason('Thanks, um, I will look at it tomorrow.')).toBe('filler')
    expect(reason('I mean, it looks fine.')).toBe('filler')
    expect(reason('It was, like, really good.')).toBe('filler')
    expect(reason('Like I said, tomorrow.')).toBe('filler')
    expect(reason('So we ship tomorrow.')).toBe('filler')
    expect(reason('Okay so we ship tomorrow.')).toBe('filler')
    expect(reason('Actually, forget it.')).toBe('filler')
    expect(reason('Oh nice, thanks!')).toBe('filler')
    // "like" the verb and a mid-sentence "so" are not hesitation.
    expect(decide('I like the new design a lot.')).toEqual({ clean: true })
    expect(decide("It's late, so let's stop here.")).toEqual({ clean: true })
  })

  it('catches stutters: a word or a run of words said twice, punctuation between them or not', () => {
    expect(reason('The the report is ready.')).toBe('stutter')
    expect(reason('I, I think it is fine.')).toBe('stutter')
    expect(reason('We need to, we need to ship it.')).toBe('stutter')
    // Deliberate repetition is the model's call too.
    expect(reason('No, no, no, that is wrong.')).toBe('stutter')
  })

  it('catches self-corrections', () => {
    expect(reason('Send it Tuesday, no, Wednesday.')).toBe('correction')
    expect(reason('Send it Tuesday, no Wednesday.')).toBe('correction')
    expect(reason('Send it Tuesday, I meant Wednesday.')).toBe('correction')
    expect(reason('Wait, make it Wednesday.')).toBe('correction')
    expect(reason('Tuesday or rather Wednesday.')).toBe('correction')
    expect(decide('No, that works for me.')).toEqual({ clean: true })
  })

  it('catches spoken punctuation, quotes and editing commands', () => {
    expect(reason('She said quote hands off end quote.')).toBe('command')
    expect(reason('Send it today period.')).toBe('command')
    expect(reason('Send it tomorrow scratch that today.')).toBe('command')
    expect(reason('Send it in all caps.')).toBe('command')
  })

  it('catches enumeration cues', () => {
    expect(reason('Firstly the deck, secondly the vendor.')).toBe('enumeration')
    expect(reason('Add a bullet point for the vendor.')).toBe('enumeration')
  })

  it('catches every number, time, amount, ordinal or version, spoken or written', () => {
    expect(reason("I'm running about ten minutes late.")).toBe('number')
    expect(reason('See you at 5.')).toBe('number')
    expect(reason('It costs a hundred dollars.')).toBe('number')
    expect(reason('We are on version two point one.')).toBe('number')
    expect(reason('I think we should go with the second option.')).toBe('number')
    expect(reason('Half of them agreed.')).toBe('number')
    expect(reason('Double check the door.')).toBe('number')
  })

  it('sends a question the speech model ended with a period back for its question mark', () => {
    expect(reason('Can you send me the link to the doc.')).toBe('question')
    expect(reason('Thanks. Can you resend it.')).toBe('question')
    expect(decide('Can you send me the link to the doc?')).toEqual({ clean: true })
    expect(decide('Is it done? Yes.')).toEqual({ clean: true })
  })

  it('recognises plain-ASCII sentences of other languages under "auto"', () => {
    expect(reason('Ich schicke dir das morgen.')).toBe('foreign')
    expect(reason('Je vous envoie le rapport demain.')).toBe('foreign')
    expect(reason('Te mando el informe, gracias.')).toBe('foreign')
    expect(reason('Ik stuur het morgen.')).toBe('foreign')
    expect(reason('Merci, see you tomorrow.')).toBe('foreign')
  })

  it('keeps the lexicon lower-case ASCII, unique, and free of English words', () => {
    const english = new Set([
      'is', 'no', 'a', 'do', 'as', 'on', 'me', 'met', 'con', 'van', 'we', 'to', 'in', 'an', 'am',
      'was', 'so', 'man', 'also', 'den', 'dem', 'bin', 'dir', 'hat', 'gut', 'mit', 'est', 'pour',
      'son', 'soy', 'todo', 'yo', 'al', 'para', 'ella', 'io', 'ma', 'non', 'per', 'come', 'eu',
      'os', 'em', 'na', 'sim', 'com', 'boa', 'dan', 'hoe', 'wat', 'wil', 'op', 'dat', 'als',
      'till', 'att', 'vi', 'var', 'ben', 'sen', 'to', 'die'
    ])
    // "die" is in the list on purpose: the German article outweighs the rare English verb.
    english.delete('die')
    for (const list of [
      HESITATION_WORDS,
      HESITATION_PHRASES,
      COMMAND_WORDS,
      COMMAND_PHRASES,
      CORRECTION_PHRASES,
      ENUMERATION_WORDS,
      ENUMERATION_PHRASES,
      FOREIGN_WORDS
    ]) {
      expect(new Set(list).size).toBe(list.length)
      for (const w of list) expect(w, w).toMatch(/^[a-z]+(?: [a-z]+)*$/)
    }
    for (const w of FOREIGN_WORDS) expect(english.has(w), w).toBe(false)
  })
})
