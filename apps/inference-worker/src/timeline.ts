import { handleTranscriptions, type GatewayHooks } from '../../../packages/backend/convex/lib/gatewayCore'
import { gatewayError, MURMUR_MODELS, type GatewayIdentity } from '../../../packages/backend/convex/lib/inference'
import { audioStats, readWav, scorePiece } from '../../../packages/backend/convex/lib/timelineAudio'
import { isBypass, type ConvexLink } from './state'

/** A wav this large is not an all-day piece. */
const MAX_WAV_BYTES = 12_000_000
/** Home-lab signatures older or newer than this are refused. */
export const STORE_SKEW_MS = 5 * 60_000

export interface TimelineStore {
  url: string
  secret: string
}

export function timelineObjectKey(clerkId: string, device: string, startedAt: string): string {
  const part = (value: string): string => encodeURIComponent(value).slice(0, 180)
  return `timeline/${part(clerkId)}/${part(device)}/${part(startedAt)}.wav`
}

export function timelineKeyOwnedBy(key: string, clerkId: string): boolean {
  return key.startsWith(`timeline/${encodeURIComponent(clerkId)}/`) && !key.includes('..')
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Sign method, path, timestamp and body hash. The home lab checks the same string. */
export async function signStoreRequest(secret: string, method: string, path: string, body: Uint8Array, now = Date.now()): Promise<{ ts: string; sha256: string; signature: string }> {
  const sha256 = await sha256Hex(body)
  const ts = String(now)
  const signature = await hmacHex(secret, `${method}\n${path}\n${ts}\n${sha256}`)
  return { ts, sha256, signature }
}

async function storeFetch(store: TimelineStore, method: string, key: string, body: Uint8Array, fetcher: typeof fetch): Promise<Response> {
  const path = `/objects/${key.split('/').map(encodeURIComponent).join('/')}`
  const signed = await signStoreRequest(store.secret, method, path, body)
  return await fetcher(`${store.url.replace(/\/+$/, '')}${path}`, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      'x-timeline-ts': signed.ts,
      'x-timeline-sha256': signed.sha256,
      'x-timeline-signature': signed.signature,
      'content-type': 'application/octet-stream'
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : new Blob([body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer])
  })
}

async function workerPost(link: ConvexLink, path: string, body: unknown): Promise<Response> {
  return await link.fetcher(`${link.siteUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${link.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/**
 * POST /v1/timeline/audio. Clerk, then the cached grant (inside transcription), then the wav goes
 * to the home lab. If that store is down the transcript is still saved and the answer is 200.
 */
export async function handleTimelineAudio(
  request: Request,
  store: TimelineStore | null,
  link: ConvexLink,
  hooks: GatewayHooks,
  identity: GatewayIdentity | null
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to record all day')
  const url = new URL(request.url)
  const device = url.searchParams.get('device') ?? ''
  const startedAt = url.searchParams.get('startedAt') ?? ''
  const endedAt = url.searchParams.get('endedAt') ?? ''
  if (!device || !startedAt || !endedAt)
    return gatewayError(400, 'bad_request', 'device, startedAt and endedAt are required')
  if (/^application\/json/i.test(request.headers.get('content-type') ?? '')) {
    const body = (await request.json().catch(() => null)) as { text?: unknown; rmsDb?: unknown; speechRatio?: unknown } | null
    const num = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback
    const stats = { rmsDb: num(body?.rmsDb, -60), speechRatio: num(body?.speechRatio, 0) }
    const text = (typeof body?.text === 'string' ? body.text : '').trim().slice(0, 4000)
    if (!text) return json({ skipped: true, ...stats })
    const seconds = Math.max(1, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000 || 1)
    const { score, tags } = scorePiece({ text, seconds, ...stats })
    const saved = await workerPost(link, '/worker/timeline', {
      clerkId: identity.subject,
      chunk: { device, startedAt, endedAt, text, engine: 'local', ...stats, speakers: 0, score, tags }
    })
    if (!saved.ok) return json({ skipped: false, text, score, tags, ...stats, audioStored: false })
    return json({ skipped: false, text, score, tags, ...stats, audioStored: false })
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_WAV_BYTES) return gatewayError(413, 'bad_request', 'That piece is too large')
  const wav = readWav(bytes)
  if (!wav) return gatewayError(400, 'bad_request', 'Send the piece as a 16-bit PCM WAV')
  const stats = audioStats(wav.pcm, wav.rate)
  const seconds = wav.pcm.length / wav.rate
  if (stats.speechRatio < 0.02) return json({ skipped: true, ...stats, audioStored: false })
  const sttUrl = new URL(request.url)
  sttUrl.search = new URLSearchParams({ model: MURMUR_MODELS.stt }).toString()
  const transcribed = await handleTranscriptions(
    hooks,
    identity,
    new Request(sttUrl, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-murmur-tier': 'background' }, body: bytes })
  )
  if (!transcribed.ok) return transcribed
  const text = String(((await transcribed.json()) as { text?: string }).text ?? '').trim().slice(0, 4000)
  const { score, tags } = scorePiece({ text, seconds, ...stats })
  if (!text) return json({ skipped: true, ...stats, score, tags, audioStored: false })
  const key = timelineObjectKey(identity.subject, device, startedAt)
  let audioStored = false
  // Convex down: transcribe and return the text. Do not keep the wav.
  if (store && !isBypass(identity.subject)) {
    try {
      const put = await storeFetch(store, 'PUT', key, bytes, link.fetcher)
      audioStored = put.ok
      if (!put.ok) console.warn(`[timeline] store answered HTTP ${put.status}; keeping the transcript only`)
    } catch (err) {
      console.warn(`[timeline] store unreachable; keeping the transcript only: ${err instanceof Error ? err.message : err}`)
    }
  }
  const saved = await workerPost(link, '/worker/timeline', {
    clerkId: identity.subject,
    ...(audioStored ? { objectKey: key } : {}),
    chunk: { device, startedAt, endedAt, text, engine: 'server', ...stats, speakers: 0, score, tags }
  })
  if (!saved.ok) console.warn(`[timeline] Convex did not save the transcript (HTTP ${saved.status})`)
  return json({ skipped: false, text, score, tags, ...stats, audioStored, ...(audioStored ? { objectKey: key } : {}) })
}

/** GET /v1/timeline/object?key= . Clerk session, then the key must belong to that account. */
export async function handleTimelineObject(
  request: Request,
  store: TimelineStore | null,
  identity: GatewayIdentity | null,
  fetcher: typeof fetch
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to listen to a piece')
  if (!store) return gatewayError(404, 'bad_request', 'No audio is kept for this piece')
  const key = new URL(request.url).searchParams.get('key') ?? ''
  if (!timelineKeyOwnedBy(key, identity.subject)) return gatewayError(403, 'unauthorized', 'That piece is not yours')
  try {
    const object = await storeFetch(store, 'GET', key, new Uint8Array(), fetcher)
    if (!object.ok) return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
    return new Response(await object.arrayBuffer(), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=60' }
    })
  } catch {
    return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
  }
}

/** POST /v1/timeline/refine. A missing store returns the draft text instead of a speech error. */
export async function handleTimelineRefine(
  request: Request,
  store: TimelineStore | null,
  link: ConvexLink,
  hooks: GatewayHooks,
  identity: GatewayIdentity | null
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use careful transcripts')
  const body = (await request.json().catch(() => null)) as { device?: string; startedAt?: string } | null
  if (!body?.device || !body.startedAt) return gatewayError(400, 'bad_request', 'device and startedAt are required')
  const looked = await workerPost(link, '/worker/timeline/lookup', {
    clerkId: identity.subject,
    device: body.device,
    startedAt: body.startedAt
  })
  if (!looked.ok) return json({ text: '', cached: false, audioStored: false })
  const row = (await looked.json()) as {
    id: string
    objectKey: string | null
    refinedText: string | null
    before: string
    text?: string
  } | null
  if (!row) return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
  if (row.refinedText != null) return json({ text: row.refinedText, cached: true })
  if (!row.objectKey || !store || !timelineKeyOwnedBy(row.objectKey, identity.subject))
    return json({ text: row.text ?? '', cached: false, audioStored: false })
  let audio: ArrayBuffer
  try {
    const object = await storeFetch(store, 'GET', row.objectKey, new Uint8Array(), link.fetcher)
    if (!object.ok) return json({ text: row.text ?? '', cached: false, audioStored: false })
    audio = await object.arrayBuffer()
  } catch {
    return json({ text: row.text ?? '', cached: false, audioStored: false })
  }
  const sttUrl = new URL(request.url)
  sttUrl.search = new URLSearchParams({
    model: MURMUR_MODELS.stt,
    ...(row.before ? { prompt: row.before.slice(-800) } : {})
  }).toString()
  const transcribed = await handleTranscriptions(
    hooks,
    identity,
    new Request(sttUrl, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio })
  )
  if (!transcribed.ok) return json({ text: row.text ?? '', cached: false, audioStored: true })
  const text = String(((await transcribed.json()) as { text?: string }).text ?? '').trim()
  await workerPost(link, '/worker/timeline/refined', { id: row.id, text })
  return json({ text, cached: false, audioStored: true })
}

/** Ask Convex which rows aged out, then DELETE those objects on the home lab. */
export async function sweepTimelineObjects(store: TimelineStore, link: ConvexLink): Promise<number> {
  let deleted = 0
  for (let i = 0; i < 20; i++) {
    const res = await workerPost(link, '/worker/timeline/sweep', {})
    if (!res.ok) throw new Error(`timeline sweep HTTP ${res.status}`)
    const body = (await res.json()) as { objectKeys?: string[]; more?: boolean }
    for (const key of body.objectKeys ?? []) {
      if (!key.startsWith('timeline/')) continue
      try {
        const gone = await storeFetch(store, 'DELETE', key, new Uint8Array(), link.fetcher)
        if (gone.ok || gone.status === 404) deleted++
      } catch (err) {
        console.warn(`[timeline] delete ${key} failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (!body.more) break
  }
  return deleted
}
