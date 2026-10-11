import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { parseUsageRecords } from '../convex/lib/worker'
import { usageDay, usagePeriod } from '../convex/lib/plans'
import { STT_ENV, ada, bob, makeWav, setup, sttRequest, stubEnv } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const entry = (id: string, createdAt: number) => ({
  entryId: id,
  createdAt,
  mode: 'hold' as const,
  finalText: `Final ${id}.`,
  wordCount: 2,
  speechMs: 900,
  provider: 'murmur',
  model: 'm',
  llmUsed: false
})

const SECRET = 'w'.repeat(40)

describe('history.since', () => {
  it('starts with the newest page, then returns only what arrived after the cursor', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.history.push, {
      deviceId: 'desk',
      entries: Array.from({ length: 25 }, (_, i) => entry(`e${i}`, i))
    })
    const first = await asAda.query(api.history.since, {})
    expect(first.entries).toHaveLength(20)
    expect(first.more).toBe(false)
    expect(first.entries[19].entryId).toBe('e24')

    const none = await asAda.query(api.history.since, { cursor: first.cursor })
    expect(none.entries).toEqual([])
    expect(none.cursor).toBe(first.cursor)

    // Pushed late with an old device timestamp: still picked up, because the cursor is server time.
    await asAda.mutation(api.history.push, { deviceId: 'phone', entries: [entry('late', 0)] })
    const next = await asAda.query(api.history.since, { cursor: first.cursor })
    expect(next.entries.map((e) => e.entryId)).toEqual(['late'])
    expect(next.cursor).toBeGreaterThan(first.cursor)

    const paged = await asAda.query(api.history.since, { cursor: 0, limit: 10 })
    expect(paged.entries).toHaveLength(10)
    expect(paged.more).toBe(true)
    expect(await t.withIdentity(bob).query(api.history.since, {})).toEqual({ entries: [], cursor: 0, more: false })
  })
})

describe('stats.recordMany', () => {
  it('records a batch with the same idempotency as recordSession', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.stats.recordSession, { words: 5, speechMs: 1000, day: '2026-10-09', sessionId: 's0' })
    const after = await asAda.mutation(api.stats.recordMany, {
      sessions: [
        { words: 5, speechMs: 1000, day: '2026-10-09', sessionId: 's0' },
        { words: 3, speechMs: 500, day: '2026-10-10', sessionId: 's1' },
        { words: 2, speechMs: 500, day: '2026-10-10', sessionId: 's1' },
        { words: 4, speechMs: 200, day: '2026-10-10', sessionId: 's2' }
      ]
    })
    expect(after).toMatchObject({ totalWords: 12, totalSessions: 3, totalSpeechMs: 1700, streakDays: 2, lastSessionDay: '2026-10-10' })
    const fresh = await t.withIdentity(bob).mutation(api.stats.recordMany, {
      sessions: [{ words: 1, speechMs: 1, day: '2026-10-10' }]
    })
    expect(fresh).toMatchObject({ totalWords: 1, totalSessions: 1 })
    expect(await t.withIdentity(bob).mutation(api.stats.recordMany, { sessions: [] })).toMatchObject({ totalSessions: 1 })
  })
})

describe('worker endpoints', () => {
  it('refuse without the shared secret', async () => {
    const t = setup()
    expect((await t.fetch('/worker/grant', { method: 'POST', body: '{}' })).status).toBe(503)
    stubEnv({ MURMUR_WORKER_SECRET: SECRET })
    expect(
      (await t.fetch('/worker/grant', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status
    ).toBe(401)
  })

  it('grant an allowance and record batched usage', async () => {
    stubEnv({ MURMUR_WORKER_SECRET: SECRET })
    const t = setup()
    const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
    const grant = await t.fetch('/worker/grant', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ clerkId: 'user_ada', email: 'ada@example.com' })
    })
    expect(grant.status).toBe(200)
    const body = await grant.json()
    expect(body).toMatchObject({ ok: true, plan: 'pro', planState: 'trial', stt: null, llm: null })

    const now = Date.now()
    const usage = await t.fetch('/worker/usage', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        records: [
          { clerkId: 'user_ada', kind: 'stt', seconds: 4, words: 10, at: now },
          { clerkId: 'user_ada', kind: 'stt', seconds: 2, words: 5, at: now },
          { clerkId: 'user_ada', kind: 'llm', tokens: 300, at: now },
          { clerkId: 'user_ghost', kind: 'llm', tokens: 1, at: now }
        ]
      })
    })
    expect(await usage.json()).toEqual({ recorded: 3, dropped: 1 })
    await t.run(async (ctx) => {
      const [month] = await ctx.db.query('inferenceUsage').collect()
      expect(month).toMatchObject({ period: usagePeriod(now), sttSeconds: 6, sttRequests: 2, llmTokens: 300, llmRequests: 1 })
      const [day] = await ctx.db.query('inferenceDays').collect()
      expect(day).toMatchObject({ day: usageDay(now), words: 15, sttSeconds: 6, dictations: 2, formats: 1 })
    })
    expect(
      (await t.fetch('/worker/usage', { method: 'POST', headers: auth, body: JSON.stringify({ records: [{ kind: 'x' }] }) }))
        .status
    ).toBe(400)
  })

  it('validates usage reports', () => {
    expect(parseUsageRecords('x')).toBeNull()
    expect(parseUsageRecords([{ clerkId: 'a', kind: 'stt', at: 1, seconds: 'no' }])).toEqual([
      { clerkId: 'a', kind: 'stt', at: 1, seconds: undefined, tokens: undefined, words: undefined }
    ])
    expect(parseUsageRecords(new Array(501).fill({ clerkId: 'a', kind: 'stt', at: 1 }))).toBeNull()
  })

  it('recordBatch counts a stale timestamp toward today', async () => {
    const t = setup()
    await t.withIdentity(ada).mutation(api.users.ensure, {})
    await t.mutation(internal.inference.recordBatch, {
      records: [{ clerkId: 'user_ada', kind: 'llm', tokens: 5, at: 1 }]
    })
    await t.run(async (ctx) => {
      const [day] = await ctx.db.query('inferenceDays').collect()
      expect(day.day).toBe(usageDay(Date.now()))
    })
  })
})

describe('legacy Convex gateway flag', () => {
  it('turns the /v1 routes off with MURMUR_CONVEX_GATEWAY=off', async () => {
    stubEnv({ ...STT_ENV, MURMUR_CONVEX_GATEWAY: 'off' })
    const t = setup()
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('not_configured')
  })
})
