import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const planV = v.union(v.literal('free'), v.literal('pro'), v.literal('team'), v.literal('enterprise'))
export const planStateV = v.union(v.literal('trial'), v.literal('active'), v.literal('past_due'), v.literal('canceled'))
export const roleV = v.union(v.literal('owner'), v.literal('admin'), v.literal('member'))

/** Ephemeris tables, spread into the Murmur schema. Prefixed so Murmur's own tables are untouched. */
export const ephemerisTables = {
  /** One row per Clerk account (the same accounts Murmur uses). */
  ephemerisUsers: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.string(),
    createdAt: v.number()
  })
    .index('by_clerk', ['clerkId'])
    .index('by_email', ['email']),

  /**
   * Where missions live. Everyone has a personal workspace; teams share one. `seq` counts every
   * change synced into it, so a device asks for "everything after n".
   */
  ephemerisWorkspaces: defineTable({
    name: v.string(),
    kind: v.union(v.literal('personal'), v.literal('team')),
    ownerId: v.id('ephemerisUsers'),
    plan: planV,
    planState: planStateV,
    trialEndsAt: v.optional(v.number()),
    seats: v.number(),
    seq: v.number(),
    records: v.number(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    /** Enterprise: people signing in with this email domain join automatically. */
    ssoDomain: v.optional(v.string()),
    /** Enterprise: the only apps members may connect (catalog ids); absent = any. */
    allowedApps: v.optional(v.array(v.string())),
    /** Enterprise: meetings and notes older than this many days are removed. */
    retentionDays: v.optional(v.number()),
    createdAt: v.number()
  })
    .index('by_owner', ['ownerId'])
    .index('by_sso_domain', ['ssoDomain'])
    .index('by_stripe_customer', ['stripeCustomerId']),

  ephemerisMembers: defineTable({
    workspaceId: v.id('ephemerisWorkspaces'),
    userId: v.id('ephemerisUsers'),
    role: roleV,
    joinedAt: v.number()
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_user', ['userId'])
    .index('by_workspace_user', ['workspaceId', 'userId']),

  ephemerisInvites: defineTable({
    workspaceId: v.id('ephemerisWorkspaces'),
    email: v.string(),
    role: roleV,
    token: v.string(),
    invitedBy: v.id('ephemerisUsers'),
    createdAt: v.number(),
    expiresAt: v.number()
  })
    .index('by_token', ['token'])
    .index('by_workspace', ['workspaceId'])
    .index('by_email', ['email']),

  /**
   * The synced copy of a workspace's local database, one row per record (a mission, step, item,
   * meeting...). Last writer wins per record, by the client's clock and then device id; deletes
   * stay as tombstones so every device hears about them.
   */
  ephemerisRecords: defineTable({
    workspaceId: v.id('ephemerisWorkspaces'),
    table: v.string(),
    recordId: v.string(),
    data: v.union(v.string(), v.null()),
    version: v.number(),
    deviceId: v.string(),
    authorId: v.id('ephemerisUsers'),
    seq: v.number()
  })
    .index('by_workspace_seq', ['workspaceId', 'seq'])
    .index('by_workspace_record', ['workspaceId', 'table', 'recordId']),

  /** Who did what to a workspace itself (members, roles, policy, billing). */
  ephemerisAudit: defineTable({
    workspaceId: v.id('ephemerisWorkspaces'),
    actorId: v.optional(v.id('ephemerisUsers')),
    action: v.string(),
    detail: v.string(),
    at: v.number()
  }).index('by_workspace_at', ['workspaceId', 'at'])
}
