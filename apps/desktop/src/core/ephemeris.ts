import type { Settings } from '@shared/settings'

/**
 * Optional hand-off of finished dictations to Ephemeris, a local app that collects notes, tasks
 * and meetings. It listens on loopback (default http://127.0.0.1:4317) and takes transcripts at
 * `POST /api/signals/transcript`. Off unless the user turns it on in Settings.
 */

export const EPHEMERIS_TIMEOUT_MS = 3000
export const EPHEMERIS_TRANSCRIPT_PATH = '/api/signals/transcript'

export interface EphemerisSegment {
  startMs: number
  endMs: number
  speaker?: string
  text: string
}

export interface EphemerisTranscript {
  text: string
  kind: 'note' | 'meeting'
  /** Foreground app when the dictation was spoken, if known. */
  app?: string
  startedAt?: string
  endedAt?: string
  segments?: EphemerisSegment[]
}

export interface EphemerisLogger {
  warn: (message: string, ...rest: unknown[]) => void
}

export type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, 'ok' | 'status'>>

/** Where transcripts go for this configuration: the base URL with the transcript path appended. */
export function ephemerisEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, '') + EPHEMERIS_TRANSCRIPT_PATH
}

/**
 * Send one transcript to Ephemeris. Resolves `true` when Ephemeris accepted it, `false` when the
 * integration is off, the text is empty, or anything went wrong (unreachable, non-2xx, slower
 * than `EPHEMERIS_TIMEOUT_MS`). It never rejects: a dictation must not fail because a side
 * channel did.
 */
export async function sendToEphemeris(
  settings: Pick<Settings, 'ephemeris'>,
  payload: EphemerisTranscript,
  fetchImpl: FetchLike = fetch,
  log: EphemerisLogger = console,
  timeoutMs = EPHEMERIS_TIMEOUT_MS
): Promise<boolean> {
  const cfg = settings.ephemeris
  if (!cfg.enabled || !cfg.url.trim() || !payload.text.trim()) return false
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // The deadline holds even for a fetch that ignores the abort signal.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('timeout'))
    }, timeoutMs)
  })
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = cfg.token.trim()
    if (token) headers.Authorization = `Bearer ${token}`
    const request = fetchImpl(ephemerisEndpoint(cfg.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, source: 'murmur' }),
      signal: controller.signal
    })
    request.catch(() => undefined)
    const res = await Promise.race([request, deadline])
    if (!res.ok) {
      log.warn(`Ephemeris answered ${res.status}; transcript not delivered`)
      return false
    }
    return true
  } catch (err) {
    log.warn(
      controller.signal.aborted
        ? `Ephemeris did not answer within ${timeoutMs} ms; transcript not delivered`
        : 'Could not reach Ephemeris; transcript not delivered',
      err
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}
