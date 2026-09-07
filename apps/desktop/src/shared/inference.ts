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
  'upstream_error',
  'upstream_auth',
  'upstream_busy',
  // Raised on the device before a request is made.
  'murmur_signed_out',
  'murmur_no_token'
])
