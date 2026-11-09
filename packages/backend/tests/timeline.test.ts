import { describe, expect, it } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { audioStats, readWav, scorePiece } from '../convex/lib/timelineAudio'
import { ada, bob, setup } from './helpers'

function wav(pcm: Int16Array, rate = 16_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2)
  const dv = new DataView(out.buffer)
  const tag = (o: number, s: string): void =>
    [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)))
  tag(0, 'RIFF')
  dv.setUint32(4, 36 + pcm.length * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  tag(36, 'data')
  dv.setUint32(40, pcm.length * 2, true)
  pcm.forEach((v, i) => dv.setInt16(44 + i * 2, v, true))
  return out
}

const chunk = (startedAt: string, text: string) => ({
  device: 'phone',
  startedAt,
  endedAt: startedAt,
  text,
  engine: 'server',
  rmsDb: -25,
  speechRatio: 0.8,
  speakers: 0,
  score: 0.7,
  tags: ['speech']
})

describe('timeline audio analysis (server side)', () => {
  it('reads a WAV and tells silence from speech', () => {
    const loud = Int16Array.from({ length: 16_000 }, (_, i) => Math.round(8000 * Math.sin(i / 8)))
    const a = readWav(wav(loud))!
    expect(a.rate).toBe(16_000)
    expect(audioStats(a.pcm, a.rate).speechRatio).toBeGreaterThan(0.9)
    expect(audioStats(readWav(wav(new Int16Array(16_000)))!.pcm, 16_000).speechRatio).toBe(0)
    expect(readWav(new Uint8Array(10))).toBeNull()
  })

  it('scores ideas higher', () => {
    const base = { seconds: 25, rmsDb: -25, speechRatio: 0.7 }
    expect(scorePiece({ ...base, text: 'what if we shipped sync first' }).tags).toContain('idea')
    expect(scorePiece({ ...base, text: 'what if' }).score).toBeGreaterThan(
      scorePiece({ ...base, text: 'ok' }).score
    )
  })
})

describe('timeline relay', () => {
  it('keeps what the server transcribed for that account, once, until the desktop takes it', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    await t.mutation(internal.timeline.store, {
      clerkId: ada.subject!,
      chunk: chunk('2026-11-09T09:00:00Z', 'an idea')
    })
    await t.mutation(internal.timeline.store, {
      clerkId: ada.subject!,
      chunk: chunk('2026-11-09T09:00:00Z', 'an idea, fixed')
    })
    const pending = await asAda.query(api.timeline.pending, {})
    expect(pending.map((c) => c.text)).toEqual(['an idea, fixed'])

    const asBob = t.withIdentity(bob)
    await asBob.mutation(api.users.ensure, {})
    expect(await asBob.query(api.timeline.pending, {})).toEqual([])
    expect((await asBob.mutation(api.timeline.ack, { ids: [pending[0]!.id] })).removed).toBe(0)

    await asAda.mutation(api.timeline.ack, { ids: [pending[0]!.id] })
    expect(await asAda.query(api.timeline.pending, {})).toEqual([])
  })
})
