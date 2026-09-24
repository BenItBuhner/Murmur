import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { alreadyClean } from '../src/clean'
import { finish, prepareTranscript } from '../src/cleanup'
import { formatTranscript } from '../src/format'
import type { ChatMessage, Complete, FormatContext } from '../src/types'

/**
 * Bytes captured from a real OpenAI-compatible endpoint, credentials and request ids stripped
 * (tests/fixtures/live): espeak-ng clips sent to its speech model exactly as the clients send them,
 * and one completion from its formatting model. The speech model's `verbose_json` — the response
 * every client asks for first, for the word timings — drops the "t" of a negative contraction in
 * front of a consonant ("I don' think so"), in the text, the segments and the words alike, while
 * its plain `json` for the same audio keeps it.
 *
 * That is the speech model's defect, and Murmur does not patch a model's text with rules of its
 * own. With formatting off the transcript goes in byte for byte; light mode capitalizes and spaces
 * it and leaves every word as it came; in the default mode the cut word is exactly what keeps the
 * transcript from the clean skip, so it goes to the formatting model, which reads the whole sentence.
 */
const FIXTURES = resolve(__dirname, 'fixtures/live')
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Record<string, unknown>
const transcriptOf = (name: string): string => fixture(name).text as string
const curly = (s: string): string => s.replace(/'/g, '\u2019')

const ctx: FormatContext = { category: 'unknown', tone: 'neutral', dictionary: [], language: 'auto' }

const spy = (answer = 'unused'): Complete & { calls: ChatMessage[][] } => {
  const calls: ChatMessage[][] = []
  const fn: Complete = async (messages) => {
    calls.push(messages)
    return { text: answer, finishReason: 'stop' }
  }
  return Object.assign(fn, { calls })
}

/** The user message ends with the transcript: what the formatting model is shown, verbatim. */
const shownTo = (complete: { calls: ChatMessage[][] }): string => {
  expect(complete.calls).toHaveLength(1)
  const prompt = complete.calls[0].at(-1)!.content
  return prompt.slice(prompt.lastIndexOf('Transcript:\n') + 'Transcript:\n'.length)
}

/**
 * The cut transcripts: what light mode makes of each (the sentence start capitalized, the cut word
 * as it came) and what a formatting model that read the whole sentence answers.
 */
const CUT: Array<[file: string, light: string, whole: string]> = [
  [
    'transcribe-1.verbose.dont-think-so.json',
    "I don' think so. It's not what we need.",
    "I don't think so. It's not what we need."
  ],
  [
    'transcribe-1.verbose.didnt-call-back.json',
    "We couldn't find it and they didn' call back.",
    "We couldn't find it and they didn't call back."
  ],
  [
    'transcribe-1.verbose.doesnt-matter.json',
    "You'll see. It doesn' matter. We'd better go.",
    "You'll see. It doesn't matter. We'd better go."
  ],
  [
    'transcribe-1.verbose.hasnt-shipped.json',
    "It isn't done, it wasn't ready, and it hasn' shipped.",
    "It isn't done, it wasn't ready, and it hasn't shipped."
  ]
]

describe('live captures: the speech model cut "n\'t" in verbose_json', () => {
  it('the captured verbose_json really is cut where the plain json is not', () => {
    expect(transcriptOf('transcribe-1.verbose.dont-think-so.json')).toBe("I don' think so. It's not what we need.")
    expect(transcriptOf('transcribe-1.json.dont-think-so.json')).toBe("I don't think so. It's not what we need.")
    const verbose = fixture('transcribe-1.verbose.what-are-you-referring-to.json')
    expect(verbose.text).toBe("What are you referring to? I don' recall. I have the worst memory in the world.")
    expect((verbose.words as Array<{ word: string }>).map((w) => w.word)).toContain("don'")
    expect(transcriptOf('transcribe-1.json.what-are-you-referring-to.json')).toBe(
      "What are you referring to? I don't recall. I have the worst memory in the world."
    )
  })

  it.each(CUT)('formatting off inserts %s byte for byte', async (file) => {
    for (const raw of [transcriptOf(file), curly(transcriptOf(file))]) {
      const r = await formatTranscript({ transcript: raw, mode: 'off', context: ctx }, null)
      expect(r.status).toEqual({ outcome: 'skipped', detail: 'formatting off', attempts: 0 })
      expect(r.stages).toEqual([])
      expect(r.text).toBe(raw)
      expect(finish(r.text, { category: 'unknown', dictionary: [], trailingSpace: true }).text).toBe(`${raw} `)
    }
  })

  it.each(CUT)('light mode capitalizes %s and leaves every word as it came', async (file, light) => {
    for (const [raw, want] of [
      [transcriptOf(file), light],
      [curly(transcriptOf(file)), curly(light)]
    ]) {
      const r = await formatTranscript({ transcript: raw, mode: 'light', context: ctx }, null)
      expect(r.status.outcome).toBe('skipped')
      expect(r.text).toBe(want)
      // The only rule that touched it wrote a capital letter; the cut word is the model's, untouched.
      expect(r.stages.filter((s) => s !== 'capitalize')).toEqual([])
      expect(r.text.toLowerCase()).toBe(raw.toLowerCase())
    }
  })

  it.each(CUT)('the default mode shows %s to the formatting model as the speech model wrote it', async (file, _light, whole) => {
    for (const [raw, answer] of [
      [transcriptOf(file), whole],
      [curly(transcriptOf(file)), curly(whole)]
    ]) {
      // The cut word is exactly what keeps the transcript from the clean skip...
      expect(alreadyClean(prepareTranscript(raw), ctx)).toEqual({ clean: false, reason: 'truncated' })
      // ...so the model is called, reads the transcript untouched, and its answer is used.
      const complete = spy(answer)
      const r = await formatTranscript({ transcript: raw, mode: 'smart', context: ctx }, complete)
      expect(shownTo(complete)).toBe(raw)
      expect(r.status).toMatchObject({ outcome: 'used', attempts: 1 })
      expect(r.text).toBe(answer)
    }
  })

  it('the formatting model reads the cut transcript whole and its captured answer is used as is', async () => {
    const answer = fixture('complete.what-are-you-referring-to.json') as {
      choices: Array<{ message: { content: string; reasoning: string }; finish_reason: string }>
    }
    // The real model saw "I don' recall" and understood it: nothing was fixed for it on the way in.
    expect(answer.choices[0].message.reasoning).toContain("I don' recall")
    const raw = transcriptOf('transcribe-1.verbose.what-are-you-referring-to.json')
    const complete = spy(answer.choices[0].message.content)
    const r = await formatTranscript({ transcript: raw, mode: 'smart', context: ctx }, complete)
    expect(shownTo(complete)).toBe(raw)
    expect(r.status).toMatchObject({ outcome: 'used', attempts: 1 })
    expect(r.text).toBe("What are you referring to? I don't recall. I have the worst memory in the world.")
  })

  it('the plain json transcripts pass through untouched, and the short one needs no model', async () => {
    for (const file of ['transcribe-1.json.dont-think-so.json', 'transcribe-1.json.what-are-you-referring-to.json']) {
      const raw = transcriptOf(file)
      const off = await formatTranscript({ transcript: raw, mode: 'off', context: ctx }, null)
      expect(off.text).toBe(raw)
    }
    // Whole contractions are plain English prose: the same sentence with its "t" skips the model.
    const complete = spy()
    const whole = transcriptOf('transcribe-1.json.dont-think-so.json')
    const r = await formatTranscript({ transcript: whole, mode: 'smart', context: ctx }, complete)
    expect(r.status.outcome).toBe('skipped-clean')
    expect(complete.calls).toHaveLength(0)
    expect(r.text).toBe(whole)
  })
})
