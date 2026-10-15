import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRANT_TIMEOUT_MS, GRANT_TTL_MS, grantFor, resetState, type ConvexLink } from '../src/state'

const identity = { subject: 'user_ada', email: 'ada@example.com', emailVerified: true } as never
const grant = { ok: true, plan: 'free', planState: 'active', stt: null, llm: null, format: { refusal: null, paused: null } }

/** A fetch that never answers until its signal aborts. */
const hanging: typeof fetch = (_input, init) =>
  new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))

describe('grantFor deadline', () => {
  afterEach(() => resetState())

  it('gives up on a hung Convex call and falls back to the cached grant', async () => {
    let calls = 0
    const ok: typeof fetch = async () => {
      calls++
      return new Response(JSON.stringify(grant), { status: 200 })
    }
    const link: ConvexLink = { siteUrl: 'https://c.test', secret: 's', fetcher: ok }
    const t0 = Date.now()
    await grantFor(link, identity, t0)
    expect(calls).toBe(1)
    const started = Date.now()
    const g = await grantFor({ ...link, fetcher: hanging }, identity, t0 + GRANT_TTL_MS + 1)
    expect(g.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(GRANT_TIMEOUT_MS + 1500)
  }, 10_000)

  it('throws (not hangs) when there is no cached grant', async () => {
    const link: ConvexLink = { siteUrl: 'https://c.test', secret: 's', fetcher: hanging }
    const started = Date.now()
    await expect(grantFor(link, identity)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(GRANT_TIMEOUT_MS + 1500)
  }, 10_000)
})
void vi
