import { describe, expect, it } from 'vitest'
import { analyze, adaptiveThreshold, rmsDb, trimSilence } from '@core/audio/vad'
import {
  concatInt16,
  decodeWavPcm16,
  encodeWavPcm16,
  float32ToInt16,
  resampleLinear
} from '@core/audio/wav'

const SR = 16000

function tone(ms: number, amplitude: number, freq = 220): Int16Array {
  const n = Math.floor((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++)
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amplitude * 32767)
  return out
}

function silence(ms: number, noise = 0): Int16Array {
  const n = Math.floor((SR * ms) / 1000)
  const out = new Int16Array(n)
  if (noise)
    for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * noise * 32767)
  return out
}

describe('WAV encode/decode', () => {
  it('round-trips PCM16 mono', () => {
    const pcm = tone(100, 0.5)
    const wav = encodeWavPcm16(pcm, SR)
    expect(wav.byteLength).toBe(44 + pcm.length * 2)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    const decoded = decodeWavPcm16(wav)
    expect(decoded.sampleRate).toBe(SR)
    expect(decoded.channels).toBe(1)
    expect(Array.from(decoded.pcm.slice(0, 50))).toEqual(Array.from(pcm.slice(0, 50)))
  })

  it('concatenates chunks and converts float32', () => {
    const a = new Int16Array([1, 2])
    const b = new Int16Array([3])
    expect(Array.from(concatInt16([a, b]))).toEqual([1, 2, 3])
    const f = float32ToInt16(new Float32Array([0, 1, -1, 2, 0.5]))
    expect(f[0]).toBe(0)
    expect(f[1]).toBe(32767)
    expect(f[2]).toBe(-32768)
    expect(f[3]).toBe(32767)
    expect(f[4]).toBe(Math.round(0.5 * 32767))
  })

  it('resamples with the expected length', () => {
    const src = new Float32Array(48000)
    const out = resampleLinear(src, 48000, 16000)
    expect(out.length).toBe(16000)
    expect(resampleLinear(src, 16000, 16000)).toBe(src)
  })
})

describe('VAD', () => {
  it('measures silence as very quiet and tone as loud', () => {
    expect(rmsDb(silence(20))).toBeLessThan(-90)
    expect(rmsDb(tone(20, 0.5))).toBeGreaterThan(-12)
  })

  it('detects no speech in silence, speech in a tone burst', () => {
    const quiet = analyze(silence(1000, 0.001), { sampleRate: SR, thresholdDb: -48 })
    expect(quiet.hasSpeech).toBe(false)
    const clip = concatInt16([silence(500), tone(600, 0.3), silence(500)])
    const r = analyze(clip, { sampleRate: SR, thresholdDb: -48 })
    expect(r.hasSpeech).toBe(true)
    expect(r.speechMs).toBeGreaterThanOrEqual(580)
    expect(r.firstVoicedMs).toBeGreaterThanOrEqual(480)
    expect(r.lastVoicedMs).toBeLessThanOrEqual(1120)
  })

  it('trims leading and trailing silence with padding', () => {
    const clip = concatInt16([silence(1000), tone(500, 0.3), silence(1500)])
    const t = trimSilence(clip, { sampleRate: SR, thresholdDb: -48, paddingMs: 200 })
    expect(t.trimmedStartMs).toBeGreaterThan(700)
    expect(t.trimmedStartMs).toBeLessThan(820)
    expect(t.trimmedEndMs).toBeGreaterThan(1200)
    expect(t.pcm.length).toBeLessThan(clip.length)
    // Never trims to nothing when there is speech.
    expect(t.pcm.length / SR).toBeGreaterThan(0.85)
  })

  it('does not trim when there is no speech', () => {
    const clip = silence(800)
    const t = trimSilence(clip, { sampleRate: SR, thresholdDb: -48 })
    expect(t.pcm.length).toBe(clip.length)
    expect(t.analysis.hasSpeech).toBe(false)
  })

  it('raises threshold above a noisy floor but never below configured', () => {
    const noisy = concatInt16([silence(1000, 0.02), tone(500, 0.5)])
    const th = adaptiveThreshold(noisy, SR, -48)
    expect(th).toBeGreaterThan(-48)
    expect(adaptiveThreshold(silence(1000), SR, -48)).toBe(-48)
  })
})
