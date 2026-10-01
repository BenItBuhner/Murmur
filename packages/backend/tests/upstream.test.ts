import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import {
  PROVIDER_RETRY_AFTER_SEC,
  describeUpstreamFailure,
  describeUpstreamOutcome,
  unavailableMessage,
  upstreamFailureResponse
} from '../convex/lib/inference'
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  DEFAULT_BUDGETS,
  RETRY_PAUSE_MS,
  breakerAfterFailure,
  breakerOpenFor,
  callUpstream,
  readUpstreamBudgets,
  retryFits,
  retryWorthwhile,
  sttBudgetMs
} from '../convex/lib/upstream'
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A provider that never answers: the promise settles only when the gateway aborts the request. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        )
      })
  )
}

const empty503 = (): Response => new Response(null, { status: 503 })

const quiet = (): void => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

describe('upstream budgets', () => {
  it('scales the speech budget with the clip and caps it under the apps’ own timeout', () => {
    const stt = DEFAULT_BUDGETS.stt
    expect(sttBudgetMs(stt, 0)).toBe(15_000)
    expect(sttBudgetMs(stt, 5)).toBe(17_500)
    expect(sttBudgetMs(stt, 10)).toBe(20_000)
    expect(sttBudgetMs(stt, 30)).toBe(30_000)
    expect(sttBudgetMs(stt, 60)).toBe(35_000)
    expect(sttBudgetMs(stt, 600)).toBe(35_000)
    expect(sttBudgetMs(stt, Number.NaN)).toBe(15_000)
    // Every default stays under the clients' 45 s speech timeout and their 18 s /v1/format allowance.
    expect(stt.maxMs).toBeLessThan(45_000)
    expect(DEFAULT_BUDGETS.formatMs * 2).toBeLessThan(18_000)
    expect(DEFAULT_BUDGETS.chatMs).toBe(20_000)
  })

  it('takes the operator’s figures from the environment and ignores anything that is not a positive integer', () => {
    expect(readUpstreamBudgets({})).toEqual(DEFAULT_BUDGETS)
    const tuned = readUpstreamBudgets({
      MURMUR_INFERENCE_STT_TIMEOUT_MS: ' 12000 ',
      MURMUR_INFERENCE_LLM_TIMEOUT_MS: '5000',
      MURMUR_INFERENCE_CHAT_TIMEOUT_MS: '30000'
    })
    expect(tuned.stt.fixedMs).toBe(12_000)
    expect(sttBudgetMs(tuned.stt, 600)).toBe(12_000)
    expect(tuned.formatMs).toBe(5_000)
    expect(tuned.chatMs).toBe(30_000)
    const junk = readUpstreamBudgets({
      MURMUR_INFERENCE_STT_TIMEOUT_MS: 'soon',
      MURMUR_INFERENCE_LLM_TIMEOUT_MS: '-3',
      MURMUR_INFERENCE_CHAT_TIMEOUT_MS: '2.5'
    })
    expect(junk).toEqual(DEFAULT_BUDGETS)
  })
})

describe('callUpstream', () => {
  it('answers within the budget and drops a hung connection', async () => {
    const fetchFn = hangingFetch()
    const started = Date.now()
    const outcome = await callUpstream('https://p.test/v1/x', () => ({ method: 'POST' }), 120, fetchFn as typeof fetch)
    expect(outcome.kind).toBe('timeout')
    expect(outcome.attempts).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_500)
    const init = fetchFn.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(true)
  })

  it('retries once after a connection failure and after an empty 502/503, with a fresh body each time', async () => {
    const bodies: unknown[] = []
    let calls = 0
    const flaky = vi.fn(async (_url: string, init: RequestInit = {}) => {
      bodies.push(init.body)
      if (++calls === 1) throw new TypeError('fetch failed: connection reset')
      return jsonResponse({ text: 'fine' })
    })
    const recovered = await callUpstream(
      'https://p.test/v1/x',
      () => ({ method: 'POST', body: `attempt-${bodies.length + 1}` }),
      10_000,
      flaky as typeof fetch
    )
    expect(recovered.kind).toBe('response')
    expect(recovered.attempts).toBe(2)
    expect(bodies).toEqual(['attempt-1', 'attempt-2'])
    expect(recovered.elapsedMs).toBeGreaterThanOrEqual(RETRY_PAUSE_MS - 20)

    const dead = vi.fn(async () => empty503())
    const gaveUp = await callUpstream('https://p.test/v1/x', () => ({}), 10_000, dead as typeof fetch)
    expect(gaveUp.kind).toBe('response')
    expect(gaveUp.attempts).toBe(2)
    expect(dead).toHaveBeenCalledTimes(2)
    if (gaveUp.kind === 'response') expect(gaveUp.res.status).toBe(503)
  })

  it('never retries an answer with something in it, a timeout, or when the budget is nearly spent', async () => {
    const said = vi.fn(async () => jsonResponse({ error: { message: 'model is loading' } }, 503))
    const withBody = await callUpstream('https://p.test/v1/x', () => ({}), 10_000, said as typeof fetch)
    expect(withBody.attempts).toBe(1)
    expect(said).toHaveBeenCalledTimes(1)

    const fourHundred = vi.fn(async () => jsonResponse({ error: { message: 'bad language' } }, 400))
    expect((await callUpstream('https://p.test/v1/x', () => ({}), 10_000, fourHundred as typeof fetch)).attempts).toBe(1)

    // An instant empty 503 with only 600 ms of budget: no room for the pause plus a real attempt.
    const dead = vi.fn(async () => empty503())
    const tight = await callUpstream('https://p.test/v1/x', () => ({}), 600, dead as typeof fetch)
    expect(tight.attempts).toBe(1)
    expect(dead).toHaveBeenCalledTimes(1)

    expect(retryWorthwhile({ kind: 'unreachable' })).toBe(true)
    expect(retryWorthwhile({ kind: 'response', res: empty503(), text: '  ' })).toBe(true)
    expect(retryWorthwhile({ kind: 'response', res: new Response(null, { status: 502 }), text: '' })).toBe(true)
    expect(retryWorthwhile({ kind: 'response', res: new Response(null, { status: 504 }), text: '' })).toBe(false)
    expect(retryWorthwhile({ kind: 'response', res: new Response(null, { status: 503 }), text: 'nope' })).toBe(false)
    expect(retryWorthwhile({ kind: 'response', res: new Response(null, { status: 429 }), text: '' })).toBe(false)
    expect(retryWorthwhile({ kind: 'timeout' })).toBe(false)
    expect(retryFits(100, 5_000)).toBe(true)
    expect(retryFits(2_500, 20_000)).toBe(false)
    expect(retryFits(100, 1_200)).toBe(false)
  })
})

describe('the provider_unavailable contract', () => {
  it('reports 502/503/504, a timeout and an unreachable provider as unavailable, and passes real 4xx through', () => {
    const gone = describeUpstreamFailure(503, '', 'stt')
    expect(gone).toMatchObject({
      status: 503,
      code: 'provider_unavailable',
      message: "Murmur's speech service is unavailable right now",
      unavailable: { service: 'speech', reason: 'unavailable', retryAfterSec: PROVIDER_RETRY_AFTER_SEC }
    })
    expect(gone.detail).toBeUndefined()
    const said = describeUpstreamFailure(502, '{"error":{"message":"no healthy upstream"}}', 'llm')
    expect(said.message).toBe("Murmur's formatting service is unavailable right now")
    expect(said.detail).toBe('no healthy upstream')
    expect(describeUpstreamFailure(504, 'Gateway Time-out').code).toBe('provider_unavailable')
    // The provider's own Retry-After is passed on when it is a sensible number of seconds.
    const headers = new Headers({ 'retry-after': '30' })
    expect(describeUpstreamFailure(503, '', 'stt', headers).unavailable?.retryAfterSec).toBe(30)
    expect(describeUpstreamFailure(503, '', 'stt', new Headers({ 'retry-after': '86400' })).unavailable?.retryAfterSec).toBe(PROVIDER_RETRY_AFTER_SEC)
    expect(describeUpstreamFailure(503, '', 'stt', new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).unavailable?.retryAfterSec).toBe(PROVIDER_RETRY_AFTER_SEC)

    expect(describeUpstreamFailure(500, 'boom')).toMatchObject({ status: 502, code: 'upstream_error', message: 'boom' })
    expect(describeUpstreamFailure(429, 'slow down')).toMatchObject({ status: 503, code: 'upstream_busy' })
    expect(describeUpstreamFailure(400, '{"error":{"message":"bad language"}}')).toMatchObject({ status: 400, code: 'bad_request', message: 'bad language' })
    expect(describeUpstreamFailure(401, 'bad key', 'llm').message).toMatch(/formatting provider/)

    expect(describeUpstreamOutcome('stt', { kind: 'timeout', attempts: 1, elapsedMs: 15_000 })).toMatchObject({
      status: 503,
      code: 'provider_unavailable',
      unavailable: { service: 'speech', reason: 'timeout' }
    })
    expect(describeUpstreamOutcome('llm', { kind: 'unreachable', detail: 'ECONNRESET', attempts: 2, elapsedMs: 400 })).toMatchObject({
      unavailable: { service: 'formatting', reason: 'unreachable' },
      detail: 'ECONNRESET'
    })
    expect(unavailableMessage('stt')).toBe("Murmur's speech service is unavailable right now")
  })

  it('answers with a 503, Retry-After and the structured fields next to the sentence', async () => {
    const res = upstreamFailureResponse(describeUpstreamOutcome('stt', { kind: 'timeout', attempts: 1, elapsedMs: 1 }))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(String(PROVIDER_RETRY_AFTER_SEC))
    expect(await res.json()).toEqual({
      error: {
        type: 'murmur_gateway_error',
        code: 'provider_unavailable',
        message: "Murmur's speech service is unavailable right now",
        service: 'speech',
        reason: 'timeout',
        retryAfterSec: PROVIDER_RETRY_AFTER_SEC
      }
    })
    // The breaker's remaining cooldown wins over the default hint.
    const open = upstreamFailureResponse(describeUpstreamFailure(503, '', 'llm'), 7)
    expect(open.headers.get('retry-after')).toBe('7')
    expect((await open.json()).error.retryAfterSec).toBe(7)
    // Other failures keep their shape: no Retry-After, no service fields.
    const plain = upstreamFailureResponse(describeUpstreamFailure(500, 'boom'))
    expect(plain.status).toBe(502)
    expect(plain.headers.get('retry-after')).toBeNull()
    expect((await plain.json()).error).toEqual({ type: 'murmur_gateway_error', code: 'upstream_error', message: 'boom' })
  })

  it('the breaker opens on the third unavailable answer in a row and closes after the cooldown', () => {
    const now = 1_000_000
    let state = { failures: 0, openUntil: null as number | null }
    for (let i = 1; i < BREAKER_THRESHOLD; i++) {
      state = breakerAfterFailure(state, now)
      expect(state).toEqual({ failures: i, openUntil: null })
    }
    state = breakerAfterFailure(state, now)
    expect(state).toEqual({ failures: BREAKER_THRESHOLD, openUntil: now + BREAKER_COOLDOWN_MS })
    expect(breakerOpenFor(state, now)).toBe(BREAKER_COOLDOWN_MS)
    expect(breakerOpenFor(state, now + BREAKER_COOLDOWN_MS - 1)).toBe(1)
    expect(breakerOpenFor(state, now + BREAKER_COOLDOWN_MS)).toBeNull()
    // Failing again while half-open re-opens it for a full cooldown.
    const later = now + BREAKER_COOLDOWN_MS + 5_000
    expect(breakerAfterFailure(state, later)).toEqual({ failures: BREAKER_THRESHOLD + 1, openUntil: later + BREAKER_COOLDOWN_MS })
  })
})

describe('the gateway when its provider is slow or down', () => {
  const health = (t: ReturnType<typeof setup>, kind: 'stt' | 'llm') =>
    t.run(async (ctx) =>
      ctx.db
        .query('providerHealth')
        .withIndex('by_kind', (q) => q.eq('kind', kind))
        .unique()
    )

  it('a hung speech provider is cut off at the budget and reported as unavailable, once, unbilled', async () => {
    quiet()
    stubEnv({ ...STT_ENV, MURMUR_INFERENCE_STT_TIMEOUT_MS: '200' })
    const fetchFn = hangingFetch()
    vi.stubGlobal('fetch', fetchFn)
    const t = setup()
    const asAda = t.withIdentity(ada)
    const started = Date.now()
    const res = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(2)))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(String(PROVIDER_RETRY_AFTER_SEC))
    expect(await res.json()).toEqual({
      error: {
        type: 'murmur_gateway_error',
        code: 'provider_unavailable',
        message: "Murmur's speech service is unavailable right now",
        service: 'speech',
        reason: 'timeout',
        retryAfterSec: PROVIDER_RETRY_AFTER_SEC
      }
    })
    // A timeout already spent the budget: no second attempt, and the hung request was aborted.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((fetchFn.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.sttRequests).toBe(0)
    expect(status.usage.sttSeconds).toBe(0)
    expect(await health(t, 'stt')).toMatchObject({ failures: 1, lastReason: 'timeout' })
  })

  it('an empty 503 is tried once more and then given up on as unavailable; one with a body is not retried', async () => {
    quiet()
    stubEnv(STT_ENV)
    const dead = stubFetch(() => empty503())
    const t = setup()
    const asAda = t.withIdentity(ada)
    const res = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatchObject({ code: 'provider_unavailable', service: 'speech', reason: 'unavailable' })
    expect(body.error.detail).toBeUndefined()
    expect(dead).toHaveLength(2)
    expect((await asAda.query(api.inference.status, {})).usage.sttRequests).toBe(0)

    const loading = stubFetch(() =>
      new Response(JSON.stringify({ error: { message: 'model is loading' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '20' }
      })
    )
    const said = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(said.status).toBe(503)
    expect(said.headers.get('retry-after')).toBe('20')
    expect((await said.json()).error).toMatchObject({ code: 'provider_unavailable', detail: 'model is loading', retryAfterSec: 20 })
    expect(loading).toHaveLength(1)
  })

  it('a connection the provider reset is sent again and the second answer is billed once', async () => {
    quiet()
    stubEnv(STT_ENV)
    let calls = 0
    const flaky = vi.fn(async () => {
      if (++calls === 1) throw new TypeError('fetch failed: ECONNRESET')
      return jsonResponse({ text: 'hello there', duration: 2 })
    })
    vi.stubGlobal('fetch', flaky)
    const t = setup()
    const asAda = t.withIdentity(ada)
    const res = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(2)))
    expect(res.status).toBe(200)
    expect((await res.json()).text).toBe('hello there')
    expect(flaky).toHaveBeenCalledTimes(2)
    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.sttRequests).toBe(1)
    expect(status.usage.sttSeconds).toBeCloseTo(2, 1)
  })

  it('a real 400 and a 500 from the provider keep their own answers and never trip the breaker', async () => {
    quiet()
    stubEnv(STT_ENV)
    let upstream: Response = jsonResponse({ error: { message: 'Unsupported language xx' } }, 400)
    const calls = stubFetch(() => upstream)
    const t = setup()
    const asAda = t.withIdentity(ada)
    const bad = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1), { language: 'xx' }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toEqual({ type: 'murmur_gateway_error', code: 'bad_request', message: 'Unsupported language xx' })
    expect(bad.headers.get('retry-after')).toBeNull()
    upstream = new Response('boom', { status: 500 })
    const broken = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(broken.status).toBe(502)
    expect((await broken.json()).error.code).toBe('upstream_error')
    expect(calls).toHaveLength(2)
    expect(await health(t, 'stt')).toBeNull()
  })

  it('after three unavailable answers in a row the breaker answers for the provider, then lets one request probe it', async () => {
    quiet()
    stubEnv(STT_ENV)
    const loading = stubFetch(() => jsonResponse({ error: { message: 'no healthy upstream' } }, 503))
    const t = setup()
    const asAda = t.withIdentity(ada)
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      const res = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
      expect(res.status).toBe(503)
      expect((await res.json()).error.code).toBe('provider_unavailable')
    }
    expect(loading).toHaveLength(BREAKER_THRESHOLD)
    const opened = await health(t, 'stt')
    expect(opened?.failures).toBe(BREAKER_THRESHOLD)
    expect(opened?.openUntil).toBeGreaterThan(Date.now())

    // Open: the provider is not asked, and the answer says when to try again.
    const shortCircuit = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(shortCircuit.status).toBe(503)
    const retryAfter = Number(shortCircuit.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(BREAKER_COOLDOWN_MS / 1000)
    expect((await shortCircuit.json()).error).toMatchObject({
      code: 'provider_unavailable',
      service: 'speech',
      reason: 'unavailable',
      retryAfterSec: retryAfter
    })
    expect(loading).toHaveLength(BREAKER_THRESHOLD)
    // Another account is refused the same way: the provider is down for everyone, and the
    // refusal costs neither of them anything.
    const asBob = t.withIdentity(bob)
    expect((await asBob.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(503)
    expect(loading).toHaveLength(BREAKER_THRESHOLD)
    expect((await asBob.query(api.inference.status, {})).usage.sttRequests).toBe(0)

    // The cooldown has passed: the next request goes through, and a good answer resets the count.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('providerHealth').first())!
      await ctx.db.patch('providerHealth', row._id, { openUntil: Date.now() - 1 })
    })
    const back = stubFetch(() => jsonResponse({ text: 'back again' }))
    const probe = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(probe.status).toBe(200)
    expect(back).toHaveLength(1)
    expect(await health(t, 'stt')).toMatchObject({ failures: 0 })
    expect((await health(t, 'stt'))?.openUntil).toBeUndefined()
  })

  it('a formatting provider that is down never fails a dictation: rule-based text, the sentence as the reason, nothing billed', async () => {
    quiet()
    stubEnv({ ...LLM_ENV, MURMUR_INFERENCE_LLM_TIMEOUT_MS: '200' })
    const fetchFn = hangingFetch()
    vi.stubGlobal('fetch', fetchFn)
    const t = setup()
    const asAda = t.withIdentity(ada)
    const started = Date.now()
    const res = await asAda.fetch('/v1/format', formatRequest('hello there everyone how are you'))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.text).toBe('Hello there everyone how are you')
    expect(out.status).toMatchObject({ outcome: 'failed', detail: "Murmur's formatting service is unavailable right now", attempts: 1 })
    // The engine does not spend its strict retry on a provider that is not answering.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((await asAda.query(api.inference.status, {})).usage.llmRequests).toBe(0)
    expect(await health(t, 'llm')).toMatchObject({ failures: 1, lastReason: 'timeout' })

    // With the breaker open the model is not even asked; the text still goes out at once.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('providerHealth').first())!
      await ctx.db.patch('providerHealth', row._id, { failures: BREAKER_THRESHOLD, openUntil: Date.now() + BREAKER_COOLDOWN_MS })
    })
    const open = await asAda.fetch('/v1/format', formatRequest('hello there everyone how are you'))
    expect(open.status).toBe(200)
    const skipped = await open.json()
    expect(skipped.text).toBe('Hello there everyone how are you')
    expect(skipped.status).toMatchObject({ outcome: 'failed', detail: "Murmur's formatting service is unavailable right now" })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // ...while the chat route, which cannot degrade, is refused outright with the cooldown.
    const chat = await asAda.fetch('/v1/chat/completions', chatRequest())
    expect(chat.status).toBe(503)
    expect((await chat.json()).error).toMatchObject({ code: 'provider_unavailable', service: 'formatting' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a chat completion behind an empty 502 is tried once more, then reported unavailable for the formatting service', async () => {
    quiet()
    stubEnv(LLM_ENV)
    const dead = stubFetch(() => new Response('', { status: 502 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const res = await asAda.fetch('/v1/chat/completions', chatRequest())
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(String(PROVIDER_RETRY_AFTER_SEC))
    expect((await res.json()).error).toMatchObject({ code: 'provider_unavailable', service: 'formatting', reason: 'unavailable' })
    expect(dead).toHaveLength(2)
    expect((await asAda.query(api.inference.status, {})).usage.llmRequests).toBe(0)

    // The next good answer is billed and clears the count.
    const fine = stubFetch(() => chatAnswer('Hello.'))
    expect((await asAda.fetch('/v1/chat/completions', chatRequest())).status).toBe(200)
    expect(fine).toHaveLength(1)
    expect(await health(t, 'llm')).toMatchObject({ failures: 0 })
  })

  it('sign-in, private testing and plan limits are judged before the breaker, so their answers are unchanged', async () => {
    quiet()
    stubEnv({ ...STT_ENV, MURMUR_ALLOWED_EMAILS: 'ada@example.com' })
    const calls = stubFetch(() => jsonResponse({ text: 'hi' }))
    const t = setup()
    await t.mutation(internal.inference.providerFailed, { kind: 'stt', reason: 'timeout' })
    await t.mutation(internal.inference.providerFailed, { kind: 'stt', reason: 'timeout' })
    await t.mutation(internal.inference.providerFailed, { kind: 'stt', reason: 'unavailable' })
    expect((await health(t, 'stt'))?.openUntil).toBeGreaterThan(Date.now())
    expect((await t.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(401)
    const testing = await t.withIdentity(bob).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(testing.status).toBe(429)
    expect((await testing.json()).error.code).toBe('private_testing')
    const open = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(open.status).toBe(503)
    expect((await open.json()).error.code).toBe('provider_unavailable')
    expect(calls).toHaveLength(0)
    // Recovery is explicit too.
    await t.mutation(internal.inference.providerRecovered, { kind: 'stt' })
    expect((await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(200)
    expect(calls).toHaveLength(1)
  })
})
