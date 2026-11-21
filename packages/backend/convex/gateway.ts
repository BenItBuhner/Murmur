import { internal } from './_generated/api'
import { httpAction, type ActionCtx } from './_generated/server'
import {
  handleChatCompletions,
  handleFormat,
  handleLayout,
  handleModels,
  handleTranscriptions,
  type Gate,
  type GatewayHooks
} from './lib/gatewayCore'
import { gatewayError, identityOf, type GatewayIdentity } from './lib/inference'
import { scorePiece } from './lib/timelineAudio'
import type { Id } from './_generated/dataModel'

/**
 * The managed inference gateway as Convex HTTP actions. Every request here buffers the audio in an
 * action and runs authorize + record (+ breaker) mutations, which is what pushed Murmur past the
 * Convex free plan; the same handlers (lib/gatewayCore.ts) now run in the inference Worker
 * (apps/inference-worker) and clients use that when it is configured. These routes stay as the
 * fallback for clients that do not know the Worker yet, and can be switched off without a client
 * release by setting MURMUR_CONVEX_GATEWAY=off in the deployment's environment.
 */

function callerArgs(identity: GatewayIdentity): { clerkId: string; email?: string; emailVerified?: boolean } {
  return { clerkId: identity.subject, email: identity.email, emailVerified: identity.emailVerified }
}

/** `MURMUR_CONVEX_GATEWAY=off` turns the Convex routes off (they answer 410 with where to go). */
export function convexGatewayEnabled(env: Record<string, string | undefined>): boolean {
  return (env.MURMUR_CONVEX_GATEWAY ?? '').trim().toLowerCase() !== 'off'
}

function gatewayOff(): Response {
  return gatewayError(
    503,
    'not_configured',
    'Murmur models moved; update Murmur to keep using them'
  )
}

export function convexHooks(ctx: ActionCtx): GatewayHooks {
  return {
    env: process.env,
    access: (identity) => ctx.runQuery(internal.inference.access, callerArgs(identity)),
    authorize: async ({ identity, ...rest }) =>
      (await ctx.runMutation(internal.inference.authorize, { ...callerArgs(identity), ...rest })) as Gate,
    record: async ({ userId, identity: _identity, ...rest }) => {
      await ctx.runMutation(internal.inference.record, { userId: userId as Id<'users'>, ...rest })
    },
    providerFailed: (kind, reason) => ctx.runMutation(internal.inference.providerFailed, { kind, reason }),
    providerRecovered: async (kind) => {
      await ctx.runMutation(internal.inference.providerRecovered, { kind })
    }
  }
}

export const models = httpAction(async (ctx) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleModels(convexHooks(ctx), await identityOf(ctx.auth))
})

export const transcriptions = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleTranscriptions(convexHooks(ctx), await identityOf(ctx.auth), request)
})

export const chatCompletions = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleChatCompletions(convexHooks(ctx), await identityOf(ctx.auth), request)
})

export const format = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleFormat(convexHooks(ctx), await identityOf(ctx.auth), request)
})

export const layout = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleLayout(convexHooks(ctx), await identityOf(ctx.auth), request)
})

/**
 * All-day recording: a device sends a piece of audio and nothing else. The server measures it, skips
 * silence, transcribes speech with the managed model (same quotas as dictation), scores it, and keeps
 * the text for the account's desktop to pick up. `?device=&startedAt=&endedAt=` describe the piece.
 */
export const timelineAudio = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to record all day')
  const url = new URL(request.url)
  const device = url.searchParams.get('device') ?? ''
  const startedAt = url.searchParams.get('startedAt') ?? ''
  const endedAt = url.searchParams.get('endedAt') ?? ''
  if (!device || !startedAt || !endedAt)
    return gatewayError(400, 'bad_request', 'device, startedAt and endedAt are required')
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  // Words a device already drafted. Text only: no wav is read and nothing is written to file storage.
  if (/^application\/json/i.test(request.headers.get('content-type') ?? '')) {
    const body = (await request.json().catch(() => null)) as { text?: unknown; rmsDb?: unknown; speechRatio?: unknown } | null
    const num = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback
    const stats = { rmsDb: num(body?.rmsDb, -60), speechRatio: num(body?.speechRatio, 0) }
    const text = (typeof body?.text === 'string' ? body.text : '').trim().slice(0, 4000)
    if (!text) return json({ skipped: true, ...stats })
    const seconds = Math.max(1, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000 || 1)
    const { score, tags } = scorePiece({ text, seconds, ...stats })
    await ctx.runMutation(internal.timeline.store, {
      clerkId: identity.subject,
      chunk: { device, startedAt, endedAt, text, engine: 'local', ...stats, speakers: 0, score, tags }
    })
    return json({ skipped: false, text, score, tags, ...stats })
  }
  // Audio bytes used to land in Convex file storage and leave through file egress. They now go to
  // the inference Worker, which writes R2. This route does not read the body.
  return gatewayError(
    410,
    'bad_request',
    'Send timeline audio to the inference worker POST /v1/timeline/audio. Convex no longer stores the wav.'
  )
})

/**
 * A careful transcript of one all-day piece (`{ device, startedAt }`), made from the audio the server
 * kept, with the text before it as context. Made once: asking again returns the stored one.
 */
export const timelineRefine = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  const identity = await identityOf(ctx.auth)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use careful transcripts')
  const body = (await request.json().catch(() => ({}))) as { device?: string; startedAt?: string }
  if (!body.device || !body.startedAt)
    return gatewayError(400, 'bad_request', 'device and startedAt are required')
  const row = await ctx.runQuery(internal.timeline.forRefine, {
    clerkId: identity.subject,
    device: body.device,
    startedAt: body.startedAt
  })
  const json = (b: unknown): Response =>
    new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
  if (!row) return gatewayError(404, 'bad_request', 'No such piece, or it is past the keep window')
  if (row.refinedText != null) return json({ text: row.refinedText, cached: true })
  // Reading the wav here was file egress. The inference Worker refines from R2.
  return gatewayError(
    410,
    'bad_request',
    'Ask the inference worker POST /v1/timeline/refine. Convex does not read timeline audio.'
  )
})
