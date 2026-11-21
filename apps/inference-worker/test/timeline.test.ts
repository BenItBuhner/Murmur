import { describe, expect, it } from 'vitest'
import {
  handleTimelineAudio,
  handleTimelineObject,
  signStoreRequest,
  timelineKeyOwnedBy,
  timelineObjectKey,
  type TimelineStore
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

const identity = { subject: 'user_ada', email: 'ada@example.com' }
const store: TimelineStore = { url: 'https://timeline.example.test', secret: 's'.repeat(40) }

describe('timeline object keys', () => {
  it('keeps an account from reading another account object', () => {
    const key = timelineObjectKey('user_ada', 'phone', '2026-11-20T00:00:00Z')
    expect(timelineKeyOwnedBy(key, 'user_ada')).toBe(true)
    expect(timelineKeyOwnedBy(key, 'user_bob')).toBe(false)
    expect(timelineKeyOwnedBy('../secrets', 'user_ada')).toBe(false)
  })
})

describe('timeline audio on the worker', () => {
  it('does not call the store for silence, and still answers 200 when the store is down', async () => {
    const calls: string[] = []
    const link = {
      siteUrl: 'https://convex.test',
      secret: 's'.repeat(40),
      fetcher: async (input: RequestInfo | URL) => {
        calls.push(String(input))
        if (String(input).includes('timeline.example.test')) throw new Error('down')
        return new Response('{}')
      }
    }
    const hooks = { env: {}, access: async () => 'pro', authorize: async () => ({ ok: true }), record: async () => undefined, providerFailed: async () => ({ failures: 0, openForSec: null }), providerRecovered: async () => undefined } as never
    const silent = await handleTimelineAudio(
      new Request('https://w.test/v1/timeline/audio?device=phone&startedAt=2026-11-20T00:00:00Z&endedAt=2026-11-20T00:00:02Z', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Blob([wav(1).buffer as ArrayBuffer])
      }),
      store,
      link,
      hooks,
      identity
    )
    expect(silent.status).toBe(200)
    expect(await silent.json()).toMatchObject({ skipped: true, audioStored: false })
    expect(calls).toEqual([])
  })

  it('signs a store request the home lab can check', async () => {
    const body = new Uint8Array([1, 2, 3])
    const signed = await signStoreRequest(store.secret, 'PUT', '/objects/timeline/a/b.wav', body, 1_700_000_000_000)
    expect(signed.ts).toBe('1700000000000')
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.sha256).toHaveLength(64)
  })

  it('refuses another account the object', async () => {
    const key = timelineObjectKey('user_ada', 'phone', 't')
    const fetcher = async () => new Response(wav(1).buffer as ArrayBuffer)
    const other = await handleTimelineObject(
      new Request(`https://w.test/v1/timeline/object?key=${encodeURIComponent(key)}`),
      store,
      { subject: 'user_bob' },
      fetcher
    )
    expect(other.status).toBe(403)
  })
})
