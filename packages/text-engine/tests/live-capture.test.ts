import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finish } from '../src/cleanup'
import { formatTranscript } from '../src/format'
import type { ChatMessage, Complete, FormatContext } from '../src/types'

/**
 * Bytes captured from a real OpenAI-compatible endpoint, credentials and request ids stripped
 * (tests/fixtures/live): espeak-ng clips sent to its speech model exactly as the clients send them,
 * and one completion from its formatting model. The speech model's `verbose_json` — the response
 * every client asks for first, for the word timings — drops the "t" of a negative contraction in
 * front of a consonant ("I don' think so"), in the text, the segments and the words alike, while
 * its plain `json` for the same audio keeps it.
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

/** Short cut transcripts: the clean skip finishes them, so the model never sees the cut. */
const SHORT: Array<[string, string]> = [
  ['transcribe-1.verbose.dont-think-so.json', "I don't think so. It's not what we need."],
  ['transcribe-1.verbose.didnt-call-back.json', "We couldn't find it and they didn't call back."],
  ['transcribe-1.verbose.doesnt-matter.json', "You'll see. It doesn't matter. We'd better go."],
  ['transcribe-1.verbose.hasnt-shipped.json', "It isn't done, it wasn't ready, and it hasn't shipped."]
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

  it.each(SHORT)('the clean skip inserts %s whole', async (file, expected) => {
    for (const [raw, want] of [
      [transcriptOf(file), expected],
      [curly(transcriptOf(file)), curly(expected)]
    ]) {
      const complete = spy()
      const r = await formatTranscript({ transcript: raw, mode: 'smart', context: ctx }, complete)
      expect(r.status.outcome).toBe('skipped-clean')
      expect(complete.calls).toHaveLength(0)
      expect(finish(r.text, { category: 'unknown', dictionary: [], trailingSpace: true }).text).toBe(`${want} `)
    }
  })

  it.each(SHORT)('light and off modes insert %s whole', async (file, expected) => {
    const light = await formatTranscript({ transcript: transcriptOf(file), mode: 'light', context: ctx }, null)
    expect(light.text).toBe(expected)
    const off = await formatTranscript({ transcript: curly(transcriptOf(file)), mode: 'off', context: ctx }, null)
    expect(off.text).toMatch(/n\u2019t\b/)
    expect(off.text).not.toMatch(/n\u2019(?![\p{L}])/u)
  })

  it('the formatting model is shown the whole contraction and its captured answer is used as is', async () => {
    const answer = fixture('complete.what-are-you-referring-to.json') as {
      choices: Array<{ message: { content: string; reasoning: string }; finish_reason: string }>
    }
    const content = answer.choices[0].message.content
    expect(answer.choices[0].message.reasoning).toContain("I don' recall")
    const complete = spy(content)
    const r = await formatTranscript(
      { transcript: transcriptOf('transcribe-1.verbose.what-are-you-referring-to.json'), mode: 'smart', context: ctx },
      complete
    )
    expect(r.status.outcome).toBe('used')
    expect(r.text).toBe("What are you referring to? I don't recall. I have the worst memory in the world.")
    const prompt = complete.calls[0].at(-1)!.content
    expect(prompt).toContain("Transcript:\nWhat are you referring to? I don't recall.")
    expect(prompt).not.toContain("don' ")
  })

  it('the plain json transcripts pass through untouched', async () => {
    for (const file of ['transcribe-1.json.dont-think-so.json', 'transcribe-1.json.what-are-you-referring-to.json']) {
      const raw = transcriptOf(file)
      const r = await formatTranscript({ transcript: raw, mode: 'off', context: ctx }, null)
      expect(r.text).toBe(raw)
    }
  })
})
