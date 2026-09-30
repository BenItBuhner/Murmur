import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import {
  PRIVATE_TESTING_CODE,
  PRIVATE_TESTING_MESSAGE,
  accessStateOf,
  allowedEmails,
  onAllowlist,
  privateTesting
} from '../convex/lib/access'
import { PLANS, TRIAL_MS } from '../convex/lib/plans'
import {
  LLM_ENV,
  STT_ENV,
  ada,
  bob,
  chatAnswer,
  chatRequest,
  formatRequest,
  jsonResponse,
  makeWav,
  setup,
  sttRequest,
  stubEnv,
  stubFetch
} from './helpers'

/*
 * Private testing: while MURMUR_ALLOWED_EMAILS is set, only the accounts on it get managed models
 * (without limits); everyone else signs in, syncs and sees the account page as before, but every
 * gateway request is refused. Ada is on the list, Bob is not.
 */

const SITE = 'https://murmur.test'
const TESTING_ENV = { ...STT_ENV, ...LLM_ENV, MURMUR_SITE_URL: SITE, MURMUR_ALLOWED_EMAILS: 'ada@example.com' }
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const TODAY = '2026-09-30'

type T = ReturnType<typeof setup>

async function seedMonth(
  t: T,
  userId: Id<'users'>,
  fields: Partial<{ sttSeconds: number; llmTokens: number; windowStart: number; windowCount: number }>
): Promise<void> {
  await t.run(async (ctx) => {
    const period = '2026-09'
    const row = await ctx.db
      .query('inferenceUsage')
      .withIndex('by_user_and_period', (q) => q.eq('userId', userId).eq('period', period))
      .unique()
    const values = { sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0, ...fields, updatedAt: NOW }
    if (row) await ctx.db.patch('inferenceUsage', row._id, values)
    else await ctx.db.insert('inferenceUsage', { userId, period, ...values })
  })
}

async function refused(res: Response): Promise<void> {
  expect(res.status).toBe(429)
  expect(res.headers.get('retry-after')).toBeNull()
  const body = await res.json()
  expect(body).toEqual({
    error: { type: 'murmur_gateway_error', code: PRIVATE_TESTING_CODE, message: PRIVATE_TESTING_MESSAGE }
  })
  // A v0.5 client reads `error.message` and `error.code`, finds no `limit`, and shows the sentence.
  expect(body.error.limit).toBeUndefined()
  expect(body.error.message).toMatch(/^This Murmur server is in private testing/)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the list', () => {
  it('is read from MURMUR_ALLOWED_EMAILS, or is absent', () => {
    expect(allowedEmails({})).toBeNull()
    expect(allowedEmails({ MURMUR_ALLOWED_EMAILS: '' })).toBeNull()
    expect(allowedEmails({ MURMUR_ALLOWED_EMAILS: ' , ,' })).toBeNull()
    expect(privateTesting({})).toBe(false)
    expect(privateTesting({ MURMUR_ALLOWED_EMAILS: 'ada@example.com' })).toBe(true)
    expect([...allowedEmails({ MURMUR_ALLOWED_EMAILS: ' Ada@Example.com ,bob@example.com,, ' })!]).toEqual([
      'ada@example.com',
      'bob@example.com'
    ])
  })

  it('judges an account by the token email, then the stored email, case-insensitively', () => {
    const env = { MURMUR_ALLOWED_EMAILS: 'ada@example.com' }
    expect(onAllowlist(env, { email: 'ADA@example.com' })).toBe(true)
    expect(onAllowlist(env, { email: 'bob@example.com' })).toBe(false)
    expect(onAllowlist(env, { email: 'bob@example.com' }, 'ada@example.com')).toBe(false)
    // A token without the claim falls back to what the Clerk webhook stored.
    expect(onAllowlist(env, {}, 'ada@example.com')).toBe(true)
    expect(onAllowlist(env, null, 'Ada@Example.com')).toBe(true)
    expect(onAllowlist(env, {}, undefined)).toBe(false)
    // An address the token itself says is unverified never counts.
    expect(onAllowlist(env, { email: 'ada@example.com', emailVerified: false })).toBe(false)
    expect(onAllowlist(env, { email: 'ada@example.com', emailVerified: true })).toBe(true)
    // Without a list nobody is "on" it, and the stored plan state stands.
    expect(onAllowlist({}, { email: 'ada@example.com' })).toBe(false)
    expect(accessStateOf({}, 'trial', { email: 'ada@example.com' })).toBe('trial')
    expect(accessStateOf(env, 'trial', { email: 'ada@example.com' })).toBe('unlimited')
    expect(accessStateOf(env, 'pro', { email: 'bob@example.com' })).toBe('testing')
    expect(accessStateOf(env, 'free', null, 'ada@example.com')).toBe('unlimited')
  })
})

describe('an account that is not on the list', () => {
  beforeEach(() => stubEnv(TESTING_ENV))

  it('signs in and syncs as before; only the account page learns it is on the testing state', async () => {
    const t = setup()
    const asBob = t.withIdentity(bob)
    const user = await asBob.mutation(api.users.ensure, {})
    // The stored lifecycle is untouched: the trial starts as it always did.
    expect(user).toMatchObject({ plan: 'pro', planState: 'trial' })
    expect(user.trialEndsAt).toBe(NOW + TRIAL_MS)
    await asBob.mutation(api.dictionary.upsert, { word: 'Murmur' })
    expect(await asBob.query(api.dictionary.list, {})).toHaveLength(1)

    const status = await asBob.query(api.inference.status, { day: TODAY })
    expect(status).toMatchObject({
      available: true,
      models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
      plan: 'testing',
      planState: 'testing',
      billingEnabled: false,
      limits: { sttSecondsPerMonth: 0, llmTokensPerMonth: 0, requestsPerMinute: 0, maxClipSeconds: 0 },
      formattingPaused: false,
      upgradeUrl: null,
      accountUrl: `${SITE}/account`,
      meters: []
    })
    // Still the v0.5 shape: a tier, numeric limits, a usage block, a stored trial end.
    expect(status.usage).toEqual({ period: '', sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 })
    expect(status.trialEndsAt).toBe(NOW + TRIAL_MS)
    expect(status.window?.day).toBe(TODAY)
    expect(status.resets?.day).toBe(Date.UTC(2026, 9, 1))
    // Nothing to buy lifts the state, whether or not the instance sells Pro.
    stubEnv({ ...TESTING_ENV, MURMUR_BILLING_ENABLED: 'true' })
    const selling = await asBob.query(api.inference.status, {})
    expect(selling).toMatchObject({ planState: 'testing', billingEnabled: true, upgradeUrl: null })
  })

  it('is refused on every gateway route before anything reaches a provider or is counted', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'never', duration: 1 }))
    const t = setup()
    const asBob = t.withIdentity(bob)
    await refused(await asBob.fetch('/v1/models'))
    await refused(await asBob.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1))))
    await refused(await asBob.fetch('/v1/chat/completions', chatRequest()))
    await refused(await asBob.fetch('/v1/format', formatRequest('hello there everyone')))
    expect(calls).toHaveLength(0)
    const status = await asBob.query(api.inference.status, { day: TODAY })
    expect(status.usage.sttRequests).toBe(0)
    expect(status.usage.llmRequests).toBe(0)
    await t.run(async (ctx) => {
      // The gateway provisioned the row (with the token's email) and started its trial, as it does
      // for every first contact; it counted nothing.
      const [user] = await ctx.db.query('users').collect()
      expect(user).toMatchObject({ clerkId: 'user_bob', email: 'bob@example.com', plan: 'trial' })
      expect(await ctx.db.query('inferenceUsage').collect()).toHaveLength(0)
    })
    // Signing out still gets the ordinary answer.
    expect((await t.fetch('/v1/models')).status).toBe(401)
  })

  it('stays refused whatever its stored plan state says', async () => {
    stubFetch(() => jsonResponse({ text: 'never', duration: 1 }))
    const t = setup()
    const asBob = t.withIdentity(bob)
    await t.mutation(internal.users.setPlan, { clerkId: 'user_bob', plan: 'pro' })
    expect(await asBob.query(api.users.me, {})).toMatchObject({ plan: 'pro', planState: 'pro' })
    await refused(await asBob.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1))))
    expect((await asBob.query(api.inference.status, {})).planState).toBe('testing')
  })

  it('is refused when the token says its address is unverified, even if the address is on the list', async () => {
    stubFetch(() => jsonResponse({ text: 'never', duration: 1 }))
    const t = setup()
    const unverified = t.withIdentity({ ...ada, emailVerified: false })
    await refused(await unverified.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1))))
    expect((await unverified.query(api.inference.status, {})).planState).toBe('testing')
  })
})

describe('an account on the list', () => {
  beforeEach(() => stubEnv(TESTING_ENV))

  it('reads as unlimited: no meters, no upgrade, Pro figures where a v0.5 client prints numbers', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    const status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status).toMatchObject({
      available: true,
      plan: 'unlimited',
      planState: 'unlimited',
      billingEnabled: false,
      limits: {
        sttSecondsPerMonth: PLANS.pro.sttSecondsPerMonth,
        llmTokensPerMonth: PLANS.pro.llmTokensPerMonth,
        requestsPerMinute: 60,
        maxClipSeconds: 600
      },
      formattingPaused: false,
      upgradeUrl: null,
      accountUrl: `${SITE}/account`,
      meters: []
    })
    // Selling Pro changes nothing for an account that already has everything.
    stubEnv({ ...TESTING_ENV, MURMUR_BILLING_ENABLED: 'true' })
    expect(await asAda.query(api.inference.status, {})).toMatchObject({ planState: 'unlimited', upgradeUrl: null })
    // The stored lifecycle still reads through users.me, untouched.
    expect(await asAda.query(api.users.me, {})).toMatchObject({ plan: 'pro', planState: 'trial' })
  })

  it('dictates past every plan cap, on the better model, and is billed for the operator to see', async () => {
    const calls = stubFetch((url) =>
      url.includes('/audio/') ? jsonResponse({ text: 'still going', duration: 60 }) : chatAnswer('The budget is $1,200,000.')
    )
    const t = setup()
    const asAda = t.withIdentity(ada)
    const user = await asAda.mutation(api.users.ensure, {})
    // Far past Pro's hard fair-use cap and token allowance, on the free tier by stored state.
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    await seedMonth(t, user.id, { sttSeconds: PLANS.pro.sttSecondsPerMonth! * 3, llmTokens: PLANS.pro.llmTokensPerMonth! * 3 })
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++)
        await ctx.db.insert('inferenceDays', {
          userId: user.id,
          day: `2026-09-${String(23 + i).padStart(2, '0')}`,
          words: 5000,
          sttSeconds: 3000,
          dictations: 100,
          formats: 100,
          updatedAt: NOW
        })
    })
    expect((await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(60)))).status).toBe(200)
    expect((await asAda.fetch('/v1/chat/completions', chatRequest())).status).toBe(200)
    const format = await (
      await asAda.fetch('/v1/format', formatRequest('um the budget is one million two hundred thousand dollars'))
    ).json()
    expect(format.status.outcome).toBe('used')
    expect(format.limit).toBeUndefined()
    expect(calls).toHaveLength(3)
    // The instance's better model, as for Pro.
    expect(JSON.parse(calls[1].init.body as string).model).toBe('openai/gpt-oss-120b')
    const status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status.usage.sttRequests).toBe(1)
    expect(status.usage.llmRequests).toBe(2)
    expect(status.usage.sttSeconds).toBeCloseTo(PLANS.pro.sttSecondsPerMonth! * 3 + 60, 1)
    expect(status.meters).toEqual([])
    expect(status.formattingPaused).toBe(false)
  })

  it('keeps the two bounds that are about the service, not the account: the clip length and the request rate', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'ok', duration: 5 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const user = await asAda.mutation(api.users.ensure, {})
    const tooLong = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(601)))
    expect(tooLong.status).toBe(413)
    expect((await tooLong.json()).error).toMatchObject({ code: 'clip_too_long', plan: 'unlimited', planState: 'unlimited', upgradeUrl: null })
    await seedMonth(t, user.id, { windowStart: NOW, windowCount: 60 })
    const burst = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))
    expect(burst.status).toBe(429)
    expect((await burst.json()).error).toMatchObject({ code: 'rate_limited', limit: 'requestsPerMinute', allowed: 60 })
    expect(Number(burst.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
    vi.setSystemTime(NOW + 61_000)
    expect((await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))).status).toBe(200)
  })

  it('is recognised by the address the Clerk webhook stored when the token carries none', async () => {
    stubFetch(() => jsonResponse({ text: 'ok', duration: 1 }))
    const t = setup()
    await t.mutation(internal.users.upsertFromClerk, { clerkId: 'user_x', email: 'Ada@Example.com' })
    const bare = t.withIdentity({ subject: 'user_x' })
    expect((await bare.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(200)
    expect((await bare.query(api.inference.status, {})).planState).toBe('unlimited')
    // No address anywhere: not on the list.
    const nobody = t.withIdentity({ subject: 'user_y' })
    await refused(await nobody.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1))))
  })
})

describe('without a list', () => {
  it('every account is on its plan state, as before', async () => {
    stubEnv({ ...STT_ENV, ...LLM_ENV, MURMUR_SITE_URL: SITE })
    const calls = stubFetch(() => jsonResponse({ text: 'ok', duration: 1 }))
    const t = setup()
    const asBob = t.withIdentity(bob)
    await asBob.mutation(api.users.ensure, {})
    expect((await asBob.fetch('/v1/models')).status).toBe(200)
    expect((await asBob.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(200)
    expect(calls).toHaveLength(1)
    const status = await asBob.query(api.inference.status, { day: TODAY })
    expect(status).toMatchObject({ plan: 'pro', planState: 'trial', billingEnabled: false, upgradeUrl: null })
    expect(status.meters.map((m) => m.limit)).toEqual(['fairUseSttSecondsPerMonth', 'sttSecondsPerMonth', 'llmTokensPerMonth'])
    // A blank list is no list.
    stubEnv({ ...STT_ENV, ...LLM_ENV, MURMUR_ALLOWED_EMAILS: '  ' })
    expect((await asBob.query(api.inference.status, {})).planState).toBe('trial')
  })
})
