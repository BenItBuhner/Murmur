/**
 * Phone as microphone: the contract every client shares (desktop, website, Android port).
 * See docs/phone-microphone.md. Audio never reaches Convex: it travels peer to peer over WebRTC,
 * and Convex carries only one offer and one answer per link.
 *
 * Pure and dependency-free, so the desktop renderer, the website and the backend import the same
 * code. The Android app carries a port of the constants and the SDP tuning (keep them in step).
 */

/** Bumped when a message changes meaning; `hello` carries it and the desktop refuses a newer one. */
export const MIC_PROTOCOL_VERSION = 1

/** A signal (offer or answer) older than this is ignored and swept. */
export const MIC_SIGNAL_TTL_MS = 2 * 60_000
/** Pending signals kept per addressee; older ones are dropped when a new one arrives. */
export const MIC_MAX_PENDING = 4
/** The longest SDP accepted. A complete audio-only SDP with gathered candidates is 2-6 KB. */
export const MIC_MAX_SDP_LENGTH = 16_000
export const MIC_MAX_NAME_LENGTH = 120
export const MIC_MAX_ID_LENGTH = 64
/** A receiver re-registers on its own at most this often (name and switch changes apply at once). */
export const MIC_REGISTRATION_REFRESH_MS = 24 * 60 * 60_000
/**
 * A receiver whose device has not been seen (its `deviceLiveness`, which the desktop's 15-minute
 * heartbeat refreshes at most every ten minutes) for this long has quit or signed out: phones
 * stop listing it and offers to it are refused, without any extra write.
 */
export const MIC_RECEIVER_STALE_MS = 45 * 60_000
/** Candidate gathering is waited for this long before the SDP is sent with what it has. */
export const MIC_ICE_GATHER_MS = 3_000
/** How long a phone waits for the desktop's answer. */
export const MIC_ANSWER_TIMEOUT_MS = 20_000
/** A link down this long during a dictation ends the dictation (what was said is kept). */
export const MIC_DROP_GRACE_MS = 15_000
/** The data channel's label. */
export const MIC_CONTROL_LABEL = 'murmur-control'
/** Level messages are sent at most this often while listening. */
export const MIC_LEVEL_INTERVAL_MS = 200
/** Characters of the inserted text sent back to the phone. */
export const MIC_RESULT_PREVIEW = 280

export interface MicIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** Public STUN only: no relay, nothing of the audio passes a Murmur-run server. */
export const DEFAULT_MIC_ICE_SERVERS: MicIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
]

/**
 * `MURMUR_MIC_ICE_SERVERS`: a JSON array of RTCIceServer objects (an operator's TURN relay, for
 * example). Anything unreadable falls back to the defaults rather than breaking links.
 */
export function iceServersFromEnv(value: string | undefined): MicIceServer[] {
  if (!value || !value.trim()) return DEFAULT_MIC_ICE_SERVERS
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return DEFAULT_MIC_ICE_SERVERS
    const out: MicIceServer[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const urls = rec.urls
      const okUrls =
        typeof urls === 'string' ||
        (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string'))
      if (!okUrls) continue
      const server: MicIceServer = { urls: urls as string | string[] }
      if (typeof rec.username === 'string') server.username = rec.username
      if (typeof rec.credential === 'string') server.credential = rec.credential
      out.push(server)
    }
    return out.length ? out : DEFAULT_MIC_ICE_SERVERS
  } catch {
    return DEFAULT_MIC_ICE_SERVERS
  }
}

// ---- control messages (data channel) -------------------------------------------------------

export type MicDictationState = 'idle' | 'listening' | 'processing'

export type PhoneToDesktop =
  | { t: 'hello'; v: number; name: string }
  | { t: 'start' }
  | { t: 'stop' }
  | { t: 'cancel' }
  | { t: 'ping' }

export type DesktopToPhone =
  | { t: 'welcome'; v: number; name: string; state: MicDictationState }
  | { t: 'state'; state: MicDictationState; elapsedSec?: number }
  | { t: 'level'; level: number }
  | { t: 'result'; text: string; words: number }
  | { t: 'error'; message: string }
  | { t: 'pong' }

const STATES: readonly string[] = ['idle', 'listening', 'processing']

function asObject(raw: unknown): Record<string, unknown> | null {
  let value = raw
  if (typeof value === 'string') {
    if (value.length > 4_096) return null
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A control message from the phone, or null when it is not one this version understands. */
export function parsePhoneMessage(raw: unknown): PhoneToDesktop | null {
  const m = asObject(raw)
  if (!m) return null
  switch (m.t) {
    case 'hello':
      return {
        t: 'hello',
        v: typeof m.v === 'number' ? m.v : 0,
        name: typeof m.name === 'string' ? m.name.slice(0, MIC_MAX_NAME_LENGTH) : 'Phone'
      }
    case 'start':
    case 'stop':
    case 'cancel':
    case 'ping':
      return { t: m.t }
    default:
      return null
  }
}

/** A control message from the desktop, or null when it is not one this version understands. */
export function parseDesktopMessage(raw: unknown): DesktopToPhone | null {
  const m = asObject(raw)
  if (!m) return null
  switch (m.t) {
    case 'welcome':
      if (typeof m.state !== 'string' || !STATES.includes(m.state)) return null
      return {
        t: 'welcome',
        v: typeof m.v === 'number' ? m.v : 0,
        name: typeof m.name === 'string' ? m.name.slice(0, MIC_MAX_NAME_LENGTH) : 'Desktop',
        state: m.state as MicDictationState
      }
    case 'state':
      if (typeof m.state !== 'string' || !STATES.includes(m.state)) return null
      return {
        t: 'state',
        state: m.state as MicDictationState,
        ...(typeof m.elapsedSec === 'number' ? { elapsedSec: m.elapsedSec } : {})
      }
    case 'level':
      return typeof m.level === 'number'
        ? { t: 'level', level: Math.max(0, Math.min(1, m.level)) }
        : null
    case 'result':
      return typeof m.text === 'string'
        ? {
            t: 'result',
            text: m.text.slice(0, MIC_RESULT_PREVIEW),
            words: typeof m.words === 'number' ? m.words : 0
          }
        : null
    case 'error':
      return typeof m.message === 'string' ? { t: 'error', message: m.message.slice(0, 300) } : null
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

/** The text sent back to the phone after a dictation: a preview and the word count. */
export function resultMessage(text: string): DesktopToPhone {
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  const preview =
    trimmed.length > MIC_RESULT_PREVIEW ? `${trimmed.slice(0, MIC_RESULT_PREVIEW - 1)}…` : trimmed
  return { t: 'result', text: preview, words }
}

// ---- SDP -----------------------------------------------------------------------------------

/**
 * Opus tuned for speech going to a recognizer: mono, in-band FEC for lossy Wi-Fi, no DTX (DTX
 * drops packets in pauses, and the recognizer's pause detection should see real silence), and
 * 32 kbit/s, well above what speech needs and a fraction of any network's capacity.
 */
export const OPUS_PARAMS: Record<string, string> = {
  stereo: '0',
  'sprop-stereo': '0',
  useinbandfec: '1',
  usedtx: '0',
  maxaveragebitrate: '32000'
}

/** Rewrites the Opus `a=fmtp` line(s) of an SDP with OPUS_PARAMS, keeping every other parameter. */
export function tuneOpusSdp(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/)
  const opus = new Set<string>()
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line)
    if (m) opus.add(m[1])
  }
  if (!opus.size) return sdp
  const seen = new Set<string>()
  const out = lines.map((line) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line)
    if (!m || !opus.has(m[1])) return line
    seen.add(m[1])
    const params = new Map<string, string>()
    for (const part of m[2].split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k) params.set(k, rest.join('='))
    }
    for (const [k, val] of Object.entries(OPUS_PARAMS)) params.set(k, val)
    return `a=fmtp:${m[1]} ${[...params].map(([k, val]) => `${k}=${val}`).join(';')}`
  })
  // An Opus payload without an fmtp line gets one right after its rtpmap.
  const result: string[] = []
  for (const line of out) {
    result.push(line)
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line)
    if (m && !seen.has(m[1])) {
      result.push(
        `a=fmtp:${m[1]} ${Object.entries(OPUS_PARAMS)
          .map(([k, val]) => `${k}=${val}`)
          .join(';')}`
      )
    }
  }
  return result.join(eol)
}

/** Whether a link reached the other side directly ('direct'), through STUN ('stun') or a relay. */
export type MicRoute = 'direct' | 'stun' | 'relay' | 'unknown'

export function routeOf(localType?: string, remoteType?: string): MicRoute {
  if (!localType || !remoteType) return 'unknown'
  if (localType === 'relay' || remoteType === 'relay') return 'relay'
  if (localType === 'host' && remoteType === 'host') return 'direct'
  return 'stun'
}
