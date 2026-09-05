import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { verifyClerkWebhook, WebhookVerificationError } from './lib/clerkWebhook'

const http = httpRouter()

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
