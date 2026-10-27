import { MURMUR_SPEED_FIELD, readSpeedOutcome } from '@shared/inference'
import { sttLanguageField } from '@shared/languages'
import {
  SttError,
  combineSignals,
  errorFromResponse,
  normalizeBaseUrl,
  rankSpeechModels,
  toSttError,
  MURMUR_TIER_HEADER,
  type SttConfig,
  type SttProvider,
  type TimedSpan,
  type TranscribeInput,
  type TranscribeOutput
} from './types'

interface VerboseJson {
  text?: string
  language?: string
  /** What gpt-transcribe detected, most likely first; empty when it could not tell. */
  languages?: Array<{ code?: string }>
  duration?: number
  segments?: Array<{ start?: number; end?: number; no_speech_prob?: number; avg_logprob?: number }>
  words?: Array<{ word?: string; start?: number; end?: number }>
}

/** The language a response reports: whisper's `language`, or the first of gpt-transcribe's list. */
export function languageFromResponse(json: VerboseJson | undefined): string | undefined {
  if (!json) return undefined
  if (typeof json.language === 'string' && json.language) return json.language
  const code = json.languages?.[0]?.code
  return typeof code === 'string' && code ? code : undefined
}

/** Servers that rejected verbose_json once are remembered so we do not pay a failed round-trip again. */
const verboseUnsupported = new Set<string>()
/** Servers that rejected word-level timestamps; they still get verbose_json for segment timings. */
const wordTimestampsUnsupported = new Set<string>()

/**
 * Timed spans from a verbose response. Word timings win: they come from alignment and stay right
 * even when the decoder stopped early, whereas a segment that was never closed with a timestamp
 * is reported as running to the end of its 30-second window.
 */
export function spansFromVerbose(json: VerboseJson | undefined): TimedSpan[] | undefined {
  if (!json) return undefined
  const valid = (s: { start?: number; end?: number }): s is TimedSpan =>
    typeof s.start === 'number' &&
    typeof s.end === 'number' &&
    Number.isFinite(s.start) &&
    Number.isFinite(s.end) &&
    s.end >= 0
  const words = (json.words ?? []).filter(valid).map((w) => ({ start: w.start, end: w.end }))
  if (words.length) return words
  const segments = (json.segments ?? []).filter(valid).map((s) => ({ start: s.start, end: s.end }))
  return segments.length ? segments : undefined
}

/** Turns a 16 kHz WAV into a smaller upload (Ogg Opus); null means send the WAV as it is. */
export type CompactUploadEncoder = (wav: Uint8Array) => Uint8Array | null
let compactEncoder: CompactUploadEncoder | null = null
/** Gateways that refused a compact upload once; they get WAV from then on. */
const compactUnsupported = new Set<string>()

/**
 * Register the Opus encoder (main process only). Used for Murmur's gateway alone: the user's own
 * provider always gets the WAV it got before.
 */
export function setCompactUploadEncoder(encoder: CompactUploadEncoder | null): void {
  compactEncoder = encoder
}

/**
 * Works with OpenAI, Groq, Mistral, whisper.cpp `server`, faster-whisper-server/Speaches,
 * LocalAI, and any proxy that speaks `POST /audio/transcriptions`.
 */
export class OpenAiCompatibleStt implements SttProvider {
  readonly kind = 'openai-compatible' as const

  async transcribe(input: TranscribeInput, cfg: SttConfig): Promise<TranscribeOutput> {
    const base = normalizeBaseUrl(cfg.baseUrl)
    if (!base) throw new SttError('No STT base URL configured', 'bad-request')
    if (!cfg.model) throw new SttError('No STT model selected', 'model')
    const url = `${base}/audio/transcriptions`
    const wantVerbose = !verboseUnsupported.has(base)
    const started = performance.now()
    let compact: Uint8Array | null = null
    if (cfg.speed && compactEncoder && !compactUnsupported.has(base)) {
      try {
        compact = compactEncoder(input.wav)
      } catch {
        compact = null
      }
    }

    const attempt = async (verbose: boolean, wordTimestamps: boolean): Promise<Response> => {
      const form = new FormData()
      if (compact)
        form.append('file', new Blob([compact as BlobPart], { type: 'audio/ogg' }), 'audio.ogg')
      else
        form.append('file', new Blob([input.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', cfg.model)
      form.append('response_format', verbose ? 'verbose_json' : 'json')
      form.append('temperature', '0')
      if (verbose && wordTimestamps) {
        form.append('timestamp_granularities[]', 'word')
        form.append('timestamp_granularities[]', 'segment')
      }
      if (cfg.language && cfg.language !== 'auto')
        form.append(sttLanguageField(cfg.model), cfg.language)
      if (input.prompt) form.append('prompt', input.prompt)
      // Murmur's gateway only; the router never sets it for the user's own provider.
      if (cfg.speed) form.append(MURMUR_SPEED_FIELD, cfg.speed)
      const headers: Record<string, string> = {}
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
      if (cfg.speed && cfg.tier) headers[MURMUR_TIER_HEADER] = cfg.tier
      return fetch(url, {
        method: 'POST',
        body: form,
        headers,
        signal: combineSignals(cfg.timeoutMs, input.signal)
      })
    }

    try {
      const wantWords = wantVerbose && !wordTimestampsUnsupported.has(base)
      let res = await attempt(wantVerbose, wantWords)
      if (!res.ok && compact && (res.status === 400 || res.status === 415 || res.status === 422)) {
        // A gateway that cannot take Ogg Opus gets the WAV, now and from then on. A 400 about the
        // response format is left to the checks below.
        const body = await res.clone().text()
        if (!/timestamp_granularities|granularit|response_format|verbose/i.test(body)) {
          compactUnsupported.add(base)
          compact = null
          res = await attempt(wantVerbose, wantWords)
        }
      }
      if (!res.ok && res.status === 400 && wantWords) {
        // Word timestamps are the newest thing we ask for, so they are the first suspect for a
        // rejected request: try once without them before judging the error. A server that names
        // the field is remembered so the extra round-trip is not paid again.
        const body = await res.text()
        if (/timestamp_granularities|granularit/i.test(body)) wordTimestampsUnsupported.add(base)
        res = await attempt(true, false)
      }
      if (!res.ok && wantVerbose && res.status === 400) {
        const body = await res.text()
        if (/response_format|verbose/i.test(body)) {
          verboseUnsupported.add(base)
          res = await attempt(false, false)
        } else {
          throw errorFromResponse(res.status, body)
        }
      }
      if (!res.ok) throw errorFromResponse(res.status, await res.text())
      const contentType = res.headers.get('content-type') ?? ''
      let text = ''
      let json: VerboseJson | undefined
      if (contentType.includes('json')) {
        json = (await res.json()) as VerboseJson
        text = json.text ?? ''
      } else {
        text = await res.text()
      }
      const noSpeech = json?.segments?.length
        ? json.segments.reduce((acc, s) => acc + (s.no_speech_prob ?? 0), 0) / json.segments.length
        : undefined
      return {
        text: text.trim(),
        language: languageFromResponse(json),
        durationSec: json?.duration,
        noSpeechProb: noSpeech,
        latencyMs: Math.round(performance.now() - started),
        spans: spansFromVerbose(json),
        speed: readSpeedOutcome(res.headers, cfg.speed),
        raw: json
      }
    } catch (err) {
      throw toSttError(err)
    }
  }

  async listModels(cfg: SttConfig): Promise<string[]> {
    const base = normalizeBaseUrl(cfg.baseUrl)
    if (!base) throw new SttError('No base URL configured', 'bad-request')
    const headers: Record<string, string> = {}
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    try {
      const res = await fetch(`${base}/models`, {
        headers,
        signal: combineSignals(Math.min(cfg.timeoutMs, 15000))
      })
      if (!res.ok) throw errorFromResponse(res.status, await res.text())
      const json = (await res.json()) as {
        data?: Array<{ id: string }>
        models?: Array<{ name?: string; id?: string }>
      }
      const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
      if (!ids.length && json.models)
        ids.push(...json.models.map((m) => m.id ?? m.name ?? '').filter(Boolean))
      return rankSpeechModels([...new Set(ids)])
    } catch (err) {
      throw toSttError(err, 'Could not list models')
    }
  }
}

// ---- Murmur gateway: one-call release and prewarm -------------------------------------------------

/** Gateways without `/v1/dictate/release` (older instances, Convex); they get two calls. */
const releaseUnsupported = new Set<string>()

export interface ReleaseAnswer {
  stt: TranscribeOutput
  /** The text the gateway formatted (the prefix seam-joined with the transcript). */
  transcript: string
  /** The `/v1/format` answer for that text, or null when none was asked or it failed. */
  format: unknown
  /** The short-tail rules ran instead of the model. */
  rules: boolean
}

/**
 * The end of a dictation in one round trip to Murmur's gateway: speech, then (with `format`)
 * formatting of `prefix` + the transcript on the edge. Null when the gateway has no such route.
 */
export async function dictateRelease(
  input: TranscribeInput,
  cfg: SttConfig,
  prefix: string | undefined,
  format: Record<string, unknown> | undefined,
  /** The prefix is the last sentence the tail carries: the gateway joins them as carryInput does. */
  carry = false
): Promise<ReleaseAnswer | null> {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (!base || releaseUnsupported.has(base)) return null
  const started = performance.now()
  let compact: Uint8Array | null = null
  if (compactEncoder && !compactUnsupported.has(base)) {
    try {
      compact = compactEncoder(input.wav)
    } catch {
      compact = null
    }
  }
  const form = new FormData()
  if (compact) form.append('file', new Blob([compact as BlobPart], { type: 'audio/ogg' }), 'audio.ogg')
  else form.append('file', new Blob([input.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', cfg.model)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (cfg.language && cfg.language !== 'auto') form.append(sttLanguageField(cfg.model), cfg.language)
  if (input.prompt) form.append('prompt', input.prompt)
  if (cfg.speed) form.append(MURMUR_SPEED_FIELD, cfg.speed)
  if (prefix?.trim()) form.append('prefix', prefix)
  if (prefix?.trim() && carry) form.append('join', 'carry')
  if (format) form.append('format', JSON.stringify(format))
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  try {
    const res = await fetch(`${base}/dictate/release`, {
      method: 'POST',
      body: form,
      headers,
      signal: combineSignals(cfg.timeoutMs, input.signal)
    })
    if (res.status === 404 || res.status === 405) {
      releaseUnsupported.add(base)
      return null
    }
    if (!res.ok) throw errorFromResponse(res.status, await res.text())
    const body = (await res.json()) as {
      stt?: VerboseJson
      transcript?: string
      format?: unknown
      rules?: boolean
    }
    const json = body.stt ?? {}
    return {
      stt: {
        text: (json.text ?? '').trim(),
        language: languageFromResponse(json),
        durationSec: json.duration,
        latencyMs: Math.round(performance.now() - started),
        speed: readSpeedOutcome(res.headers, cfg.speed),
        raw: json
      },
      transcript: body.transcript ?? '',
      format: body.format ?? null,
      rules: body.rules === true
    }
  } catch (err) {
    throw toSttError(err)
  }
}

/**
 * Open a connection to Murmur's gateway while the user starts speaking (`GET /v1/warm`): the
 * release then skips the handshake, and the gateway warms its upstream and the account's grant.
 * Best effort; never throws.
 */
export async function prewarmGateway(baseUrl: string, token: string): Promise<void> {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return
  try {
    const res = await fetch(`${base}/warm`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3_000)
    })
    await res.body?.cancel()
  } catch {
    // best effort
  }
}
