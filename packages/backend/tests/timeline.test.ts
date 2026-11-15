/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from '../convex/schema'

const modules = import.meta.glob('../convex/**/*.ts')

/** A 16 kHz mono 16-bit PCM WAV of `seconds` of silence. */
function silentWav(seconds: number): Uint8Array {
  const rate = 16_000
  const n = rate * seconds
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const ascii = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  ascii(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ascii(36, 'data'); v.setUint32(40, n * 2, true)
  return new Uint8Array(buf)
}

const piece = '/v1/timeline/audio?device=d1&startedAt=2026-11-15T10:00:00Z&endedAt=2026-11-15T10:00:02Z'

describe('/v1/timeline/audio', () => {
  it('is routed and needs a sign-in', async () => {
    const t = convexTest(schema, modules)
    const res = await t.fetch(piece, { method: 'POST', body: silentWav(1) })
    expect(res.status).toBe(401)
  })

  it('skips silence without transcribing or storing anything', async () => {
    const t = convexTest(schema, modules).withIdentity({ subject: 'user_ana', email: 'ana@acme.com' })
    const res = await t.fetch(piece, { method: 'POST', body: silentWav(2) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: true })
    const rows = await t.run((ctx) => ctx.db.query('timelineChunks').collect())
    expect(rows).toHaveLength(0)
  })

  it('wants the piece described', async () => {
    const t = convexTest(schema, modules).withIdentity({ subject: 'user_ana' })
    const res = await t.fetch('/v1/timeline/audio', { method: 'POST', body: silentWav(1) })
    expect(res.status).toBe(400)
  })
})
