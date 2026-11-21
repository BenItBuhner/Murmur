import { describe, expect, it } from 'vitest'
import {
  handleTimelineAudio,
  handleTimelineObject,
  timelineKeyOwnedBy,
  timelineObjectKey,
  type TimelineBucket
} from '../src/timeline'

function wav(seconds: number): Uint8Array {
  const rate = 16000
  const data = seconds * rate * 2
  const out = new Uint8Array(44 + data)
  const view = new DataView(out.buffer)
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, data, true)
  return out
}

function bucket(): TimelineBucket & { keys: string[] } {
  const objects = new Map<string, Uint8Array>()
  return {
    keys: [] as string[],
    async put(key, value) {
      this.keys.push(key)
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value))
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) return null
      const copy = new Uint8Array(body.byteLength)
      copy.set(body)
      return { size: copy.byteLength, arrayBuffer: async () => copy.buffer as ArrayBuffer }
    },
    async delete(key) {
      objects.delete(key)
    }
  }
}

const identity = { subject: 'user_ada', email: 'ada@example.com' }

describe('timeline object keys', () => {
  it('keeps an account from reading another account object', () => {
    const key = timelineObjectKey('user_ada', 'phone', '2026-11-20T00:00:00Z')
    expect(timelineKeyOwnedBy(key, 'user_ada')).toBe(true)
    expect(timelineKeyOwnedBy(key, 'user_bob')).toBe(false)
    expect(timelineKeyOwnedBy('../secrets', 'user_ada')).toBe(false)
  })
})

describe('timeline audio on the worker', () => {
  it('does not store silence', async () => {
    const box = bucket()
    const calls: string[] = []
    const res = await handleTimelineAudio(
      new Request('https://w.test/v1/timeline/audio?device=phone&startedAt=2026-11-20T00:00:00Z&endedAt=2026-11-20T00:00:02Z', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Blob([wav(1).buffer as ArrayBuffer])
      }),
      box,
      { siteUrl: 'https://convex.test', secret: 's'.repeat(40), fetcher: async (input) => (calls.push(String(input)), new Response('{}')) },
      { env: {}, access: async () => 'pro', authorize: async () => ({ ok: true, userId: 'user_ada', plan: 'pro', planState: 'pro', paused: null, provider: { failures: 0, openForSec: null } }), record: async () => undefined, providerFailed: async () => ({ failures: 0, openForSec: null }), providerRecovered: async () => undefined } as never,
      identity
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: true })
    expect(box.keys).toEqual([])
    expect(calls).toEqual([])
  })

  it('serves a piece only to the account that owns the key', async () => {
    const box = bucket()
    const key = timelineObjectKey('user_ada', 'phone', 't')
    await box.put(key, wav(1))
    const owned = await handleTimelineObject(new Request(`https://w.test/v1/timeline/object?key=${encodeURIComponent(key)}`), box, identity)
    expect(owned.status).toBe(200)
    expect(owned.headers.get('content-type')).toBe('audio/wav')
    const other = await handleTimelineObject(
      new Request(`https://w.test/v1/timeline/object?key=${encodeURIComponent(key)}`),
      box,
      { subject: 'user_bob' }
    )
    expect(other.status).toBe(403)
  })
})
