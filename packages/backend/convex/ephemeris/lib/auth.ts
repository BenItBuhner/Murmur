import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { can, entitlements, trialEnds, type Role } from './plans'

type Ctx = QueryCtx | MutationCtx

export function fail(code: string, message: string): never {
  throw new ConvexError({ code, message })
}

/** The signed-in Clerk account, or null. */
export async function viewer(ctx: Ctx): Promise<Doc<'ephemerisUsers'> | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  return ctx.db
    .query('ephemerisUsers')
    .withIndex('by_clerk', (q) => q.eq('clerkId', identity.subject))
    .unique()
}

export async function requireViewer(ctx: Ctx): Promise<Doc<'ephemerisUsers'>> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) fail('signed_out', 'Sign in to use your Ephemeris account.')
  const user = await viewer(ctx)
  if (!user) fail('no_account', 'Finish setting up your account first.')
  return user
}

export function normalEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).toLowerCase() : null
}

/**
 * The account for this sign-in, made on first use with a personal workspace on a Pro trial.
 * People whose email domain a company claimed join that company's workspace too.
 */
export async function ensureViewer(ctx: MutationCtx, now: number): Promise<Doc<'ephemerisUsers'>> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) fail('signed_out', 'Sign in to use your Ephemeris account.')
  const email = normalEmail(identity.email ?? '')
  const name = identity.name ?? identity.givenName ?? email.split('@')[0] ?? 'You'
  const existing = await viewer(ctx)
  if (existing) {
    if (email && (existing.email !== email || existing.name !== name))
      await ctx.db.patch('ephemerisUsers', existing._id, { email, name })
    return (await ctx.db.get('ephemerisUsers', existing._id))!
  }
  const userId = await ctx.db.insert('ephemerisUsers', {
    clerkId: identity.subject,
    email,
    name,
    createdAt: now
  })
  const workspaceId = await ctx.db.insert('ephemerisWorkspaces', {
    name: 'Personal',
    kind: 'personal',
    ownerId: userId,
    plan: 'pro',
    planState: 'trial',
    trialEndsAt: trialEnds(now),
    seats: 1,
    seq: 0,
    records: 0,
    createdAt: now
  })
  await ctx.db.insert('ephemerisMembers', { workspaceId, userId, role: 'owner', joinedAt: now })
  await audit(ctx, workspaceId, userId, 'workspace.created', 'Personal workspace', now)

  const domain = emailDomain(email)
  if (domain && identity.emailVerified !== false) {
    const company = await ctx.db
      .query('ephemerisWorkspaces')
      .withIndex('by_sso_domain', (q) => q.eq('ssoDomain', domain))
      .first()
    if (company && (await seatsLeft(ctx, company, now)) > 0) {
      await ctx.db.insert('ephemerisMembers', { workspaceId: company._id, userId, role: 'member', joinedAt: now })
      await audit(ctx, company._id, userId, 'member.joined', `${email} joined by email domain`, now)
    }
  }
  return (await ctx.db.get('ephemerisUsers', userId))!
}

export interface Membership {
  user: Doc<'ephemerisUsers'>
  workspace: Doc<'ephemerisWorkspaces'>
  member: Doc<'ephemerisMembers'>
}

/** The viewer's membership in a workspace; fails unless they belong (and, given an action, may do it). */
export async function requireMember(
  ctx: Ctx,
  workspaceId: Id<'ephemerisWorkspaces'>,
  action?: Parameters<typeof can>[1]
): Promise<Membership> {
  const user = await requireViewer(ctx)
  const workspace = await ctx.db.get('ephemerisWorkspaces', workspaceId)
  if (!workspace) fail('not_found', 'That workspace no longer exists.')
  const member = await ctx.db
    .query('ephemerisMembers')
    .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', user._id))
    .unique()
  if (!member) fail('forbidden', 'You are not in that workspace.')
  if (action && !can(member.role as Role, action))
    fail('forbidden', 'Only the workspace owner or an admin can do that.')
  return { user, workspace, member }
}

export async function memberCount(ctx: Ctx, workspaceId: Id<'ephemerisWorkspaces'>): Promise<number> {
  return (await ctx.db.query('ephemerisMembers').withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId)).collect()).length
}

export async function seatsLeft(ctx: Ctx, ws: Doc<'ephemerisWorkspaces'>, now: number): Promise<number> {
  const members = await memberCount(ctx, ws._id)
  const invites = (
    await ctx.db.query('ephemerisInvites').withIndex('by_workspace', (q) => q.eq('workspaceId', ws._id)).collect()
  ).filter((i) => i.expiresAt > now).length
  return entitlements(ws, now).seats - members - invites
}

export async function audit(
  ctx: MutationCtx,
  workspaceId: Id<'ephemerisWorkspaces'>,
  actorId: Id<'ephemerisUsers'> | undefined,
  action: string,
  detail: string,
  at: number
): Promise<void> {
  await ctx.db.insert('ephemerisAudit', { workspaceId, actorId, action, detail, at })
}
