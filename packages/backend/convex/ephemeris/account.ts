import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { mutation, query, type QueryCtx } from '../_generated/server'
import { ensureViewer, normalEmail, viewer } from './lib/auth'
import { PRICES, entitlements, type Role } from './lib/plans'

export interface WorkspaceSummary {
  id: string
  name: string
  kind: 'personal' | 'team'
  role: Role
  plan: Doc<'ephemerisWorkspaces'>['plan']
  planState: Doc<'ephemerisWorkspaces'>['planState']
  trialEndsAt: number | null
  members: number
  records: number
  entitlements: ReturnType<typeof entitlements>
  billing: boolean
}

async function summaries(ctx: QueryCtx, user: Doc<'ephemerisUsers'>, now: number): Promise<WorkspaceSummary[]> {
  const memberships = await ctx.db.query('ephemerisMembers').withIndex('by_user', (q) => q.eq('userId', user._id)).collect()
  const out: WorkspaceSummary[] = []
  for (const m of memberships) {
    const ws = await ctx.db.get('ephemerisWorkspaces', m.workspaceId)
    if (!ws) continue
    const members = await ctx.db.query('ephemerisMembers').withIndex('by_workspace', (q) => q.eq('workspaceId', ws._id)).collect()
    out.push({
      id: ws._id,
      name: ws.name,
      kind: ws.kind,
      role: m.role,
      plan: ws.plan,
      planState: ws.planState,
      trialEndsAt: ws.trialEndsAt ?? null,
      members: members.length,
      records: ws.records,
      entitlements: entitlements(ws, now),
      billing: !!ws.stripeCustomerId
    })
  }
  // Personal first, then teams by name.
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'personal' ? -1 : 1))
}

async function pendingInvites(ctx: QueryCtx, email: string, now: number) {
  const invites = await ctx.db.query('ephemerisInvites').withIndex('by_email', (q) => q.eq('email', email)).collect()
  const out: { token: string; workspace: string; role: (typeof invites)[number]['role']; from: string }[] = []
  for (const i of invites) {
    if (i.expiresAt < now) continue
    const ws = await ctx.db.get('ephemerisWorkspaces', i.workspaceId)
    const from = await ctx.db.get('ephemerisUsers', i.invitedBy)
    if (ws) out.push({ token: i.token, workspace: ws.name, role: i.role, from: from?.name ?? 'Someone' })
  }
  return out
}

/** Everything the app shows about the account: who you are, your workspaces, invites waiting for you. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx)
    if (!user) return null
    const now = Date.now()
    return {
      user: { id: user._id, email: user.email, name: user.name },
      workspaces: await summaries(ctx, user, now),
      invites: await pendingInvites(ctx, user.email, now),
      prices: PRICES
    }
  }
})

/** Makes the account on first sign-in (with a personal workspace on a Pro trial); safe to call every launch. */
export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const user = await ensureViewer(ctx, now)
    return { userId: user._id, workspaces: await summaries(ctx, user, now) }
  }
})

/** Who a workspace's invite is for, to show before accepting. */
export const invite = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const i = await ctx.db.query('ephemerisInvites').withIndex('by_token', (q) => q.eq('token', token)).unique()
    if (!i || i.expiresAt < Date.now()) return null
    const ws = await ctx.db.get('ephemerisWorkspaces', i.workspaceId)
    return ws ? { workspace: ws.name, email: normalEmail(i.email), role: i.role } : null
  }
})
