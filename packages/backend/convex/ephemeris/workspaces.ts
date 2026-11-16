import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { mutation, query, type MutationCtx } from '../_generated/server'
import { audit, emailDomain, ensureViewer, fail, normalEmail, requireMember, requireViewer, seatsLeft } from './lib/auth'
import { DAY_MS, entitlements, trialEnds } from './lib/plans'
import { roleV } from './tables'

const INVITE_DAYS = 14
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function token(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ')
  if (!n) fail('invalid', 'Give the workspace a name.')
  if (n.length > 60) fail('invalid', 'Keep the name under 60 characters.')
  return n
}

/** A shared workspace for a team, on a 14-day Team trial with five seats. */
export const createTeam = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const now = Date.now()
    const user = await ensureViewer(ctx, now)
    const workspaceId = await ctx.db.insert('ephemerisWorkspaces', {
      name: cleanName(name),
      kind: 'team',
      ownerId: user._id,
      plan: 'team',
      planState: 'trial',
      trialEndsAt: trialEnds(now),
      seats: 5,
      seq: 0,
      records: 0,
      createdAt: now
    })
    await ctx.db.insert('ephemerisMembers', { workspaceId, userId: user._id, role: 'owner', joinedAt: now })
    await audit(ctx, workspaceId, user._id, 'workspace.created', cleanName(name), now)
    return workspaceId
  }
})

export const rename = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), name: v.string() },
  handler: async (ctx, { workspaceId, name }) => {
    const { user } = await requireMember(ctx, workspaceId, 'rename')
    await ctx.db.patch('ephemerisWorkspaces', workspaceId, { name: cleanName(name) })
    await audit(ctx, workspaceId, user._id, 'workspace.renamed', cleanName(name), Date.now())
  }
})

/** The people in a workspace and the invites still open. */
export const members = query({
  args: { workspaceId: v.id('ephemerisWorkspaces') },
  handler: async (ctx, { workspaceId }) => {
    const { workspace, member: me } = await requireMember(ctx, workspaceId)
    const now = Date.now()
    const rows = await ctx.db.query('ephemerisMembers').withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId)).collect()
    const people: {
      userId: (typeof rows)[number]['userId']
      name: string
      email: string
      role: (typeof rows)[number]['role']
      joinedAt: number
      you: boolean
    }[] = []
    for (const m of rows) {
      const u = await ctx.db.get('ephemerisUsers', m.userId)
      if (u) people.push({ userId: u._id, name: u.name, email: u.email, role: m.role, joinedAt: m.joinedAt, you: m.userId === me.userId })
    }
    const invites =
      me.role === 'member'
        ? []
        : (await ctx.db.query('ephemerisInvites').withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId)).collect())
            .filter((i) => i.expiresAt > now)
            .map((i) => ({ id: i._id, email: i.email, role: i.role, token: i.token, expiresAt: i.expiresAt }))
    return {
      people,
      invites,
      seats: entitlements(workspace, now).seats,
      seatsLeft: await seatsLeft(ctx, workspace, now),
      policy: { ssoDomain: workspace.ssoDomain ?? null, allowedApps: workspace.allowedApps ?? null, retentionDays: workspace.retentionDays ?? null }
    }
  }
})

/** Invites someone by email. They see it in Ephemeris when they sign in with that email, or open the link. */
export const invite = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), email: v.string(), role: v.optional(roleV) },
  handler: async (ctx, { workspaceId, email, role }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId, 'invite')
    const now = Date.now()
    if (workspace.kind === 'personal') fail('invalid', 'Personal workspaces are just for you. Make a team to work with others.')
    const addr = normalEmail(email)
    if (!EMAIL.test(addr)) fail('invalid', 'That doesnâ€™t look like an email address.')
    if (role === 'owner') fail('invalid', 'A workspace has one owner.')
    const existing = await ctx.db.query('ephemerisInvites').withIndex('by_email', (q) => q.eq('email', addr)).collect()
    const open = existing.find((i) => i.workspaceId === workspaceId && i.expiresAt > now)
    if (open) return { token: open.token, reused: true }
    const already = await ctx.db.query('ephemerisUsers').withIndex('by_email', (q) => q.eq('email', addr)).first()
    if (already) {
      const m = await ctx.db
        .query('ephemerisMembers')
        .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', already._id))
        .unique()
      if (m) fail('invalid', `${addr} is already in this workspace.`)
    }
    if ((await seatsLeft(ctx, workspace, now)) <= 0)
      fail('seats', 'Every seat is taken. Add seats in billing, or remove someone first.')
    const t = token()
    await ctx.db.insert('ephemerisInvites', {
      workspaceId,
      email: addr,
      role: role ?? 'member',
      token: t,
      invitedBy: user._id,
      createdAt: now,
      expiresAt: now + INVITE_DAYS * DAY_MS
    })
    await audit(ctx, workspaceId, user._id, 'member.invited', `${addr} as ${role ?? 'member'}`, now)
    return { token: t, reused: false }
  }
})

export const revokeInvite = mutation({
  args: { inviteId: v.id('ephemerisInvites') },
  handler: async (ctx, { inviteId }) => {
    const inv = await ctx.db.get('ephemerisInvites', inviteId)
    if (!inv) return
    const { user } = await requireMember(ctx, inv.workspaceId, 'invite')
    await ctx.db.delete('ephemerisInvites', inviteId)
    await audit(ctx, inv.workspaceId, user._id, 'invite.revoked', inv.email, Date.now())
  }
})

/** Joins the workspace an invite is for. The invite may name any of the person's addresses only by link. */
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token: t }) => {
    const now = Date.now()
    const user = await ensureViewer(ctx, now)
    const inv = await ctx.db.query('ephemerisInvites').withIndex('by_token', (q) => q.eq('token', t)).unique()
    if (!inv || inv.expiresAt < now) fail('not_found', 'That invite has expired or was withdrawn. Ask for a new one.')
    const existing = await ctx.db
      .query('ephemerisMembers')
      .withIndex('by_workspace_user', (q) => q.eq('workspaceId', inv.workspaceId).eq('userId', user._id))
      .unique()
    if (!existing) await ctx.db.insert('ephemerisMembers', { workspaceId: inv.workspaceId, userId: user._id, role: inv.role, joinedAt: now })
    await ctx.db.delete('ephemerisInvites', inv._id)
    await audit(ctx, inv.workspaceId, user._id, 'member.joined', `${user.email} accepted an invite`, now)
    return inv.workspaceId
  }
})

export const declineInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token: t }) => {
    const user = await requireViewer(ctx)
    const inv = await ctx.db.query('ephemerisInvites').withIndex('by_token', (q) => q.eq('token', t)).unique()
    if (!inv || inv.email !== user.email) return
    await ctx.db.delete('ephemerisInvites', inv._id)
    await audit(ctx, inv.workspaceId, user._id, 'invite.declined', user.email, Date.now())
  }
})

export const setRole = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), userId: v.id('ephemerisUsers'), role: roleV },
  handler: async (ctx, { workspaceId, userId, role }) => {
    const { user, member: me } = await requireMember(ctx, workspaceId, 'remove')
    const target = await ctx.db
      .query('ephemerisMembers')
      .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', userId))
      .unique()
    if (!target) fail('not_found', 'They are not in this workspace.')
    if (target.role === 'owner') fail('forbidden', 'The ownerâ€™s role canâ€™t change. Transfer ownership instead.')
    if (role === 'owner') {
      if (me.role !== 'owner') fail('forbidden', 'Only the owner can hand over the workspace.')
      await ctx.db.patch('ephemerisMembers', target._id, { role: 'owner' })
      await ctx.db.patch('ephemerisMembers', me._id, { role: 'admin' })
      await ctx.db.patch('ephemerisWorkspaces', workspaceId, { ownerId: userId })
    } else {
      await ctx.db.patch('ephemerisMembers', target._id, { role })
    }
    await audit(ctx, workspaceId, user._id, 'member.role', `${userId} is now ${role}`, Date.now())
  }
})

async function removeMembership(
  ctx: MutationCtx,
  workspaceId: Id<'ephemerisWorkspaces'>,
  userId: Id<'ephemerisUsers'>
): Promise<void> {
  const m = await ctx.db
    .query('ephemerisMembers')
    .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  if (m) await ctx.db.delete('ephemerisMembers', m._id)
}

export const removeMember = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), userId: v.id('ephemerisUsers') },
  handler: async (ctx, { workspaceId, userId }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId, 'remove')
    if (workspace.ownerId === userId) fail('forbidden', 'The owner canâ€™t be removed.')
    await removeMembership(ctx, workspaceId, userId)
    await audit(ctx, workspaceId, user._id, 'member.removed', String(userId), Date.now())
  }
})

export const leave = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces') },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId)
    if (workspace.kind === 'personal') fail('invalid', 'You canâ€™t leave your personal workspace.')
    if (workspace.ownerId === user._id) fail('forbidden', 'Hand the workspace to someone else before leaving.')
    await removeMembership(ctx, workspaceId, user._id)
    await audit(ctx, workspaceId, user._id, 'member.left', user.email, Date.now())
  }
})

/** Company controls, on Enterprise: join by email domain, which apps members may connect, retention. */
export const setPolicy = mutation({
  args: {
    workspaceId: v.id('ephemerisWorkspaces'),
    ssoDomain: v.optional(v.union(v.string(), v.null())),
    allowedApps: v.optional(v.union(v.array(v.string()), v.null())),
    retentionDays: v.optional(v.union(v.number(), v.null()))
  },
  handler: async (ctx, { workspaceId, ssoDomain, allowedApps, retentionDays }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId, 'policy')
    const now = Date.now()
    if (!entitlements(workspace, now).companyControls) fail('plan', 'Company controls come with Enterprise.')
    const patch: Record<string, unknown> = {}
    if (ssoDomain !== undefined) {
      const d = ssoDomain?.trim().toLowerCase().replace(/^@/, '') || undefined
      if (d) {
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) fail('invalid', 'That doesnâ€™t look like a domain.')
        if (emailDomain(user.email) !== d) fail('forbidden', 'You can only claim the domain of your own email address.')
        const taken = await ctx.db.query('ephemerisWorkspaces').withIndex('by_sso_domain', (q) => q.eq('ssoDomain', d)).first()
        if (taken && taken._id !== workspaceId) fail('invalid', 'Another workspace already claimed that domain.')
      }
      patch.ssoDomain = d
    }
    if (allowedApps !== undefined) patch.allowedApps = allowedApps ? [...new Set(allowedApps.map((a) => a.trim()).filter(Boolean))] : undefined
    if (retentionDays !== undefined) {
      if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 7))
        fail('invalid', 'Keep at least seven days.')
      patch.retentionDays = retentionDays ?? undefined
    }
    await ctx.db.patch('ephemerisWorkspaces', workspaceId, patch)
    await audit(ctx, workspaceId, user._id, 'policy.changed', JSON.stringify(patch), now)
  }
})

export const auditLog = query({
  args: { workspaceId: v.id('ephemerisWorkspaces'), limit: v.optional(v.number()) },
  handler: async (ctx, { workspaceId, limit }) => {
    await requireMember(ctx, workspaceId, 'ephemerisAudit')
    const rows = await ctx.db
      .query('ephemerisAudit')
      .withIndex('by_workspace_at', (q) => q.eq('workspaceId', workspaceId))
      .order('desc')
      .take(Math.min(500, Math.max(1, limit ?? 100)))
    const out: { action: string; detail: string; at: number; actor: string }[] = []
    for (const r of rows) {
      const actor = r.actorId ? await ctx.db.get('ephemerisUsers', r.actorId) : null
      out.push({ action: r.action, detail: r.detail, at: r.at, actor: actor?.name ?? 'Ephemeris' })
    }
    return out
  }
})
