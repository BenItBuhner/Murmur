import {
  handleChatCompletions,
  handleDictateRelease,
  handleFormat,
  handleModels,
  handleTranscriptions,
  type Gate,
  type GatewayHooks
} from '../../../packages/backend/convex/lib/gatewayCore'
import { gatewayError, type GatewayIdentity } from '../../../packages/backend/convex/lib/inference'
import { verifyClerkToken } from './clerk'
import {
  flushUsage,
  grantFor,
  providerFailed,
  providerRecovered,
  providerState,
  queueUsage,
  type ConvexLink,
  USAGE_FLUSH_MS
} from './state'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Murmur's managed inference gateway on Cloudflare Workers. Same OpenAI-compatible routes and the
 * same handlers (packages/backend/convex/lib/gatewayCore.ts) as the Convex HTTP actions it
 * replaces, so clients only change the base URL:
 *
 *   GET  /v1/models
 *   POST /v1/audio/transcriptions
 *   POST /v1/chat/completions
 *   POST /v1/format
 *
 * The bearer token is the same Clerk session JWT the apps already send, verified here against
 * Clerk's JWKS. Convex is asked for an account's allowance at most once every two minutes per
 * isolate (/worker/grant) and hears about usage in batches (/worker/usage); the audio and the
 * provider round trips never touch Convex.
 */

export interface Env {
  CLERK_JWT_ISSUER_DOMAIN: string
  CONVEX_SITE_URL: string
  MURMUR_WORKER_SECRET: string
  [key: string]: string | undefined
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void
}

function hooksFor(env: Env, link: ConvexLink, ctx: Ctx): GatewayHooks {
  return {
    env,
    access: async (identity) => {
      const grant = await grantFor(link, identity)
      return grant.ok ? grant.planState : 'testing'
    },
    authorize: async ({ identity, kind, degradable }): Promise<Gate> => {
      const grant = await grantFor(link, identity)
      if (!grant.ok) return { ok: false, plan: 'testing', planState: 'testing', denied: 'private_testing' }
      const { plan, planState } = grant
      let paused = null
      if (kind === 'stt') {
        if (grant.stt) return { ok: false, plan, planState, refusal: grant.stt }
      } else if (degradable) {
        if (grant.format.refusal) return { ok: false, plan, planState, refusal: grant.format.refusal }
        paused = grant.format.paused
      } else if (grant.llm) {
        return { ok: false, plan, planState, refusal: grant.llm }
      }
      const provider = providerState(kind)
      if (provider.openForSec !== null && degradable !== true)
        return { ok: false, plan, planState, unavailable: { retryAfterSec: provider.openForSec } }
      return { ok: true, userId: identity.subject, plan, planState, paused, provider }
    },
    record: async ({ identity, kind, seconds, tokens, words }) => {
      const due = queueUsage({ clerkId: identity.subject, kind, seconds, tokens, words, at: Date.now() })
      if (due === 'now') ctx.waitUntil(flushUsage(link))
      // The first record of a batch keeps the isolate around long enough to send it with whatever
      // else arrives meanwhile, so a quiet isolate never sits on usage.
      else if (due === 'later') ctx.waitUntil(delay(USAGE_FLUSH_MS).then(() => flushUsage(link)))
    },
    providerFailed: async (kind) => providerFailed(kind),
    providerRecovered: async (kind) => providerRecovered(kind)
  }
}

/**
 * workerd's global fetch must be called with no receiver: stored on an object and called as
 * link.fetcher(...) it throws "Illegal invocation: function called with incorrect this
 * reference", which failed every /worker/grant call in 0.6.9. Wrap it so it never travels detached.
 */
const boundFetch: typeof fetch = (input, init) => fetch(input, init)

export async function handle(request: Request, env: Env, ctx: Ctx, fetcher: typeof fetch = boundFetch): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/health') return new Response('ok', { status: 200 })
  // Prewarm, sent by the apps when recording starts: this isolate opens its connection to the model
  // proxy and, with a session token, refreshes the account's grant, so the release pays neither.
  if (path === '/v1/warm') {
    ctx.waitUntil(warm(request, env, fetcher))
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }
  if (!env.CLERK_JWT_ISSUER_DOMAIN || !env.CONVEX_SITE_URL || !env.MURMUR_WORKER_SECRET)
    return gatewayError(503, 'not_configured', 'This Murmur inference gateway is not configured')

  const link: ConvexLink = { siteUrl: env.CONVEX_SITE_URL, secret: env.MURMUR_WORKER_SECRET, fetcher }
  let identity: GatewayIdentity | null
  try {
    identity = await verifyClerkToken(request.headers.get('authorization'), env.CLERK_JWT_ISSUER_DOMAIN, fetcher)
  } catch (err) {
    console.error(`[worker] cannot verify sessions: ${err instanceof Error ? err.message : err}`)
    return gatewayError(503, 'provider_unavailable', 'Murmur cannot check your session right now; try again shortly')
  }
  const hooks = hooksFor(env, link, ctx)
  try {
    if (path === '/v1/models' && request.method === 'GET') return await handleModels(hooks, identity)
    if (request.method !== 'POST') return gatewayError(404, 'bad_request', 'Not found')
    if (path === '/v1/audio/transcriptions') return await handleTranscriptions(hooks, identity, request)
    if (path === '/v1/chat/completions') return await handleChatCompletions(hooks, identity, request)
    if (path === '/v1/format') return await handleFormat(hooks, identity, request)
    if (path === '/v1/dictate/release') return await handleDictateRelease(hooks, identity, request)
    return gatewayError(404, 'bad_request', 'Not found')
  } catch (err) {
    // grantFor failing means Convex is unreachable: refuse rather than serve without an allowance.
    console.error(`[worker] ${path} failed: ${err instanceof Error ? err.message : err}`)
    return gatewayError(503, 'provider_unavailable', 'Murmur models are briefly unavailable; try again shortly')
  }
}

async function warm(request: Request, env: Env, fetcher: typeof fetch): Promise<void> {
  const base = (env.MURMUR_INFERENCE_STT_URL ?? '').replace(/\/+$/, '')
  const jobs: Promise<unknown>[] = []
  if (base) jobs.push(fetcher(`${base}/models`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.body?.cancel()))
  const auth = request.headers.get('authorization')
  if (auth && env.CLERK_JWT_ISSUER_DOMAIN && env.CONVEX_SITE_URL && env.MURMUR_WORKER_SECRET) {
    jobs.push(
      (async () => {
        const identity = await verifyClerkToken(auth, env.CLERK_JWT_ISSUER_DOMAIN, fetcher)
        if (identity) await grantFor({ siteUrl: env.CONVEX_SITE_URL, secret: env.MURMUR_WORKER_SECRET, fetcher }, identity)
      })()
    )
  }
  await Promise.allSettled(jobs)
}

export default {
  fetch: (request: Request, env: Env, ctx: Ctx) => handle(request, env, ctx)
}
