import { afterEach, describe, expect, it } from 'vitest'
import {
  FORMAT_MAX_CONCURRENT,
  FORMAT_MAX_PER_MINUTE,
  admitFormat,
  dedupeFormat,
  releaseFormat,
  resetFormatGuard
} from '../convex/lib/formatGuard'

afterEach(() => resetFormatGuard())

describe('per-user format guards', () => {
  it('caps concurrent formats per user, and frees a slot on release', () => {
    for (let i = 0; i < FORMAT_MAX_CONCURRENT; i++) expect(admitFormat('ada', 0).ok).toBe(true)
    expect(admitFormat('ada', 0)).toEqual({ ok: false, reason: 'concurrency' })
    // Another user is not affected.
    expect(admitFormat('bob', 0).ok).toBe(true)
    releaseFormat('ada')
    expect(admitFormat('ada', 0).ok).toBe(true)
  })

  it('caps formats per user per rolling minute', () => {
    for (let i = 0; i < FORMAT_MAX_PER_MINUTE; i++) {
      expect(admitFormat('ada', i).ok).toBe(true)
      releaseFormat('ada')
    }
    expect(admitFormat('ada', 1_000)).toEqual({ ok: false, reason: 'rate' })
    expect(admitFormat('ada', 60_001).ok).toBe(true)
  })

  it('identical requests in flight share one run', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const work = async () => {
      runs++
      await gate
      return { text: 'Hello.' }
    }
    const both = Promise.all([dedupeFormat('ada|x', work), dedupeFormat('ada|x', work), dedupeFormat('ada|y', work)])
    release()
    const [a, b, c] = await both
    expect(runs).toBe(2)
    expect([a.shared, b.shared, c.shared]).toEqual([false, true, false])
    expect(b.value).toEqual({ text: 'Hello.' })
    // Once done, the same request runs again.
    await dedupeFormat('ada|x', work)
    expect(runs).toBe(3)
  })
})
