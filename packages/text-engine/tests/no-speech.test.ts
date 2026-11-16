import { describe, expect, it } from 'vitest'
import { dropNoSpeechAnswer, hasSpeechDynamics, isLoop, isPromptRun, isStockAnswer, wavPcm16 } from '../src/no-speech'

function wav(samples: Int16Array, rate = 16000): Uint8Array {
  const b = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(b.buffer)
  const w = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)))
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true))
  return b
}
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const noise = (sec: number, amp: number) => Int16Array.from({ length: sec * 16000 }, () => Math.round(rnd() * amp))
/** Bursts of a voiced tone (syllables) with gaps, under faint noise. */
const syllables = (sec: number) =>
  Int16Array.from({ length: sec * 16000 }, (_, i) => {
    const t = i / 16000
    const on = t % 0.3 < 0.18
    return Math.round((on ? 8000 * Math.sin(2 * Math.PI * 140 * t) : 0) + rnd() * 30)
  })

describe('no-speech answers', () => {
  it('reads 16-bit PCM WAVs and nothing else', () => {
    expect(wavPcm16(wav(new Int16Array(10)))?.samples.length).toBe(10)
    expect(wavPcm16(new TextEncoder().encode('OggS........................................'))).toBeNull()
  })
  it('tells speech-like loudness from silence and steady noise', () => {
    expect(hasSpeechDynamics(new Int16Array(48000), 16000)).toBe(false)
    expect(hasSpeechDynamics(noise(3, 3000), 16000)).toBe(false)
    expect(hasSpeechDynamics(syllables(2), 16000)).toBe(true)
  })
  it('knows the suspects', () => {
    expect(isStockAnswer('Gracias.')).toBe(true)
    expect(isStockAnswer('Music playing.')).toBe(true)
    expect(isStockAnswer('Thank you.')).toBe(true)
    expect(isStockAnswer('Thank you for the notes.')).toBe(false)
    expect(isPromptRun('and that is what I wanted', 'Dictation with punctuation. and that is what I wanted to say')).toBe(true)
    expect(isPromptRun('and that is it', 'Dictation with punctuation. and that is what I wanted')).toBe(false)
    expect(isLoop('I am not sure if you can see it but I am not sure if you can see it but I am not sure if you can see it')).toBe(true)
    expect(isLoop('we need to ship it and we need to test it')).toBe(false)
  })
  it('drops "Thank you." whose segment runs past the end of a silent clip', () => {
    const out = dropNoSpeechAnswer({ text: ' Thank you.', segments: [{ text: ' Thank you.', end: 29.98 }] }, new Uint8Array(0), 3, undefined)
    expect(out).toMatchObject({ text: '', segments: [] })
  })
  it('drops a stock phrase or a prompt read back over steady noise', () => {
    const audio = wav(noise(2, 2000))
    expect(dropNoSpeechAnswer({ text: 'Gracias.' }, audio, 2, undefined)?.text).toBe('')
    expect(dropNoSpeechAnswer({ text: 'and that is what I wanted to say' }, audio, 2, 'Dictation with punctuation. and that is what I wanted to say')?.text).toBe('')
  })
  it('keeps a "thank you" that was spoken, and every ordinary sentence', () => {
    const audio = wav(syllables(1))
    expect(dropNoSpeechAnswer({ text: 'Thank you.', segments: [{ text: 'Thank you.', end: 1 }] }, audio, 1, undefined)).toBeNull()
    expect(dropNoSpeechAnswer({ text: 'Ship it today.' }, wav(noise(2, 2000)), 2, undefined)).toBeNull()
  })
  it('empties answers without words and captions', () => {
    expect(dropNoSpeechAnswer({ text: ' ...' }, new Uint8Array(0), 3, undefined)?.text).toBe('')
    expect(dropNoSpeechAnswer({ text: 'Music playing.' }, wav(syllables(2)), 2, undefined)?.reason).toBe('caption')
  })
})
