import type { Plan } from './plans'

/**
 * Pure helpers behind the managed-inference gateway (convex/gateway.ts). Nothing here touches the
 * database or the network, so every rule is unit-testable.
 *
 * The gateway speaks the OpenAI HTTP API (`/v1/audio/transcriptions`, `/v1/chat/completions`,
 * `/v1/models`) so both apps reuse their existing OpenAI-compatible clients: the base URL is the
 * deployment's `.convex.site` host and the API key is the user's Clerk session JWT.
 */

/** Model ids clients ask for. The instance maps them to whatever upstream it is configured with. */
export const MURMUR_MODELS = {
  stt: 'murmur-transcribe',
  llm: 'murmur-format'
} as const

export type InferenceKind = keyof typeof MURMUR_MODELS

export interface Upstream {
  /** OpenAI-compatible base URL including the version path, e.g. https://api.groq.com/openai/v1. */
  baseUrl: string
  apiKey: string
  /** Model sent upstream for free accounts (and pro accounts without a dedicated model). */
  model: string
  /** Optional better model for paid accounts. */
  proModel?: string
}

export interface Upstreams {
  stt: Upstream | null
  llm: Upstream | null
}

export type Env = Record<string, string | undefined>

/**
 * Operator configuration, read from the deployment's environment variables:
 *
 *   MURMUR_INFERENCE_STT_URL / _KEY / _MODEL / _PRO_MODEL   speech to text
 *   MURMUR_INFERENCE_LLM_URL / _KEY / _MODEL / _PRO_MODEL   smart formatting
 *
 * A kind is offered only when its URL and model are both set; the key is optional for upstreams
 * that do not need one.
 */
export function readUpstreams(env: Env): Upstreams {
  const read = (prefix: string): Upstream | null => {
    const baseUrl = (env[`${prefix}_URL`] ?? '').trim().replace(/\/+$/, '')
    const model = (env[`${prefix}_MODEL`] ?? '').trim()
    if (!baseUrl || !model || !/^https?:\/\//i.test(baseUrl)) return null
    const proModel = (env[`${prefix}_PRO_MODEL`] ?? '').trim()
    return {
      baseUrl,
      apiKey: (env[`${prefix}_KEY`] ?? '').trim(),
      model,
      proModel: proModel || undefined
    }
  }
  return { stt: read('MURMUR_INFERENCE_STT'), llm: read('MURMUR_INFERENCE_LLM') }
}

export function upstreamModelFor(upstream: Upstream, plan: Plan): string {
  return plan === 'pro' && upstream.proModel ? upstream.proModel : upstream.model
}

/** Which managed models an account can currently ask for, in `/v1/models` shape. */
export function modelsPayload(upstreams: Upstreams): {
  object: 'list'
  data: Array<{ id: string; object: 'model'; owned_by: 'murmur'; capability: InferenceKind }>
} {
  const data: Array<{ id: string; object: 'model'; owned_by: 'murmur'; capability: InferenceKind }> = []
  if (upstreams.stt) data.push({ id: MURMUR_MODELS.stt, object: 'model', owned_by: 'murmur', capability: 'stt' })
  if (upstreams.llm) data.push({ id: MURMUR_MODELS.llm, object: 'model', owned_by: 'murmur', capability: 'llm' })
  return { object: 'list', data }
}

export type GatewayErrorCode =
  | 'unauthorized'
  | 'not_configured'
  | 'model_not_found'
  | 'bad_request'
  | 'clip_too_long'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_auth'
  | 'upstream_busy'

/** OpenAI-style error body; the apps read `error.message` and `error.code`. */
export function gatewayError(
  status: number,
  code: GatewayErrorCode,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ error: { message, type: 'murmur_gateway_error', code } }),
    { status, headers: { 'content-type': 'application/json', ...headers } }
  )
}

// ---- multipart/form-data ---------------------------------------------------------------------

export interface MultipartFile {
  name: string
  filename: string
  type: string
  data: Uint8Array
}

export interface MultipartBody {
  fields: Record<string, string[]>
  files: MultipartFile[]
}

const CRLF = new Uint8Array([13, 10])
const CRLFCRLF = new Uint8Array([13, 10, 13, 10])

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]
  const last = haystack.length - needle.length
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (haystack[i] !== first) continue
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function startsWith(haystack: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at + needle.length > haystack.length) return false
  for (let j = 0; j < needle.length; j++) if (haystack[at + j] !== needle[j]) return false
  return true
}

export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType.trim())) return null
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return m ? (m[1] ?? m[2]) : null
}

/**
 * Parse a `multipart/form-data` body. The Convex runtime does not implement `Request.formData()`,
 * so the gateway reads the body as bytes and splits it here. Binary parts are returned untouched;
 * text parts are decoded as UTF-8.
 */
export function parseMultipart(body: Uint8Array, contentType: string | null): MultipartBody {
  const boundary = multipartBoundary(contentType)
  if (!boundary) throw new Error('Expected a multipart/form-data body with a boundary')
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const delimiter = encoder.encode(`--${boundary}`)
  const closing = encoder.encode('--')
  const out: MultipartBody = { fields: {}, files: [] }

  let pos = indexOf(body, delimiter)
  if (pos < 0) throw new Error('Multipart boundary not found in body')
  for (;;) {
    pos += delimiter.length
    if (startsWith(body, closing, pos)) break
    if (startsWith(body, CRLF, pos)) pos += 2
    const headerEnd = indexOf(body, CRLFCRLF, pos)
    if (headerEnd < 0) throw new Error('Malformed multipart part: headers not terminated')
    const headers = decoder.decode(body.subarray(pos, headerEnd)).split('\r\n')
    let name = ''
    let filename: string | undefined
    let type = ''
    for (const line of headers) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (key === 'content-disposition') {
        name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1] ?? ''
        const f = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)
        if (f) filename = f[1]
      } else if (key === 'content-type') {
        type = value
      }
    }
    const dataStart = headerEnd + 4
    // The part ends right before CRLF + delimiter.
    const next = indexOf(body, delimiter, dataStart)
    if (next < 0) throw new Error('Malformed multipart part: closing boundary missing')
    let dataEnd = next
    if (dataEnd >= 2 && body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2
    const data = body.subarray(dataStart, dataEnd)
    if (filename !== undefined) {
      out.files.push({ name, filename, type, data })
    } else if (name) {
      ;(out.fields[name] ??= []).push(decoder.decode(data))
    }
    pos = next
  }
  return out
}

// ---- WAV -------------------------------------------------------------------------------------

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Bytes of PCM in the data chunk. */
  dataBytes: number
  durationSec: number
}

/** Read the RIFF/WAVE header; null when the bytes are not a PCM WAV file we can measure. */
export function wavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataBytes = -1
  while (offset + 8 <= bytes.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ' && start + 16 <= bytes.length) {
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      bitsPerSample = view.getUint16(start + 14, true)
    } else if (id === 'data') {
      // A streaming encoder may leave the size blank (0 or 0xffffffff): measure what is there.
      const remaining = bytes.length - start
      dataBytes = size === 0 || size === 0xffffffff || size > remaining ? remaining : size
      break
    }
    offset = start + size + (size % 2)
  }
  if (!sampleRate || !channels || !bitsPerSample || dataBytes < 0) return null
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  return { sampleRate, channels, bitsPerSample, dataBytes, durationSec: dataBytes / byteRate }
}

/**
 * How long a clip is, for quota purposes. WAV headers are measured exactly; anything else is
 * estimated from its size assuming 16 kHz 16-bit mono, which is what both apps send.
 */
export function clipSeconds(bytes: Uint8Array): number {
  const info = wavInfo(bytes)
  if (info) return info.durationSec
  return bytes.length / 32_000
}

/** Tokens a chat completion consumed, from the upstream `usage` block or a rough estimate. */
export function tokensUsed(
  usage: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined,
  requestChars: number,
  responseChars: number
): number {
  if (usage) {
    if (typeof usage.total_tokens === 'number') return Math.max(0, Math.floor(usage.total_tokens))
    const sum = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    if (sum > 0) return Math.floor(sum)
  }
  return Math.ceil((requestChars + responseChars) / 4)
}

/** Form fields a client may pass through to the speech upstream. Everything else is dropped. */
export const STT_PASSTHROUGH_FIELDS = new Set([
  'language',
  'prompt',
  'response_format',
  'temperature',
  'timestamp_granularities[]',
  'timestamp_granularities'
])

/** Upper bound on completion length so one request cannot drain a month of tokens. */
export const MAX_COMPLETION_TOKENS = 4096

/** Human-readable message for an upstream failure, without leaking the instance's credentials. */
export function describeUpstreamFailure(status: number, body: string): { status: number; code: GatewayErrorCode; message: string } {
  let detail = body.trim().slice(0, 300)
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    if (typeof json.error === 'string') detail = json.error
    else if (json.error?.message) detail = json.error.message
    else if (typeof json.message === 'string') detail = json.message
  } catch {
    // plain text
  }
  if (status === 401 || status === 403)
    return { status: 502, code: 'upstream_auth', message: 'The speech provider behind this Murmur instance rejected its credentials' }
  if (status === 429)
    return { status: 503, code: 'upstream_busy', message: 'The model provider is busy; try again in a moment' }
  if (status === 400 || status === 404 || status === 422)
    // Passed through with the upstream's own words so clients can adapt (e.g. drop word timestamps).
    return { status: 400, code: 'bad_request', message: detail || `Provider rejected the request (HTTP ${status})` }
  return { status: 502, code: 'upstream_error', message: detail || `Provider error (HTTP ${status})` }
}
