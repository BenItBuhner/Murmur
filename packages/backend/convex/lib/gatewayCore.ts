import { formatTranscript } from '../../../text-engine/src/format'
import { dropSilentSegments } from '../../../text-engine/src/hallucination'
import { sttLanguageField } from '../../../text-engine/src/languages'
import type { ChatMessage, ChatOptions, ChatResult } from '../../../text-engine/src/types'
import {
  MAX_COMPLETION_TOKENS,
  MURMUR_MODELS,
  SPEED_FALLBACK_HEADER,
  SPEED_FIELD,
  SPEED_HEADER,
  SPEED_MODES,
  STT_PASSTHROUGH_FIELDS,
  chooseSttModel,
  clipSeconds,
  measuredSeconds,
  describeUpstreamOutcome,
  gatewayError,
  limitDetail,
  limitError,
  modelsPayload,
  multipartBoundary,
  parseFormatRequest,
  parseMultipart,
  parseSpeedMode,
  privateTestingError,
  providerDownFailure,
  readUpstreams,
  tokensUsed,
  transcriptWords,
  unavailableMessage,
  upstreamFailureResponse,
  upstreamModelFor,
  upstreamRejectedModel,
  type Env,
  type GatewayIdentity,
  type InferenceKind,
  type MultipartFile,
  type SpeedFallback,
  type SpeedMode,
  type Upstream,
  type UpstreamFailure,
  chooseLlmModel,
  LLM_SPEED_HEADER,
  parseTier,
  TIER_HEADER,
  type Tier
} from './inference'
import type { Meter, Refusal } from './entitlements'
import type { AccessState, Plan } from './plans'
import { admitFormat, dedupeFormat, releaseFormat } from './formatGuard'
import {
  callUpstream,
  hedgeAfterMs,
  hedged,
  readUpstreamBudgets,
  sttBudgetMs,
  type UnavailableReason
} from './upstream'

/**
 * Managed inference: an OpenAI-compatible facade in front of the model providers the operator
 * configured for this instance. Clients authenticate with their Clerk session JWT (as the bearer
 * token, exactly where an API key would go), the account's tier decides the allowance, and the
 * provider credentials never leave the deployment's environment variables. During private testing
 * (lib/access.ts) only the accounts on the list get past `authorize`.
 *
 * Every provider call runs under a budget with one safe retry (lib/upstream.ts); a provider that
 * is down answers `provider_unavailable` within it, and after a few such answers in a row the
 * breaker answers for it until the cooldown has passed.
 *
 * Shared by convex/gateway.ts (Convex HTTP actions, kept behind MURMUR_CONVEX_GATEWAY) and the
 * inference Worker in apps/inference-worker.
 */

const JSON_HEADERS = { 'content-type': 'application/json' }

/** The provider's recent health as the gate saw it (the breaker in lib/upstream.ts). */
export interface ProviderState {
  failures: number
  openForSec: number | null
}

/** What `authorize` answers; mirrors `inference.authorize`'s validator with ids as strings. */
export type Gate =
  | {
      ok: true
      /** Whatever the `record` hook needs to find the account again (a Convex id, a Clerk id). */
      userId: string
      plan: Plan
      planState: AccessState
      paused: Meter | null
      provider: ProviderState
    }
  | { ok: false; plan: Plan; planState: AccessState; refusal: Refusal; denied?: undefined; unavailable?: undefined }
  | { ok: false; plan: 'testing'; planState: 'testing'; denied: 'private_testing'; unavailable?: undefined }
  | { ok: false; plan: Plan; planState: AccessState; unavailable: { retryAfterSec: number }; denied?: undefined }
type Allowed = Extract<Gate, { ok: true }>

/**
 * Where the gateway keeps its state. The Convex HTTP actions (convex/gateway.ts) back these with
 * internal functions; the inference Worker (apps/inference-worker) backs them with a cached
 * entitlement lookup, an in-memory breaker and batched usage reports, so a dictation through the
 * Worker costs Convex nothing per request.
 */
export interface GatewayHooks {
  env: Env
  access(identity: GatewayIdentity): Promise<AccessState>
  authorize(args: {
    identity: GatewayIdentity
    kind: InferenceKind
    seconds?: number
    degradable?: boolean
  }): Promise<Gate>
  record(args: {
    userId: string
    identity: GatewayIdentity
    kind: InferenceKind
    seconds?: number
    tokens?: number
    words?: number
  }): Promise<void>
  providerFailed(kind: InferenceKind, reason: UnavailableReason): Promise<ProviderState>
  providerRecovered(kind: InferenceKind): Promise<void>
}

/** The answer for a request `authorize` turned down. */
function gateRefusal(hooks: GatewayHooks, gate: Exclude<Gate, { ok: true }>, kind: InferenceKind): Response {
  if (gate.denied !== undefined) return privateTestingError()
  if (gate.unavailable !== undefined) {
    console.warn(`[gateway] ${kind} provider breaker open; refused without asking the provider`)
    return upstreamFailureResponse(providerDownFailure(kind, gate.unavailable.retryAfterSec))
  }
  return limitError(gate.refusal, gate.plan, gate.planState, hooks.env)
}

/**
 * A provider call that did not come back usable: a `provider_unavailable` counts against the
 * provider's breaker and carries the cooldown it may have opened as its `Retry-After`; every
 * other failure is reported as it is. Nothing is billed for any of them.
 */
async function providerFailure(
  hooks: GatewayHooks,
  kind: InferenceKind,
  failure: UpstreamFailure,
  upstreamMs: number
): Promise<Response> {
  if (!failure.unavailable) {
    console.warn(`[gateway] ${kind} upstream -> ${failure.status} ${failure.code} upstreamMs=${upstreamMs}`)
    return upstreamFailureResponse(failure)
  }
  const state = await hooks.providerFailed(kind, failure.unavailable.reason)
  console.warn(
    `[gateway] ${kind} provider unavailable (${failure.unavailable.reason}${failure.detail ? `: ${failure.detail.slice(0, 120)}` : ''}) upstreamMs=${upstreamMs} failures=${state.failures}${state.openForSec !== null ? ` breakerOpenSec=${state.openForSec}` : ''}`
  )
  return upstreamFailureResponse(failure, state.openForSec ?? undefined)
}

/** The provider answered: forget the failures counted against it, if there were any. */
async function providerAnswered(hooks: GatewayHooks, kind: InferenceKind, gate: Allowed): Promise<void> {
  if (gate.provider.failures > 0) await hooks.providerRecovered(kind)
}

function modelNotFound(requested: string, available: string): Response {
  return gatewayError(
    404,
    'model_not_found',
    `Unknown model "${requested}". Available models: ${available}`
  )
}

export async function handleModels(hooks: GatewayHooks, identity: GatewayIdentity | null): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  if ((await hooks.access(identity)) === 'testing')
    return privateTestingError()
  return new Response(JSON.stringify(modelsPayload(readUpstreams(hooks.env))), {
    status: 200,
    headers: JSON_HEADERS
  })
}

export async function handleTranscriptions(
  hooks: GatewayHooks,
  identity: GatewayIdentity | null,
  request: Request
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(hooks.env).stt
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed speech model')

  const contentType = request.headers.get('content-type')
  const body = new Uint8Array(await request.arrayBuffer())
  let fields: Record<string, string[]> = {}
  let file: MultipartFile | undefined
  if (multipartBoundary(contentType)) {
    let parsed
    try {
      parsed = parseMultipart(body, contentType)
    } catch (err) {
      return gatewayError(400, 'bad_request', err instanceof Error ? err.message : 'Malformed multipart body')
    }
    fields = parsed.fields
    file = parsed.files.find((f) => f.name === 'file') ?? parsed.files[0]
  } else if (contentType && /^audio\//i.test(contentType) && body.length) {
    // curl-friendly form: the raw clip as the body, the parameters in the query string.
    const params = new URL(request.url).searchParams
    for (const [key, value] of params) (fields[key] ??= []).push(value)
    file = { name: 'file', filename: 'audio.wav', type: contentType, data: body }
  } else {
    return gatewayError(400, 'bad_request', 'Send multipart/form-data with a "file" part, or raw audio/* with parameters in the query string')
  }
  if (!file || !file.data.length) return gatewayError(400, 'bad_request', 'No audio file in the request')
  const requested = fields.model?.[0] ?? ''
  if (requested !== MURMUR_MODELS.stt) return modelNotFound(requested, MURMUR_MODELS.stt)
  // Absent (every client from before speed modes) means normal; a value that is neither mode is a
  // client bug worth hearing about rather than a silent normal.
  const speed = parseSpeedMode(fields[SPEED_FIELD]?.[0])
  if (!speed)
    return gatewayError(400, 'bad_request', `"${SPEED_FIELD}" must be one of: ${SPEED_MODES.join(', ')}`)

  const seconds = clipSeconds(file.data)
  const gate = await hooks.authorize({ identity,
    kind: 'stt',
    seconds
  })
  if (!gate.ok) return gateRefusal(hooks, gate, 'stt')

  // A stock phrase said to silence ("Thank you.") is dropped by segment, so the model is asked for
  // its verbose answer whenever the client wants JSON; the client still gets the shape it asked for.
  const asked = (fields.response_format?.[0] ?? 'json').trim().toLowerCase()
  let upstreamFormat = asked === 'json' ? 'verbose_json' : asked
  const buildForm = (upstreamModel: string): FormData => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([file.data as BlobPart], { type: file.type || 'audio/wav' }),
      file.filename || 'audio.wav'
    )
    form.append('model', upstreamModel)
    for (const [key, values] of Object.entries(fields)) {
      if (!STT_PASSTHROUGH_FIELDS.has(key) || key === 'response_format') continue
      // Clients speak to the Murmur alias and send the singular `language`; an OpenAI gpt-transcribe
      // upstream takes `languages[]` instead.
      const upstreamKey = key === 'language' ? sttLanguageField(upstreamModel) : key
      for (const value of values) form.append(upstreamKey, value)
    }
    form.append('response_format', upstreamFormat)
    return form
  }
  const headers: Record<string, string> = {}
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  // One budget for the request, clip length included: a second model call (below) gets what is left.
  const budgetMs = sttBudgetMs(readUpstreamBudgets(hooks.env).stt, seconds)
  const started = Date.now()
  const transcribe = (upstreamModel: string) =>
    callUpstream(
      `${upstream.baseUrl}/audio/transcriptions`,
      () => ({ method: 'POST', headers, body: buildForm(upstreamModel) }),
      Math.max(1_000, budgetMs - (Date.now() - started))
    )

  // The tier's model for normal; the fast model for fast, or the tier's model again when the
  // instance has none, and again when the provider does not know the fast model yet. Either way
  // the answer says which mode ran, so a client can tell the user that Fast is not there yet.
  const tier = parseTier(request.headers.get(TIER_HEADER))
  const choice = chooseSttModel(upstream, gate.plan, speed, tier)
  let ran: SpeedMode = choice.speed
  let fallback: SpeedFallback | undefined = choice.fallback
  let usedModel = choice.model
  // What the user is waiting for is hedged: a release that has not answered in time is asked of
  // the other speech model too, and the first usable answer wins.
  const normalStt = upstreamModelFor(upstream, gate.plan)
  // Longer clips legitimately take longer: the hedge waits 50 ms more per second of audio.
  const hedgeBase = hedgeAfterMs(hooks.env)
  const sttHedgeMs = hedgeBase === null ? null : hedgeBase + Math.round(seconds * 50)
  const altStt = tier === 'release' ? (choice.model === normalStt ? upstream.fastModel : normalStt) : undefined
  const first = await hedged(
    () => transcribe(choice.model),
    altStt && altStt !== choice.model ? () => transcribe(altStt) : null,
    sttHedgeMs,
    (a) => a.kind === 'response' && a.res.ok
  )
  let attempt = first.value
  if (first.winner === 'alternate') {
    usedModel = altStt!
    ran = altStt === upstream.fastModel ? 'fast' : 'normal'
  }
  if (first.hedged) console.log(`[gateway] stt hedged after ${sttHedgeMs} ms; ${first.winner} won`)
  if (tier === 'background') console.log(`[gateway] stt tier=background model=${usedModel}`)
  if (attempt.kind !== 'response')
    return providerFailure(hooks, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  if (
    !attempt.res.ok &&
    choice.normalModel !== undefined &&
    upstreamRejectedModel(attempt.res.status, attempt.text, choice.model)
  ) {
    console.warn(
      `[gateway] stt fast model "${choice.model}" rejected by the provider (HTTP ${attempt.res.status}); using the normal model`
    )
    ran = 'normal'
    fallback = 'model_not_found'
    usedModel = choice.normalModel
    attempt = await transcribe(choice.normalModel)
    if (attempt.kind !== 'response')
      return providerFailure(hooks, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  }
  // An upstream without verbose answers: ask again for exactly what the client asked for.
  if (
    !attempt.res.ok &&
    upstreamFormat !== asked &&
    attempt.res.status === 400 &&
    /response_format|verbose/i.test(attempt.text)
  ) {
    upstreamFormat = asked
    attempt = await transcribe(usedModel)
    if (attempt.kind !== 'response')
      return providerFailure(hooks, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  }
  const { res } = attempt
  let text = attempt.text
  if (!res.ok) return providerFailure(hooks, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  let json: { duration?: number; text?: unknown; segments?: unknown } | undefined
  try {
    json = JSON.parse(text) as { duration?: number; text?: unknown; segments?: unknown }
  } catch {
    json = undefined
  }
  const measured = measuredSeconds(file.data)
  let silenced = 0
  if (json && (upstreamFormat === 'verbose_json' || upstreamFormat === 'json')) {
    const clipSec = measured ?? (typeof json.duration === 'number' ? json.duration : seconds)
    const dropped = dropSilentSegments(json, clipSec)
    if (dropped) {
      silenced = (Array.isArray(json.segments) ? json.segments.length : 1) - (dropped.segments?.length ?? 0)
      json = { ...json, text: dropped.text, ...(dropped.segments ? { segments: dropped.segments } : {}) }
    }
    // The client asked for JSON: the plain answer, as before.
    const verbose = Array.isArray(json.segments)
    if (asked === 'json' && verbose) {
      const { segments: _segments, ...rest } = json
      void _segments
      // The plain answer, as before: the text (and whatever the upstream adds) without segments.
      text = JSON.stringify({
        text: typeof rest.text === 'string' ? rest.text : '',
        ...(typeof rest.duration === 'number' ? { duration: rest.duration } : {})
      })
    } else if (dropped) text = JSON.stringify(json)
  }
  const billed = measured ?? (typeof json?.duration === 'number' ? json.duration : seconds)
  const upstreamType = res.headers.get('content-type') ?? 'application/json'
  const words = transcriptWords(text, upstreamType)
  await hooks.record({ userId: gate.userId, identity, kind: 'stt', seconds: billed, words })
  await providerAnswered(hooks, 'stt', gate)
  const speedNote = fallback ? `${ran} (asked ${speed}, ${fallback})` : ran
  console.log(
    `[gateway] stt plan=${gate.plan} speed=${speedNote} seconds=${billed.toFixed(1)} words=${words}${silenced ? ` silenced=${silenced}` : ''} upstreamMs=${Date.now() - started}${attempt.attempts > 1 ? ` attempts=${attempt.attempts}` : ''}`
  )
  const responseHeaders: Record<string, string> = { 'content-type': upstreamType, [SPEED_HEADER]: ran }
  if (fallback) responseHeaders[SPEED_FALLBACK_HEADER] = fallback
  return new Response(text, { status: 200, headers: responseHeaders })
}

/** Chat parameters a client may set; anything else (tools, n, streaming) is dropped. */
const CHAT_PASSTHROUGH = [
  'messages',
  'temperature',
  'top_p',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'response_format'
] as const

export async function handleChatCompletions(
  hooks: GatewayHooks,
  identity: GatewayIdentity | null,
  request: Request
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(hooks.env).llm
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed formatting model')

  let input: Record<string, unknown>
  try {
    input = (await request.json()) as Record<string, unknown>
  } catch {
    return gatewayError(400, 'bad_request', 'Body must be JSON')
  }
  if (!input || typeof input !== 'object') return gatewayError(400, 'bad_request', 'Body must be a JSON object')
  const requested = typeof input.model === 'string' ? input.model : ''
  if (requested !== MURMUR_MODELS.llm) return modelNotFound(requested, MURMUR_MODELS.llm)
  if (!Array.isArray(input.messages) || input.messages.length === 0)
    return gatewayError(400, 'bad_request', '"messages" must be a non-empty array')

  const gate = await hooks.authorize({ identity, kind: 'llm' })
  if (!gate.ok) return gateRefusal(hooks, gate, 'llm')

  // The same per-user caps as /v1/format; a raw completion has no rule-based answer, so over the
  // cap the client is told to wait.
  const admitted = admitFormat(gate.userId)
  if (!admitted.ok) {
    console.warn(`[gateway] llm over the per-user ${admitted.reason} cap; refused`)
    return gatewayError(429, 'rate_limited', 'Too many formatting requests at once; try again in a moment', {
      'retry-after': '5'
    })
  }
  try {
    return await chatCompletionOnce(hooks, upstream, gate, identity, input, parseTier(request.headers.get(TIER_HEADER)))
  } finally {
    releaseFormat(gate.userId)
  }
}

async function chatCompletionOnce(
  hooks: GatewayHooks,
  upstream: Upstream,
  gate: Allowed,
  identity: GatewayIdentity,
  input: Record<string, unknown>,
  chatTier: Tier
): Promise<Response> {
  const outbound: Record<string, unknown> = {
    model: chooseLlmModel(upstream, gate.plan, chatTier, 'normal').model,
    stream: false
  }
  for (const key of CHAT_PASSTHROUGH) if (input[key] !== undefined) outbound[key] = input[key]
  const requestedMax = typeof input.max_tokens === 'number' ? input.max_tokens : 1024
  outbound.max_tokens = Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(requestedMax)))
  const requestBody = JSON.stringify(outbound)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  const started = Date.now()
  const outcome = await callUpstream(
    `${upstream.baseUrl}/chat/completions`,
    () => ({ method: 'POST', headers, body: requestBody }),
    readUpstreamBudgets(hooks.env).chatMs
  )
  if (outcome.kind !== 'response' || !outcome.res.ok)
    return providerFailure(hooks, 'llm', describeUpstreamOutcome('llm', outcome), Date.now() - started)
  const { text } = outcome
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return gatewayError(502, 'upstream_error', 'The model provider returned a malformed answer')
  }
  const tokens = tokensUsed(
    json.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined,
    requestBody.length,
    text.length
  )
  await hooks.record({ userId: gate.userId, identity, kind: 'llm', tokens })
  await providerAnswered(hooks, 'llm', gate)
  console.log(`[gateway] llm plan=${gate.plan} tokens=${tokens} upstreamMs=${Date.now() - started}`)
  // The upstream model is the instance's business; clients asked for the Murmur alias.
  return new Response(JSON.stringify({ ...json, model: MURMUR_MODELS.llm }), { status: 200, headers: JSON_HEADERS })
}

/**
 * Murmur's formatting endpoint: the transcript and the dictation's context in, the text to insert
 * out. The text engine (packages/text-engine) builds the prompt, verifies the answer, retries once
 * in strict mode and falls back to its rule-based cleanup; every model round trip is billed.
 *
 *   POST /v1/format
 *   { transcript, context: { category, tone, app?, language?, precedingText?, instructions?,
 *                           dictionary?: [{ word, aliases }], keepVerbatim?: [] } }
 *   -> { text, pressEnter, status, modelText?, llmMs, stages, model }
 *
 * A provider that is down never fails a dictation here: the engine's rule-based text goes out
 * with `status.outcome = "failed"` and the `provider_unavailable` sentence as its detail, and when
 * the provider's breaker is open the model is not asked at all.
 */
export async function handleFormat(
  hooks: GatewayHooks,
  identity: GatewayIdentity | null,
  request: Request
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(hooks.env).llm
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed formatting model')

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return gatewayError(400, 'bad_request', 'Body must be JSON')
  }
  const parsed = parseFormatRequest(input)
  if (!parsed.ok) return gatewayError(400, 'bad_request', parsed.message)

  const gate = await hooks.authorize({ identity,
    kind: 'llm',
    degradable: true
  })
  if (!gate.ok) return gateRefusal(hooks, gate, 'llm')

  // Identical requests from one user already in flight share one answer, so a client that
  // re-sends cannot multiply the provider calls.
  const tier = parseTier(request.headers.get(TIER_HEADER))
  const speed: SpeedMode = (request.headers.get(LLM_SPEED_HEADER) ?? '').trim().toLowerCase() === 'fast' ? 'fast' : 'normal'
  const key = `${gate.userId}\u0000${tier}\u0000${speed}\u0000${JSON.stringify(parsed.request)}`
  const { value: body, shared } = await dedupeFormat(key, () =>
    formatOnce(hooks, upstream, gate, identity, parsed.request, tier, speed)
  )
  if (shared) console.log('[gateway] format deduped (identical request in flight)')
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
}

async function formatOnce(
  hooks: GatewayHooks,
  upstream: Upstream,
  gate: Allowed,
  identity: GatewayIdentity,
  request: Extract<ReturnType<typeof parseFormatRequest>, { ok: true }>['request'],
  tier: Tier,
  speed: SpeedMode
): Promise<Record<string, unknown>> {
  // Background pieces use the background pool; a release uses the fast or normal model, hedged
  // with the other one when it is slow.
  const { model, alternate } = chooseLlmModel(upstream, gate.plan, tier, speed)
  const hedgeMs = hedgeAfterMs(hooks.env)
  const budgetMs = readUpstreamBudgets(hooks.env).formatMs
  let tokens = 0
  /** Model round trips the provider answered; only those are usage. */
  let answered = 0
  // Assigned inside `complete`; typed through the assertion so the check below sees the union.
  let unavailable = null as UpstreamFailure | null
  const started = Date.now()
  const complete = async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> => {
    // Once the provider said it is busy or down, the rest of this request (other pieces, the
    // strict retry) does not ask it again.
    if (unavailable) throw new UpstreamError(unavailable.message, unavailable.status, unavailable.code)
    const { value: answer, hedged: didHedge, winner } = await hedged(
      () => upstreamChat(upstream, model, messages, opts, budgetMs),
      alternate ? () => upstreamChat(upstream, alternate, messages, opts, budgetMs) : null,
      hedgeMs,
      (a) => a.ok
    )
    if (didHedge) console.log(`[gateway] format hedged after ${hedgeMs} ms; ${winner} won`)
    if (!answer.ok) {
      if (answer.failure.unavailable) unavailable = answer.failure
      else console.warn(`[gateway] llm upstream -> ${answer.failure.status} ${answer.failure.code}`)
      throw new UpstreamError(answer.failure.message, answer.failure.status, answer.failure.code)
    }
    answered++
    tokens += answer.tokens
    return answer.result
  }
  // The breaker is open: the engine runs without the model and the answer says why, at once.
  const breakerOpen = async (): Promise<ChatResult> => {
    throw new UpstreamError(unavailableMessage('llm'), 503, 'provider_unavailable')
  }
  // Past Pro's soft fair-use cap the engine runs without a model: rule-based text, never an error.
  // Per-user caps: over them the engine runs without the model (rule-based text, at once).
  const wantsModel = !gate.paused && gate.provider.openForSec === null
  const admitted = wantsModel ? admitFormat(gate.userId) : null
  if (admitted && !admitted.ok)
    console.warn(`[gateway] format over the per-user ${admitted.reason} cap; rule-based text sent`)
  let formatted: Awaited<ReturnType<typeof formatTranscript>>
  try {
    formatted = await formatTranscript(
      { transcript: request.transcript, mode: 'smart', context: request.context },
      gate.paused ? null : !wantsModel ? breakerOpen : admitted?.ok ? complete : null
    )
  } finally {
    if (admitted?.ok) releaseFormat(gate.userId)
  }
  if (admitted && !admitted.ok)
    formatted = { ...formatted, status: { ...formatted.status, detail: 'rate_limited' } }
  if (answered > 0) await hooks.record({ userId: gate.userId, identity, kind: 'llm', tokens })
  if (unavailable?.unavailable) {
    const state = await hooks.providerFailed('llm', unavailable.unavailable.reason)
    console.warn(
      `[gateway] llm provider unavailable (${unavailable.unavailable.reason}${unavailable.detail ? `: ${unavailable.detail.slice(0, 120)}` : ''}) failures=${state.failures}${state.openForSec !== null ? ` breakerOpenSec=${state.openForSec}` : ''}; rule-based text sent`
    )
  } else if (answered > 0) {
    await providerAnswered(hooks, 'llm', gate)
  }
  console.log(
    `[gateway] format plan=${gate.plan} outcome=${formatted.status.outcome} attempts=${formatted.status.attempts} tokens=${tokens} paused=${gate.paused !== null} breakerOpen=${gate.provider.openForSec !== null} ms=${Date.now() - started}`
  )
  return gate.paused
    ? {
        ...formatted,
        status: { ...formatted.status, detail: 'fair use' },
        limit: limitDetail(gate.paused, gate.plan, gate.planState, hooks.env),
        model: MURMUR_MODELS.llm
      }
    : { ...formatted, model: MURMUR_MODELS.llm }
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
  }
}

/**
 * One chat completion against the instance's model within `budgetMs`, or the failure the engine
 * will report (through `UpstreamError`) and the gateway will count against the provider.
 */
async function upstreamChat(
  upstream: Upstream,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  budgetMs: number
): Promise<{ ok: true; result: ChatResult; tokens: number } | { ok: false; failure: UpstreamFailure }> {
  const bodyWith = (reasoning: boolean): string =>
    JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(opts.maxTokens ?? 1024))),
      ...(reasoning && upstream.reasoningEffort ? { reasoning_effort: upstream.reasoningEffort } : {}),
      stream: false
    })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  const started = Date.now()
  let outcome = await callUpstream(
    `${upstream.baseUrl}/chat/completions`,
    () => ({ method: 'POST', headers, body: bodyWith(true) }),
    budgetMs
  )
  // An upstream that does not know reasoning_effort gets the call again without it.
  if (
    upstream.reasoningEffort &&
    outcome.kind === 'response' &&
    outcome.res.status === 400 &&
    /reasoning/i.test(outcome.text)
  ) {
    outcome = await callUpstream(
      `${upstream.baseUrl}/chat/completions`,
      () => ({ method: 'POST', headers, body: bodyWith(false) }),
      Math.max(1000, budgetMs - (Date.now() - started))
    )
  }
  if (outcome.kind !== 'response' || !outcome.res.ok)
    return { ok: false, failure: describeUpstreamOutcome('llm', outcome) }
  const text = outcome.text
  let json: {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; finish_reason?: string }>
    usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    json = JSON.parse(text)
  } catch {
    return {
      ok: false,
      failure: { status: 502, code: 'upstream_error', message: 'The model provider returned a malformed answer' }
    }
  }
  const choice = json.choices?.[0]
  const content = choice?.message?.content
  const answer = Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : (content ?? '')
  return {
    ok: true,
    result: { text: answer, finishReason: choice?.finish_reason, model, usage: json.usage },
    tokens: tokensUsed(json.usage, bodyWith(false).length, text.length)
  }
}
