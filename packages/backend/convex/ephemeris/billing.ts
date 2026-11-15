import { v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { action, internalMutation, internalQuery } from '../_generated/server'
import { audit, fail, requireMember } from './lib/auth'
import { can } from './lib/plans'
import {
  checkoutSessionParams,
  planForPrice,
  planStateFor,
  portalSessionParams,
  readStripeConfig,
  stripeRequest,
  subscriptionSnapshot,
  type StripeConfig,
  type SubscriptionSnapshot
} from './lib/stripe'

function config(): StripeConfig {
  const c = readStripeConfig(process.env)
  if (!c || !c.siteUrl) fail('billing_off', 'Billing isnâ€™t set up on this server yet.')
  return c
}

/** What billing needs to know about the viewer's place in a workspace. */
export const billingContext = internalQuery({
  args: { workspaceId: v.id('ephemerisWorkspaces') },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace, member } = await requireMember(ctx, workspaceId)
    if (!can(member.role, 'billing')) fail('forbidden', 'Only the workspace owner handles billing.')
    const members = await ctx.db.query('ephemerisMembers').withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId)).collect()
    return {
      email: user.email,
      kind: workspace.kind,
      customerId: workspace.stripeCustomerId ?? null,
      subscriptionId: workspace.stripeSubscriptionId ?? null,
      members: members.length,
      seats: workspace.seats
    }
  }
})

/** A Stripe Checkout page for Pro (personal) or Team (per seat). Opens in the browser. */
export const checkout = action({
  args: {
    workspaceId: v.id('ephemerisWorkspaces'),
    interval: v.union(v.literal('month'), v.literal('year')),
    seats: v.optional(v.number())
  },
  handler: async (ctx, { workspaceId, interval, seats }): Promise<{ url: string }> => {
    const c = config()
    const w = await ctx.runQuery(internal.ephemeris.billing.billingContext, { workspaceId })
    if (w.subscriptionId) fail('invalid', 'This workspace already has a subscription. Manage it instead.')
    const plan = w.kind === 'team' ? 'team' : 'pro'
    const session = await stripeRequest<{ url?: string }>(
      c.secretKey,
      'POST',
      '/v1/checkout/sessions',
      checkoutSessionParams(c, {
        workspaceId,
        plan,
        interval,
        seats: Math.max(w.members, Math.round(seats ?? w.seats)),
        email: w.email,
        customerId: w.customerId ?? undefined
      })
    )
    if (!session.url) fail('stripe', 'Stripe didnâ€™t return a checkout page.')
    return { url: session.url }
  }
})

/** Stripe's billing portal: cards, invoices, switching monthly and yearly, canceling. */
export const portal = action({
  args: { workspaceId: v.id('ephemerisWorkspaces') },
  handler: async (ctx, { workspaceId }): Promise<{ url: string }> => {
    const c = config()
    const w = await ctx.runQuery(internal.ephemeris.billing.billingContext, { workspaceId })
    if (!w.customerId) fail('invalid', 'Thereâ€™s no billing account for this workspace yet.')
    const session = await stripeRequest<{ url?: string }>(c.secretKey, 'POST', '/v1/billing_portal/sessions', portalSessionParams(c, w.customerId))
    if (!session.url) fail('stripe', 'Stripe didnâ€™t return a portal page.')
    return { url: session.url }
  }
})

/** Changes how many seats a Team workspace pays for; Stripe prorates. */
export const setSeats = action({
  args: { workspaceId: v.id('ephemerisWorkspaces'), seats: v.number() },
  handler: async (ctx, { workspaceId, seats }): Promise<{ seats: number }> => {
    const c = config()
    const w = await ctx.runQuery(internal.ephemeris.billing.billingContext, { workspaceId })
    if (w.kind !== 'team' || !w.subscriptionId) fail('invalid', 'Seats apply to a paid Team workspace.')
    const n = Math.round(seats)
    if (!Number.isFinite(n) || n < w.members) fail('invalid', `You have ${w.members} people; remove someone before going below that.`)
    const sub = await stripeRequest<unknown>(c.secretKey, 'GET', `/v1/subscriptions/${w.subscriptionId}`)
    const snap = subscriptionSnapshot(sub)
    const itemId = (sub as { items?: { data?: Array<{ id?: string }> } }).items?.data?.[0]?.id
    if (!snap || !itemId) fail('stripe', 'Couldnâ€™t read the subscription from Stripe.')
    const updated = await stripeRequest<unknown>(c.secretKey, 'POST', `/v1/subscriptions/${w.subscriptionId}`, {
      items: { 0: { id: itemId, quantity: n } },
      proration_behavior: 'create_prorations'
    })
    const after = subscriptionSnapshot(updated)
    if (after) await ctx.runMutation(internal.ephemeris.billing.applySubscription, { workspaceId, snapshot: after })
    return { seats: n }
  }
})

const snapshotV = v.object({
  id: v.string(),
  status: v.string(),
  priceId: v.string(),
  quantity: v.number(),
  customerId: v.union(v.string(), v.null()),
  workspaceId: v.union(v.string(), v.null())
})

/** Sets a workspace's plan from the subscription as Stripe has it now. */
export const applySubscription = internalMutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), snapshot: snapshotV },
  handler: async (ctx, { workspaceId, snapshot }) => {
    const ws = await ctx.db.get('ephemerisWorkspaces', workspaceId)
    if (!ws) return
    const c = readStripeConfig(process.env)
    const plan = c ? planForPrice(c, snapshot.priceId) : null
    const state = planStateFor(snapshot.status as SubscriptionSnapshot['status'])
    const now = Date.now()
    if (state === 'canceled') {
      // Only the subscription the workspace holds may end it (an old one ending must not).
      if (ws.stripeSubscriptionId && ws.stripeSubscriptionId !== snapshot.id) return
      await ctx.db.patch('ephemerisWorkspaces', workspaceId, {
        planState: 'canceled',
        stripeSubscriptionId: undefined,
        stripeCustomerId: snapshot.customerId ?? ws.stripeCustomerId
      })
    } else {
      await ctx.db.patch('ephemerisWorkspaces', workspaceId, {
        plan: plan ?? ws.plan,
        planState: state,
        trialEndsAt: undefined,
        seats: ws.kind === 'team' ? snapshot.quantity : 1,
        stripeSubscriptionId: snapshot.id,
        stripeCustomerId: snapshot.customerId ?? ws.stripeCustomerId
      })
    }
    await audit(ctx, workspaceId, undefined, 'billing.updated', `${plan ?? ws.plan} ${state}, ${snapshot.quantity} seat(s)`, now)
  }
})

export const workspaceForCustomer = internalQuery({
  args: { customerId: v.string() },
  handler: async (ctx, { customerId }): Promise<Id<'ephemerisWorkspaces'> | null> => {
    const ws = await ctx.db.query('ephemerisWorkspaces').withIndex('by_stripe_customer', (q) => q.eq('stripeCustomerId', customerId)).first()
    return ws?._id ?? null
  }
})

export const workspaceExists = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<Id<'ephemerisWorkspaces'> | null> => {
    const wid = ctx.db.normalizeId('ephemerisWorkspaces', id)
    return wid && (await ctx.db.get('ephemerisWorkspaces', wid)) ? wid : null
  }
})
