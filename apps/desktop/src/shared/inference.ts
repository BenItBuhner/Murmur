import type { FormattingMode, Settings } from './settings'

/**
 * Where speech-to-text and smart formatting run.
 *
 * - `murmur`: the models the Murmur instance provides for signed-in accounts, reached through the
 *   deployment's OpenAI-compatible gateway with the Clerk session as the bearer token. Only exists
 *   in builds that talk to a cloud instance; the default there.
 * - `custom`: a provider the user configured on this device (their own OpenAI/Groq/Deepgram key, a
 *   local whisper server, ...). The only option in local builds, where nothing is ever sent to a
 *   Murmur server.
 */
export type InferenceSource = 'murmur' | 'custom'

/**
 * Model ids the gateway accepts. They must match MURMUR_MODELS in
 * packages/backend/convex/lib/inference.ts; the instance maps them to its configured providers.
 */
export const MURMUR_STT_MODEL = 'murmur-transcribe'
export const MURMUR_LLM_MODEL = 'murmur-format'

/** `provider` recorded in history entries for dictations transcribed by the Murmur instance. */
export const MURMUR_PROVIDER = 'murmur'

/**
 * How quickly the Murmur speech model should answer: `normal` is the instance's model as before,
 * `fast` a quicker model when the instance offers one (`MURMUR_INFERENCE_STT_FAST_MODEL`). Sent
 * with every Murmur transcription as the `speed` form field; the instance answers with the mode
 * that actually ran, so a request for Fast on an instance without it still goes through, on
 * Normal, and the app can say so. Must match SPEED_MODES in packages/backend/convex/lib/inference.ts.
 */
export const SPEED_MODES = ['normal', 'fast'] as const
export type SpeedMode = (typeof SPEED_MODES)[number]

/** The `/v1/audio/transcriptions` form field that carries the mode. */
export const MURMUR_SPEED_FIELD = 'speed'
/** Response header: the mode that transcribed the clip. */
export const MURMUR_SPEED_HEADER = 'x-murmur-speed'
/** Response header, only when the requested mode could not be honoured: why Normal ran instead. */
export const MURMUR_SPEED_FALLBACK_HEADER = 'x-murmur-speed-fallback'

/**
 * Why a Fast request ran on Normal: the instance has no fast model (`not_configured`), or its
 * provider does not know the fast model yet (`model_not_found`).
 */
export type SpeedFallback = 'not_configured' | 'model_not_found'

/** What the instance reported about the speed of one transcription. */
export interface SpeedOutcome {
  requested: SpeedMode
  /** The mode that transcribed the clip. */
  used: SpeedMode
  fallback?: SpeedFallback
}

function isSpeedMode(value: string | null | undefined): value is SpeedMode {
  return (SPEED_MODES as readonly string[]).includes(value ?? '')
}

/**
 * The speed outcome a transcription response carries, or undefined for a server that says
 * nothing about speed (the user's own provider, or an instance from before speed modes).
 */
export function readSpeedOutcome(
  headers: { get(name: string): string | null },
  requested: SpeedMode | undefined
): SpeedOutcome | undefined {
  const used = headers.get(MURMUR_SPEED_HEADER)?.trim().toLowerCase()
  if (!isSpeedMode(used)) return undefined
  const fallback = headers.get(MURMUR_SPEED_FALLBACK_HEADER)?.trim().toLowerCase()
  return {
    requested: requested ?? 'normal',
    used,
    fallback: fallback === 'not_configured' || fallback === 'model_not_found' ? fallback : undefined
  }
}

/** The one sentence the apps say when Fast was asked for and Normal answered. */
export const FAST_UNAVAILABLE_NOTE = "Fast isn't available yet, used Normal"

/** The Speed setting's explanation, the same words on desktop and Android. */
export const SPEED_SETTING_DESCRIPTION =
  "Normal: today's speech model with AI formatting. Fast: faster speech model and no AI formatting, just the instant Light cleanup. A per-app rule on the Style page can pick a speed for one app."

/** Under the Speed setting when the instance reports no fast model. */
export const FAST_UNAVAILABLE_SETTING_NOTE =
  "The faster speech model isn't available on this server yet; Fast dictations use the Normal model until it is, still without AI formatting."

/**
 * Why the formatting model was not asked for a Fast dictation (`LlmStatus.detail` with outcome
 * `skipped`), so History can say the AI step was skipped because of Fast.
 */
export const FAST_SKIP_DETAIL = 'fast speed'

/**
 * The speed a dictation runs at: the matching per-app rule's speed when it set one, otherwise the
 * device's Speed setting. Decides the `speed` sent to Murmur's speech model and, with `fast`,
 * that the formatting model is not asked (the rule-based Light cleanup runs instead), on the
 * managed and the user's own formatting path alike.
 */
export function effectiveSpeed(
  setting: SpeedMode,
  rule: { speed?: SpeedMode } | undefined
): SpeedMode {
  return rule?.speed ?? setting
}

/**
 * The formatting mode a dictation actually runs with: Fast never asks the model, so `smart`
 * becomes the rule-based `light`; `off` stays off, and Normal keeps the mode as chosen.
 */
export function formattingModeAt(mode: FormattingMode, speed: SpeedMode): FormattingMode {
  return speed === 'fast' && mode === 'smart' ? 'light' : mode
}

/** How a mode is named in the UI. */
export function speedLabel(mode: SpeedMode): string {
  return mode === 'fast' ? 'Fast' : 'Normal'
}

/** History's one-line account of the speed a dictation ran at; empty for a mode never reported. */
export function speedSummary(outcome: SpeedOutcome | undefined): string {
  if (!outcome) return ''
  if (outcome.requested === 'fast' && outcome.used !== 'fast') return FAST_UNAVAILABLE_NOTE
  return speedLabel(outcome.used)
}

export interface InferenceRouting {
  stt: InferenceSource
  llm: InferenceSource
}

export interface InferenceContext {
  /** The build talks to a cloud instance (account mode is not `off`). */
  cloudEnabled: boolean
  /**
   * Whether the instance offers managed models, once known. Unknown (undefined) is treated as
   * available so a cloud build routes to Murmur before the first status arrives.
   */
  managedAvailable?: boolean
}

/**
 * Effective sources for the current settings. Local builds always resolve to `custom`, whatever
 * the stored value says (a settings file copied from a cloud install must not turn a local build
 * into a cloud client). In cloud builds "same server as speech-to-text" follows wherever the
 * speech model points, so a Murmur speech model means a Murmur formatting model too.
 */
export function resolveInferenceSources(
  settings: Pick<Settings, 'stt' | 'formatting'>,
  ctx: InferenceContext
): InferenceRouting {
  if (!ctx.cloudEnabled || ctx.managedAvailable === false) return { stt: 'custom', llm: 'custom' }
  const stt = settings.stt.source
  const llm = settings.formatting.llm
  return {
    stt,
    llm: llm.source === 'murmur' ? 'murmur' : llm.sameAsStt ? stt : 'custom'
  }
}

/** Base URL of the instance's OpenAI-compatible gateway, given its HTTP actions origin. */
export function murmurGatewayUrl(convexSiteUrl: string): string {
  return `${convexSiteUrl.trim().replace(/\/+$/, '')}/v1`
}

/** Whether a speech model is ready to use for the resolved source. */
export function sttConfigured(
  settings: Pick<Settings, 'stt'>,
  routing: Pick<InferenceRouting, 'stt'>,
  signedIn: boolean
): boolean {
  if (routing.stt === 'murmur') return signedIn
  return !!settings.stt.baseUrl && !!settings.stt.model
}

/** Whether a formatting model is ready to use for the resolved source. */
export function llmConfigured(
  settings: Pick<Settings, 'stt' | 'formatting'>,
  routing: InferenceRouting,
  signedIn: boolean
): boolean {
  if (routing.llm === 'murmur') return signedIn
  const llm = settings.formatting.llm
  if (!llm.model) return false
  return llm.sameAsStt ? !!settings.stt.baseUrl : !!llm.baseUrl
}

/** Error codes the gateway returns in `error.code`; their messages are shown to the user verbatim. */
export const MURMUR_ERROR_CODES = new Set([
  'unauthorized',
  'not_configured',
  'model_not_found',
  'clip_too_long',
  'quota_exceeded',
  'rate_limited',
  // Private testing: the instance's models are not open to this account (a zero allowance).
  'private_testing',
  'upstream_error',
  'upstream_auth',
  'upstream_busy',
  // The provider behind the instance is down or not answering (see `ServiceNotice`).
  'provider_unavailable',
  // Raised on the device before a request is made.
  'murmur_signed_out',
  'murmur_no_token'
])

/**
 * `error.code` of a gateway answer (HTTP 503) that says the provider behind Murmur's models is
 * down, unreachable or out of time: not the account, not the device, nothing the user did. The
 * gateway cuts such a request off within its own budget, so the app hears this long before its
 * own request timeout and can say so calmly. Must match `GatewayErrorCode` in
 * packages/backend/convex/lib/inference.ts.
 */
export const PROVIDER_UNAVAILABLE_CODE = 'provider_unavailable'

/** The managed model a `provider_unavailable` answer is about. */
export type MurmurService = 'speech' | 'formatting'

/** The structured part of a `provider_unavailable` answer (`error.service`, `error.reason`, …). */
export interface ServiceNotice {
  service: MurmurService
  /** `timeout`, `unreachable` or `unavailable`; `unknown` from an instance that did not say. */
  reason: string
  /** Seconds the gateway suggests waiting before asking again; null when it did not say. */
  retryAfterSec: number | null
  /** The gateway's own sentence. */
  message: string
}

/**
 * Read a service notice out of a gateway `error` object. Null for every other code, and for a body
 * that only looks like one. `fallbackService` names the model the request was for, for an instance
 * that sends the code without the field.
 */
export function parseServiceNotice(
  source: unknown,
  message?: string,
  fallbackService: MurmurService = 'speech'
): ServiceNotice | null {
  if (!source || typeof source !== 'object') return null
  const o = source as Record<string, unknown>
  if (o.code !== PROVIDER_UNAVAILABLE_CODE) return null
  const service: MurmurService =
    o.service === 'speech' || o.service === 'formatting' ? o.service : fallbackService
  const retryAfter = o.retryAfterSec
  return {
    service,
    reason: typeof o.reason === 'string' && o.reason ? o.reason : 'unknown',
    retryAfterSec:
      typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : null,
    message: message ?? (typeof o.message === 'string' ? o.message : '')
  }
}

/** The two calm lines the pill shows for a service that is unavailable, the same on both apps. */
export function describeServiceNotice(notice: ServiceNotice): { title: string; detail: string } {
  return {
    title: `Murmur's ${notice.service} service is unavailable right now`,
    detail:
      notice.service === 'speech'
        ? 'Not your connection or your mic. Your recording is kept — try again in a moment.'
        : 'Not your connection. Nothing was changed — try again in a moment.'
  }
}
