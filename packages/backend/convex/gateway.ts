import type { FunctionReturnType } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction, type ActionCtx } from './_generated/server'
import { formatTranscript } from '../../text-engine/src/format'
import { sttLanguageField } from '../../text-engine/src/languages'
import type { ChatMessage, ChatOptions, ChatResult } from '../../text-engine/src/types'
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
  describeUpstreamOutcome,
  gatewayError,
  identityOf,
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
  wavInfo,
  type GatewayIdentity,
  type InferenceKind,
  type MultipartFile,
  type SpeedFallback,
  type SpeedMode,
  type Upstream,
  type UpstreamFailure
} from './lib/inference'
import { callUpstream, readUpstreamBudgets, sttBudgetMs } from './lib/upstream'

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
 * Mounted in convex/http.ts at /v1/models, /v1/audio/transcriptions and /v1/chat/completions.
 */

const JSON_HEADERS = { 'content-type': 'application/json' }

type Gate = FunctionReturnType<typeof internal.inference.authorize>
type Allowed = Extract<Gate, { ok: true }>

/** The `authorize` arguments that name the caller. */
function callerArgs(identity: GatewayIdentity): {
  clerkId: string
  email?: string
  emailVerified?: boolean
} {
  return { clerkId: identity.subject, email: identity.email, emailVerified: identity.emailVerified }
}

/** The answer for a request `authorize` turned down. */
function gateRefusal(gate: Exclude<Gate, { ok: true }>, kind: InferenceKind): Response {
  if (gate.denied !== undefined) return privateTestingError()
  if (gate.unavailable !== undefined) {
    console.warn(`[gateway] ${kind} provider breaker open; refused without asking the provider`)
    return upstreamFailureResponse(providerDownFailure(kind, gate.unavailable.retryAfterSec))
  }
  return limitError(gate.refusal, gate.plan, gate.planState, process.env)
}

/**
 * A provider call that did not come back usable: a `provider_unavailable` counts against the
 * provider's breaker and carries the cooldown it may have opened as its `Retry-After`; every
 * other failure is reported as it is. Nothing is billed for any of them.
 */
async function providerFailure(
  ctx: ActionCtx,
  kind: InferenceKind,
  failure: UpstreamFailure,
  upstreamMs: number
): Promise<Response> {
  if (!failure.unavailable) {
    console.warn(`[gateway] ${kind} upstream -> ${failure.status} ${failure.code} upstreamMs=${upstreamMs}`)
    return upstreamFailureResponse(failure)
  }
  const state = await ctx.runMutation(internal.inference.providerFailed, {
    kind,
    reason: failure.unavailable.reason
  })
  console.warn(
    `[gateway] ${kind} provider unavailable (${failure.unavailable.reason}${failure.detail ? `: ${failure.detail.slice(0, 120)}` : ''}) upstreamMs=${upstreamMs} failures=${state.failures}${state.openForSec !== null ? ` breakerOpenSec=${state.openForSec}` : ''}`
  )
  return upstreamFailureResponse(failure, state.openForSec ?? undefined)
}

/** The provider answered: forget the failures counted against it, if there were any. */
async function providerAnswered(ctx: ActionCtx, kind: InferenceKind, gate: Allowed): Promise<void> {
  if (gate.provider.failures > 0) await ctx.runMutation(internal.inference.providerRecovered, { kind })
}

function modelNotFound(requested: string, available: string): Response {
  return gatewayError(
    404,
    'model_not_found',
    `Unknown model "${requested}". Available models: ${available}`
  )
}

export const models = httpAction(async (ctx) => {
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  if ((await ctx.runQuery(internal.inference.access, callerArgs(identity))) === 'testing')
    return privateTestingError()
  return new Response(JSON.stringify(modelsPayload(readUpstreams(process.env))), {
    status: 200,
    headers: JSON_HEADERS
  })
})

export const transcriptions = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).stt
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
  const gate = await ctx.runMutation(internal.inference.authorize, {
    ...callerArgs(identity),
    kind: 'stt',
    seconds
  })
  if (!gate.ok) return gateRefusal(gate, 'stt')

  const buildForm = (upstreamModel: string): FormData => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([file.data as BlobPart], { type: file.type || 'audio/wav' }),
      file.filename || 'audio.wav'
    )
    form.append('model', upstreamModel)
    for (const [key, values] of Object.entries(fields)) {
      if (!STT_PASSTHROUGH_FIELDS.has(key)) continue
      // Clients speak to the Murmur alias and send the singular `language`; an OpenAI gpt-transcribe
      // upstream takes `languages[]` instead.
      const upstreamKey = key === 'language' ? sttLanguageField(upstreamModel) : key
      for (const value of values) form.append(upstreamKey, value)
    }
    return form
  }
  const headers: Record<string, string> = {}
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  // One budget for the request, clip length included: a second model call (below) gets what is left.
  const budgetMs = sttBudgetMs(readUpstreamBudgets(process.env).stt, seconds)
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
  const choice = chooseSttModel(upstream, gate.plan, speed)
  let ran: SpeedMode = choice.speed
  let fallback: SpeedFallback | undefined = choice.fallback
  let attempt = await transcribe(choice.model)
  if (attempt.kind !== 'response')
    return providerFailure(ctx, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
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
    attempt = await transcribe(choice.normalModel)
    if (attempt.kind !== 'response')
      return providerFailure(ctx, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  }
  const { res, text } = attempt
  if (!res.ok) return providerFailure(ctx, 'stt', describeUpstreamOutcome('stt', attempt), Date.now() - started)
  let json: { duration?: number } | undefined
  try {
    json = JSON.parse(text) as { duration?: number }
  } catch {
    json = undefined
  }
  const measured = wavInfo(file.data)?.durationSec
  const billed = measured ?? (typeof json?.duration === 'number' ? json.duration : seconds)
  const upstreamType = res.headers.get('content-type') ?? 'application/json'
  const words = transcriptWords(text, upstreamType)
  await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'stt', seconds: billed, words })
  await providerAnswered(ctx, 'stt', gate)
  const speedNote = fallback ? `${ran} (asked ${speed}, ${fallback})` : ran
  console.log(
    `[gateway] stt plan=${gate.plan} speed=${speedNote} seconds=${billed.toFixed(1)} words=${words} upstreamMs=${Date.now() - started}${attempt.attempts > 1 ? ` attempts=${attempt.attempts}` : ''}`
  )
  const responseHeaders: Record<string, string> = { 'content-type': upstreamType, [SPEED_HEADER]: ran }
  if (fallback) responseHeaders[SPEED_FALLBACK_HEADER] = fallback
  return new Response(text, { status: 200, headers: responseHeaders })
})

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

export const chatCompletions = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).llm
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

  const gate = await ctx.runMutation(internal.inference.authorize, { ...callerArgs(identity), kind: 'llm' })
  if (!gate.ok) return gateRefusal(gate, 'llm')

  const outbound: Record<string, unknown> = { model: upstreamModelFor(upstream, gate.plan), stream: false }
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
    readUpstreamBudgets(process.env).chatMs
  )
  if (outcome.kind !== 'response' || !outcome.res.ok)
    return providerFailure(ctx, 'llm', describeUpstreamOutcome('llm', outcome), Date.now() - started)
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
  await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'llm', tokens })
  await providerAnswered(ctx, 'llm', gate)
  console.log(`[gateway] llm plan=${gate.plan} tokens=${tokens} upstreamMs=${Date.now() - started}`)
  // The upstream model is the instance's business; clients asked for the Murmur alias.
  return new Response(JSON.stringify({ ...json, model: MURMUR_MODELS.llm }), { status: 200, headers: JSON_HEADERS })
})

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
export const format = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).llm
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

  const gate = await ctx.runMutation(internal.inference.authorize, {
    ...callerArgs(identity),
    kind: 'llm',
    degradable: true
  })
  if (!gate.ok) return gateRefusal(gate, 'llm')

  const model = upstreamModelFor(upstream, gate.plan)
  const budgetMs = readUpstreamBudgets(process.env).formatMs
  let tokens = 0
  /** Model round trips the provider answered; only those are usage. */
  let answered = 0
  // Assigned inside `complete`; typed through the assertion so the check below sees the union.
  let unavailable = null as UpstreamFailure | null
  const started = Date.now()
  const complete = async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> => {
    const answer = await upstreamChat(upstream, model, messages, opts, budgetMs)
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
  const formatted = await formatTranscript(
    { transcript: parsed.request.transcript, mode: 'smart', context: parsed.request.context },
    gate.paused ? null : gate.provider.openForSec !== null ? breakerOpen : complete
  )
  if (answered > 0) await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'llm', tokens })
  if (unavailable?.unavailable) {
    const state = await ctx.runMutation(internal.inference.providerFailed, {
      kind: 'llm',
      reason: unavailable.unavailable.reason
    })
    console.warn(
      `[gateway] llm provider unavailable (${unavailable.unavailable.reason}${unavailable.detail ? `: ${unavailable.detail.slice(0, 120)}` : ''}) failures=${state.failures}${state.openForSec !== null ? ` breakerOpenSec=${state.openForSec}` : ''}; rule-based text sent`
    )
  } else if (answered > 0) {
    await providerAnswered(ctx, 'llm', gate)
  }
  console.log(
    `[gateway] format plan=${gate.plan} outcome=${formatted.status.outcome} attempts=${formatted.status.attempts} tokens=${tokens} paused=${gate.paused !== null} breakerOpen=${gate.provider.openForSec !== null} ms=${Date.now() - started}`
  )
  const body = gate.paused
    ? {
        ...formatted,
        status: { ...formatted.status, detail: 'fair use' },
        limit: limitDetail(gate.paused, gate.plan, gate.planState, process.env),
        model: MURMUR_MODELS.llm
      }
    : { ...formatted, model: MURMUR_MODELS.llm }
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
})

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
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(opts.maxTokens ?? 1024))),
    stream: false
  })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  const outcome = await callUpstream(
    `${upstream.baseUrl}/chat/completions`,
    () => ({ method: 'POST', headers, body }),
    budgetMs
  )
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
    tokens: tokensUsed(json.usage, body.length, text.length)
  }
}
