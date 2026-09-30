import type { Settings } from './settings'

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
  "Normal is today's model. Fast answers sooner on a quicker model when this Murmur server offers one."

/** Under the Speed setting when the instance reports no fast model. */
export const FAST_UNAVAILABLE_SETTING_NOTE =
  "Fast isn't available on this server yet; dictations use Normal until it is."

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
  // Raised on the device before a request is made.
  'murmur_signed_out',
  'murmur_no_token'
])
