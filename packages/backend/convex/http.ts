import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { stripeWebhook } from './billing'
import { chatCompletions, format, models, transcriptions } from './gateway'
import { parseUsageRecords, workerAuthorized } from './lib/worker'
import { verifyClerkWebhook, WebhookVerificationError } from './lib/clerkWebhook'

const http = httpRouter()

/**
 * Managed inference for signed-in accounts (see gateway.ts). OpenAI-compatible so both apps use
 * the same client code they use for a user's own provider, with the Clerk JWT as the bearer token.
 */
http.route({ path: '/v1/models', method: 'GET', handler: models })
http.route({ path: '/v1/audio/transcriptions', method: 'POST', handler: transcriptions })
http.route({ path: '/v1/chat/completions', method: 'POST', handler: chatCompletions })
/** Murmur-native: the transcript in, the text to insert out (see gateway.ts `format`). */
http.route({ path: '/v1/format', method: 'POST', handler: format })

/**
 * The inference Worker (apps/inference-worker) -> Convex. The Worker serves /v1/* itself and only
 * asks Convex for an account's allowance (cached for minutes) and reports usage in batches, both
 * with MURMUR_WORKER_SECRET as the bearer token. Without the secret set these answer 503.
 */
http.route({
  path: '/worker/grant',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const denied = workerAuthorized(request, process.env.MURMUR_WORKER_SECRET)
    if (denied) return denied
    let body: { clerkId?: unknown; email?: unknown; emailVerified?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return new Response('Body must be JSON', { status: 400 })
    }
    if (typeof body?.clerkId !== 'string' || !body.clerkId) return new Response('"clerkId" is required', { status: 400 })
    const grant = await ctx.runMutation(internal.inference.workerGrant, {
      clerkId: body.clerkId,
      email: typeof body.email === 'string' ? body.email : undefined,
      emailVerified: typeof body.emailVerified === 'boolean' ? body.emailVerified : undefined
    })
    return new Response(JSON.stringify(grant), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

http.route({
  path: '/worker/usage',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const denied = workerAuthorized(request, process.env.MURMUR_WORKER_SECRET)
    if (denied) return denied
    let body: { records?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return new Response('Body must be JSON', { status: 400 })
    }
    const records = parseUsageRecords(body?.records)
    if (!records) return new Response('"records" must be an array of usage records', { status: 400 })
    const result = await ctx.runMutation(internal.inference.recordBatch, { records })
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

/** Stripe -> Convex subscription sync (see billing.ts `stripeWebhook` for the events and secret). */
http.route({ path: '/stripe/webhook', method: 'POST', handler: stripeWebhook })

/**
 * Clerk -> Convex user sync. Point a Clerk webhook endpoint at
 * https://<deployment>.convex.site/clerk/webhook subscribed to user.created, user.updated and
 * user.deleted, and set CLERK_WEBHOOK_SIGNING_SECRET in the Convex deployment's environment.
 */
http.route({
  path: '/clerk/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET
    if (!secret) {
      console.error('CLERK_WEBHOOK_SIGNING_SECRET is not set; refusing webhook')
      return new Response('Webhook not configured', { status: 500 })
    }
    const payload = await request.text()
    let event
    try {
      event = verifyClerkWebhook(
        payload,
        {
          id: request.headers.get('svix-id'),
          timestamp: request.headers.get('svix-timestamp'),
          signature: request.headers.get('svix-signature')
        },
        secret
      )
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return new Response(`Invalid webhook: ${err.message}`, { status: 400 })
      }
      throw err
    }

    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkId: event.clerkId,
          email: event.email,
          name: event.name,
          imageUrl: event.imageUrl
        })
        break
      case 'user.deleted':
        await ctx.runMutation(internal.users.purgeByClerkId, { clerkId: event.clerkId })
        break
      case 'ignored':
        break
    }
    return new Response(null, { status: 200 })
  })
})

export default http
