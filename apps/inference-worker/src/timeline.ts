import { handleTranscriptions, type GatewayHooks } from '../../../packages/backend/convex/lib/gatewayCore'
import { gatewayError, MURMUR_MODELS, type GatewayIdentity } from '../../../packages/backend/convex/lib/inference'
import { audioStats, readWav, scorePiece } from '../../../packages/backend/convex/lib/timelineAudio'
import type { ConvexLink } from './state'

/** A wav this large is not an all-day piece. Refusing it keeps one request from filling R2. */
const MAX_WAV_BYTES = 12_000_000

export interface TimelineBucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>
  delete(key: string): Promise<void>
}

export function timelineObjectKey(clerkId: string, device: string, startedAt: string): string {
  const part = (value: string): string => encodeURIComponent(value).slice(0, 180)
  return `timeline/${part(clerkId)}/${part(device)}/${part(startedAt)}.wav`
}

export function timelineKeyOwnedBy(key: string, clerkId: string): boolean {
  return key.startsWith(`timeline/${encodeURIComponent(clerkId)}/`) && !key.includes('..')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
 * POST /v1/timeline/audio. The wav is written to R2 after the Clerk check and the account grant.
 * Convex receives the transcript and the object key only.
 */
export async function handleTimelineAudio(
  request: Request,
  bucket: TimelineBucket | undefined,
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
    if (!saved.ok) return gatewayError(503, 'provider_unavailable', 'The timeline could not be saved')
    return json({ skipped: false, text, score, tags, ...stats })
  }
  if (!bucket) return gatewayError(503, 'not_configured', 'Timeline audio storage is not configured')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_WAV_BYTES) return gatewayError(413, 'bad_request', 'That piece is too large')
  const wav = readWav(bytes)
  if (!wav) return gatewayError(400, 'bad_request', 'Send the piece as a 16-bit PCM WAV')
  const stats = audioStats(wav.pcm, wav.rate)
  const seconds = wav.pcm.length / wav.rate
  if (stats.speechRatio < 0.02) return json({ skipped: true, ...stats })
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
  if (!text) return json({ skipped: true, ...stats, score, tags })
  const key = timelineObjectKey(identity.subject, device, startedAt)
  const sum = await sha256Hex(bytes)
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'audio/wav' },
    customMetadata: { sha256: sum, size: String(bytes.byteLength) }
  })
  const saved = await workerPost(link, '/worker/timeline', {
    clerkId: identity.subject,
    objectKey: key,
    chunk: { device, startedAt, endedAt, text, engine: 'server', ...stats, speakers: 0, score, tags }
  })
  if (!saved.ok) {
    await bucket.delete(key)
    return gatewayError(503, 'provider_unavailable', 'The timeline could not be saved')
  }
  const replaced = (await saved.json().catch(() => null)) as { replacedObjectKey?: string | null } | null
  if (replaced?.replacedObjectKey && replaced.replacedObjectKey !== key) await bucket.delete(replaced.replacedObjectKey)
  return json({ skipped: false, text, score, tags, ...stats, objectKey: key })
}

/** GET /v1/timeline/object?key= . Clerk session required. The bucket is not public. */
export async function handleTimelineObject(
  request: Request,
  bucket: TimelineBucket | undefined,
  identity: GatewayIdentity | null
): Promise<Response> {
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to listen to a piece')
  if (!bucket) return gatewayError(503, 'not_configured', 'Timeline audio storage is not configured')
  const key = new URL(request.url).searchParams.get('key') ?? ''
  if (!timelineKeyOwnedBy(key, identity.subject)) return gatewayError(403, 'unauthorized', 'That piece is not yours')
  const object = await bucket.get(key)
  if (!object) return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
  return new Response(await object.arrayBuffer(), {
    status: 200,
    headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=60' }
  })
}

/** POST /v1/timeline/refine. Reads the wav from R2, never from Convex. */
export async function handleTimelineRefine(
  request: Request,
  bucket: TimelineBucket | undefined,
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
  if (!looked.ok) return gatewayError(503, 'provider_unavailable', 'The timeline could not be read')
  const row = (await looked.json()) as {
    id: string
    objectKey: string | null
    refinedText: string | null
    before: string
  } | null
  if (!row) return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
  if (row.refinedText != null) return json({ text: row.refinedText, cached: true })
  if (!row.objectKey) return gatewayError(410, 'bad_request', 'This piece has no audio in object storage')
  if (!timelineKeyOwnedBy(row.objectKey, identity.subject)) return gatewayError(403, 'unauthorized', 'That piece is not yours')
  if (!bucket) return gatewayError(503, 'not_configured', 'Timeline audio storage is not configured')
  const object = await bucket.get(row.objectKey)
  if (!object) return gatewayError(410, 'bad_request', 'This piece has no audio kept')
  const audio = await object.arrayBuffer()
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
  if (!transcribed.ok) return transcribed
  const text = String(((await transcribed.json()) as { text?: string }).text ?? '').trim()
  const saved = await workerPost(link, '/worker/timeline/refined', { id: row.id, text })
  if (!saved.ok) return gatewayError(503, 'provider_unavailable', 'The careful transcript could not be saved')
  return json({ text, cached: false })
}

/** Daily: ask Convex which rows aged out, then delete those R2 objects. */
export async function sweepTimelineObjects(bucket: TimelineBucket, link: ConvexLink): Promise<number> {
  let deleted = 0
  for (let i = 0; i < 20; i++) {
    const res = await workerPost(link, '/worker/timeline/sweep', {})
    if (!res.ok) throw new Error(`timeline sweep HTTP ${res.status}`)
    const body = (await res.json()) as { objectKeys?: string[]; more?: boolean }
    for (const key of body.objectKeys ?? []) {
      if (!key.startsWith('timeline/')) continue
      await bucket.delete(key)
      deleted++
    }
    if (!body.more) break
  }
  return deleted
}
