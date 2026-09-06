import { describe, expect, it } from 'vitest'
import { analyze } from '@core/audio/vad'
import { decodeWavPcm16 } from '@core/audio/wav'
import {
  assessCoverage,
  findCutPoint,
  mergeTranscripts,
  transcribeComplete,
  type Transcribe
} from '@core/stt/coverage'
import type { TranscribeOutput } from '@core/stt/types'

const RATE = 16000
const THRESHOLD = -48

/** Deterministic noise bursts (speech) and near-silence (pauses) at the given times. */
function clip(totalSec: number, speech: Array<[number, number]>): Int16Array {
  const pcm = new Int16Array(Math.round(totalSec * RATE))
  let seed = 12345
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(rnd() * 20)
  for (const [from, to] of speech) {
    for (let i = Math.round(from * RATE); i < Math.min(pcm.length, Math.round(to * RATE)); i++)
      pcm[i] = Math.round(rnd() * 16000)
  }
  return pcm
}

const out = (
  text: string,
  lastEnd?: number,
  extra: Partial<TranscribeOutput> = {}
): TranscribeOutput => ({
  text,
  latencyMs: 10,
  spans: lastEnd === undefined ? undefined : [{ start: 0, end: lastEnd }],
  ...extra
})

const wavSeconds = (wav: Uint8Array): number => decodeWavPcm16(wav).pcm.length / RATE

describe('assessCoverage', () => {
  it('accepts a transcript whose timings reach the end of the speech', () => {
    const c = assessCoverage(out('hello there how are you', 19.6), 20)
    expect(c.truncated).toBe(false)
    expect(c.transcribedSec).toBe(19.6)
  })
  it('flags a transcript that stops well before the speech ends', () => {
    const c = assessCoverage(out('please implement this in a clean manner and Wispr Flow', 7.9), 60)
    expect(c.truncated).toBe(true)
    expect(c.reason).toBe('timestamps')
    expect(c.missingSec).toBeCloseTo(52.1, 1)
  })
  it('tolerates timing jitter and short trailing pauses', () => {
    expect(assessCoverage(out('a few words here', 8.2), 10).truncated).toBe(false)
    expect(assessCoverage(out('a few words here', 27.5), 30).truncated).toBe(false)
  })
  it('prefers the last word end over a bogus segment end', () => {
    const spans = [
      { start: 0, end: 30 },
      { start: 0.5, end: 7.9 }
    ]
    // Whichever span ends last counts; a segment running to its window end still means 30 s covered.
    expect(assessCoverage({ text: 'some words', spans }, 60).transcribedSec).toBe(30)
  })
  it('falls back to the word rate when there are no timings', () => {
    const sparse = assessCoverage(
      out('only eleven words came back for a very long recording here'),
      60
    )
    expect(sparse.truncated).toBe(true)
    expect(sparse.reason).toBe('rate')
    expect(sparse.transcribedSec).toBeNull()
    const dense = assessCoverage(out(Array(40).fill('word').join(' ')), 20)
    expect(dense.truncated).toBe(false)
    // Short clips are never judged by rate: two words in five seconds is a normal dictation.
    expect(assessCoverage(out('send it'), 5).truncated).toBe(false)
  })
  it('treats an empty transcript for real speech as everything missing', () => {
    const c = assessCoverage(out(''), 12)
    expect(c.truncated).toBe(true)
    expect(c.reason).toBe('empty')
    expect(c.transcribedSec).toBe(0)
    expect(assessCoverage(out(''), 1.5).truncated).toBe(false)
  })
})

describe('findCutPoint', () => {
  const pcm = clip(20, [
    [0.3, 8.0],
    [8.6, 19.7]
  ])
  it('cuts in the middle of the pause after the point where the transcript stopped', () => {
    const cut = findCutPoint(pcm, RATE, 7.9, { thresholdDb: THRESHOLD })
    expect(cut).toBeGreaterThan(8.05)
    expect(cut).toBeLessThan(8.55)
  })
  it('cuts just before the target when the speaker never paused', () => {
    const cut = findCutPoint(pcm, RATE, 14, { thresholdDb: THRESHOLD })
    expect(cut).toBeCloseTo(13.9, 2)
  })
})

describe('mergeTranscripts', () => {
  it('drops the words the tail repeats from the seam', () => {
    expect(
      mergeTranscripts(
        'Please implement this in a clean manner and Wispr Flow.',
        'Wispr Flow. It should also use the predictive back gesture.'
      )
    ).toBe(
      'Please implement this in a clean manner and Wispr Flow. It should also use the predictive back gesture.'
    )
  })
  it('does not treat one short shared word as overlap', () => {
    expect(mergeTranscripts('send it to the', 'the report today')).toBe(
      'send it to the the report today'
    )
    expect(mergeTranscripts('we talked about kubernetes', 'kubernetes is hard')).toBe(
      'we talked about kubernetes is hard'
    )
  })
  it('handles empty sides', () => {
    expect(mergeTranscripts('', 'tail')).toBe('tail')
    expect(mergeTranscripts('head', '  ')).toBe('head')
  })
})

describe('transcribeComplete', () => {
  const HEAD =
    'This is an Android app. It should take advantage of the predictive back gesture. Please implement this in a clean manner and Wispr Flow.'
  const TAIL = 'It should also keep the pill visible while the keyboard is up.'
  const pcm = clip(20, [
    [0.3, 8.0],
    [8.6, 19.7]
  ])
  const speechEnd = analyze(pcm, { sampleRate: RATE, thresholdDb: THRESHOLD }).lastVoicedMs / 1000

  it('resumes from the pause after the point where the prompted transcript stopped', async () => {
    const calls: Array<{ seconds: number; prompt?: string }> = []
    const transcribe: Transcribe = async (wav, prompt) => {
      const seconds = wavSeconds(wav)
      calls.push({ seconds, prompt })
      // The vocabulary prompt makes the model stop right after "Wispr Flow".
      if (prompt?.includes('Vocabulary')) return out(HEAD, 7.9)
      return out(TAIL, seconds - 0.2)
    }
    const r = await transcribeComplete(transcribe, {
      pcm,
      sampleRate: RATE,
      speechEndSec: speechEnd,
      thresholdDb: THRESHOLD,
      prompt: 'Vocabulary: Wispr Flow. Dictation with punctuation.',
      tailPrompt: 'Dictation with punctuation.'
    })
    expect(r.text).toBe(`${HEAD} ${TAIL}`)
    expect(r.resumed).toBe(1)
    expect(r.recoveredSec).toBeGreaterThan(10)
    expect(r.coverage.truncated).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toBe('Dictation with punctuation.')
    // The tail starts inside the 8.0-8.6 s pause, so no word is cut in half.
    const cut = 20 - calls[1].seconds
    expect(cut).toBeGreaterThan(8.0)
    expect(cut).toBeLessThan(8.6)
    expect(r.spans?.[r.spans.length - 1].end).toBeGreaterThan(19)
  })

  it('makes no extra request when the transcript covers the speech', async () => {
    let calls = 0
    const r = await transcribeComplete(
      async () => {
        calls++
        return out(HEAD, 19.6)
      },
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, prompt: 'p' }
    )
    expect(calls).toBe(1)
    expect(r.resumed).toBe(0)
    expect(r.text).toBe(HEAD)
  })

  it('retries the whole clip without the prompt when there are no timings to resume from', async () => {
    const calls: Array<string | undefined> = []
    const r = await transcribeComplete(
      async (_wav, prompt) => {
        calls.push(prompt)
        return prompt ? out('only a few words came back') : out(`${HEAD} ${TAIL}`)
      },
      {
        pcm,
        sampleRate: RATE,
        speechEndSec: speechEnd,
        thresholdDb: THRESHOLD,
        prompt: 'Vocabulary: Wispr Flow. Dictation with punctuation.'
      }
    )
    expect(calls).toEqual(['Vocabulary: Wispr Flow. Dictation with punctuation.', undefined])
    expect(r.text).toBe(`${HEAD} ${TAIL}`)
    expect(r.resumed).toBe(1)
  })

  it('keeps the shorter answer when the retry is not clearly fuller', async () => {
    const r = await transcribeComplete(
      async (_wav, prompt) =>
        prompt ? out('one two three four five') : out('one two three four six'),
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, prompt: 'p' }
    )
    expect(r.text).toBe('one two three four five')
    expect(r.resumed).toBe(0)
  })

  it('recovers speech the model returned nothing for', async () => {
    const r = await transcribeComplete(
      async (wav, prompt) => (prompt ? out('', 0) : out(TAIL, wavSeconds(wav) - 0.3)),
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, prompt: 'p' }
    )
    expect(r.text).toBe(TAIL)
    expect(r.resumed).toBe(1)
  })

  it('never loses the head when the resume request fails', async () => {
    let calls = 0
    const r = await transcribeComplete(
      async () => {
        calls++
        if (calls === 1) return out(HEAD, 7.9)
        throw new Error('rate limited')
      },
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, prompt: 'p' }
    )
    expect(r.text).toBe(HEAD)
    expect(r.resumed).toBe(0)
    expect(r.coverage.truncated).toBe(true)
  })

  it('stops when a resumed tail brings no timings and no further progress', async () => {
    let calls = 0
    const r = await transcribeComplete(
      async () => {
        calls++
        return calls === 1 ? out(HEAD, 7.9) : out(TAIL)
      },
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, prompt: 'p' }
    )
    expect(calls).toBe(2)
    expect(r.text).toBe(`${HEAD} ${TAIL}`)
    expect(r.resumed).toBe(1)
  })

  it('chains several resumes when the recognizer keeps stopping early', async () => {
    const pieces = ['first part.', 'second part.', 'third part.']
    let calls = 0
    const r = await transcribeComplete(
      async (wav) => {
        const seconds = wavSeconds(wav)
        const i = calls++
        // Each answer covers only the first third of whatever audio it was given.
        return out(pieces[i] ?? 'more.', i === 0 ? 6.5 : Math.min(seconds - 0.2, seconds / 2))
      },
      { pcm, sampleRate: RATE, speechEndSec: speechEnd, thresholdDb: THRESHOLD, maxRounds: 3 }
    )
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(calls).toBeLessThanOrEqual(4)
    expect(r.text.startsWith('first part. second part. third part.')).toBe(true)
    expect(r.resumed).toBeGreaterThanOrEqual(2)
  })
})
