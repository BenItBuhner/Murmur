import { describe, expect, it } from 'vitest'
import { adaptiveThreshold, analyze } from '@core/audio/vad'
import {
  isSilenceHallucination,
  isSilentStockPhrase,
  joinPieces,
  joinSeam,
  TAIL_PHRASE_MIN_SPEECH_MS
} from '@engine'

const RATE = 16000
/** Deterministic noise-like "speech" at a given dBFS RMS. */
function tone(sec: number, db: number, seed = 1): Int16Array {
  const out = new Int16Array(Math.floor(sec * RATE))
  const amp = 32767 * Math.pow(10, db / 20) * Math.SQRT2
  let x = seed
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = Math.round(amp * Math.sin(i * 0.07 + (x / 0x7fffffff) * 0.5))
  }
  return out
}
const cat = (...a: Int16Array[]): Int16Array => {
  const o = new Int16Array(a.reduce((n, x) => n + x.length, 0))
  let p = 0
  for (const x of a) {
    o.set(x, p)
    p += x.length
  }
  return o
}

describe('end-of-dictation stock-phrase filter (Oct 16 tail drop)', () => {
  it('old rule dropped a genuinely spoken final "Thank you." (~450 ms voiced)', () => {
    expect(isSilenceHallucination('Thank you.')).toBe(true)
    const voicedMs = 450
    expect(voicedMs < 600 && isSilenceHallucination('Thank you.')).toBe(true) // the v0.6.23 rule
    expect(isSilentStockPhrase('Thank you.', voicedMs)).toBe(false) // fixed: kept
  })
  it('still drops a stock phrase over silence or when the model says silence', () => {
    expect(isSilentStockPhrase('Thank you.', 40)).toBe(true)
    expect(isSilentStockPhrase('Thank you.', 900, 0.9)).toBe(true)
    expect(isSilentStockPhrase('Thank you.', 0, 0.1)).toBe(false)
    expect(TAIL_PHRASE_MIN_SPEECH_MS).toBeLessThan(300)
  })
  it('never touches ordinary words', () => {
    expect(isSilentStockPhrase('and performance.', 0)).toBe(false)
    expect(isSilentStockPhrase('So.', 300)).toBe(false)
  })
})

describe('release tail gate', () => {
  it('a soft last phrase after a dense loud dictation is judged silent by the session threshold', () => {
    // 25 s of run-on speech (no real pauses), then a 0.4 s breath, then a soft 0.7 s "and performance".
    const pcm = cat(tone(25, -22), tone(0.4, -70, 2), tone(0.7, -38, 3), tone(0.3, -70, 4))
    const session = adaptiveThreshold(pcm, RATE, -48)
    const rest = pcm.subarray(Math.floor(25.2 * RATE))
    const old = analyze(rest, { sampleRate: RATE, thresholdDb: session })
    const tailDb = Math.min(session, adaptiveThreshold(rest, RATE, -48))
    const fixed = analyze(rest, { sampleRate: RATE, thresholdDb: tailDb })
    expect(old.hasSpeech).toBe(false) // v0.6.23: tail never sent, words vanish
    expect(fixed.hasSpeech).toBe(true)
  })
})

describe('seam joins keep the final words', () => {
  it.each([
    ['We get amazing latency.', 'and performance.'],
    ['We get amazing latency and', 'and performance.'],
    ['we get amazing latency and performance', 'and performance.'],
    ['so that we get amazing latency', 'latency and performance.']
  ])('%s + %s', (a, b) => {
    expect(joinSeam(a, b).text.toLowerCase()).toMatch(/latency and performance\.?$/)
    expect(joinPieces(['Hello there.', a, b]).text.toLowerCase()).toMatch(/and performance\.?$/)
  })
})

describe('spec/tail seam that splits "this | chat" (Oct 16 05:40 dictation)', () => {
  it('puts the stray fragment back into the sentence it finishes', () => {
    const j = joinSeam(
      'Can you preview that video for me in this?',
      'chat. Can I just watch it here, please, or is that not possible?'
    )
    expect(j.text).toBe(
      'Can you preview that video for me in this chat? Can I just watch it here, please, or is that not possible?'
    )
  })
  it('handles a raw (unpunctuated) speculation too', () => {
    expect(
      joinSeam('Can you preview that video for me in this', 'chat? Can I just watch it here').text
    ).toContain('in this chat? Can I')
  })
  it('leaves a real sentence start alone', () => {
    expect(joinSeam('Is it done?', 'Yes. We shipped it.').text).toBe(
      'Is it done? Yes. We shipped it.'
    )
  })
})

describe('formatter ending guard', () => {
  it('flags a formatted tail that dropped or moved its last words', async () => {
    const { endingKept } = await import('@engine')
    expect(endingKept('we get amazing latency and performance', 'We get amazing latency.')).toBe(
      false
    )
    expect(
      endingKept(
        'in this? chat. Can I just watch it here please',
        'In this? Can I just chat, please?'
      )
    ).toBe(false)
    expect(
      endingKept(
        'we get amazing latency and performance',
        'We get amazing latency and performance.'
      )
    ).toBe(true)
    expect(endingKept('um so yeah', 'So yeah.')).toBe(true)
  })
})
