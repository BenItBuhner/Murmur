import type { HttpRouter } from 'convex/server'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { httpAction } from '../_generated/server'
import { parseStripeEvent, readStripeConfig, stripeRequest, subscriptionSnapshot, verifyStripeSignature } from './lib/stripe'

/** Ephemeris routes, mounted on Murmur's router under /ephemeris. */
export function addEphemerisRoutes(http: HttpRouter): void {

/**
 * Stripe's webhook. Events only say that something changed: the subscription is read back from
 * Stripe and applied as it stands, so retries and out-of-order deliveries settle on the truth.
 */
http.route({
  path: '/ephemeris/stripe/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const c = readStripeConfig(process.env)
    if (!c?.webhookSecret) return new Response('billing not configured', { status: 503 })
    const body = await req.text()
    try {
      await verifyStripeSignature(body, req.headers.get('stripe-signature'), c.webhookSecret, Date.now())
    } catch {
      return new Response('bad signature', { status: 400 })
    }
    const event = parseStripeEvent(JSON.parse(body))
    let subscriptionId: string | null = null
    let hint: string | null = null
    if (event.type === 'checkout.session.completed') {
      subscriptionId = event.subscriptionId
      hint = event.workspaceId
    } else if (event.type !== 'ignored') {
      subscriptionId = event.subscription.id
      hint = event.subscription.workspaceId
    }
    if (!subscriptionId) return new Response('ignored', { status: 200 })
    const snapshot = subscriptionSnapshot(await stripeRequest<unknown>(c.secretKey, 'GET', `/v1/subscriptions/${subscriptionId}`))
    if (!snapshot) return new Response('unreadable subscription', { status: 200 })
    let workspaceId: Id<'ephemerisWorkspaces'> | null = null
    const named = snapshot.workspaceId ?? hint
    if (named) workspaceId = await ctx.runQuery(internal.ephemeris.billing.workspaceExists, { id: named })
    if (!workspaceId && snapshot.customerId)
      workspaceId = await ctx.runQuery(internal.ephemeris.billing.workspaceForCustomer, { customerId: snapshot.customerId })
    if (!workspaceId) return new Response('no workspace', { status: 200 })
    await ctx.runMutation(internal.ephemeris.billing.applySubscription, { workspaceId, snapshot })
    return new Response('ok', { status: 200 })
  })
})

}
