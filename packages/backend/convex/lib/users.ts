import type { UserIdentity } from 'convex/server'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { UserDto } from './validators'

export interface ClerkProfile {
  email?: string
  name?: string
  imageUrl?: string
}

export async function findUserByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
    .unique()
}

export function profileFromIdentity(identity: UserIdentity): ClerkProfile {
  const fallbackName = [identity.givenName, identity.familyName].filter(Boolean).join(' ').trim()
  const name = identity.name?.trim() || fallbackName || undefined
  return {
    email: identity.email ?? undefined,
    name,
    imageUrl: identity.pictureUrl ?? undefined
  }
}

/**
 * Insert or refresh the user row for a Clerk id. Profile fields only overwrite stored values when
 * the caller actually knows them, so a JWT without an email claim never blanks a webhook-provided one.
 */
export async function upsertUser(
  ctx: MutationCtx,
  clerkId: string,
  profile: ClerkProfile,
  now: number
): Promise<Doc<'users'>> {
  const existing = await findUserByClerkId(ctx, clerkId)
  if (existing) {
    const patch: Partial<Doc<'users'>> = {}
    if (profile.email !== undefined && profile.email !== existing.email) patch.email = profile.email
    if (profile.name !== undefined && profile.name !== existing.name) patch.name = profile.name
    if (profile.imageUrl !== undefined && profile.imageUrl !== existing.imageUrl)
      patch.imageUrl = profile.imageUrl
    if (Object.keys(patch).length === 0) return existing
    await ctx.db.patch('users', existing._id, { ...patch, updatedAt: now })
    return { ...existing, ...patch, updatedAt: now }
  }
  const id = await ctx.db.insert('users', {
    clerkId,
    email: profile.email,
    name: profile.name,
    imageUrl: profile.imageUrl,
    createdAt: now,
    updatedAt: now
  })
  const inserted = await ctx.db.get('users', id)
  if (!inserted) throw new Error('Failed to create user')
  return inserted
}

/** Remove every record owned by a user, then the user itself. Used for account deletion. */
export async function purgeUserData(ctx: MutationCtx, userId: Id<'users'>): Promise<void> {
  const [devices, dictionaryEntries, snippets, appRules, preferences, stats, historyEntries] =
    await Promise.all([
      ctx.db
        .query('devices')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('dictionaryEntries')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('snippets')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('appRules')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('preferences')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('stats')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('historyEntries')
        .withIndex('by_user_and_createdAt', (q) => q.eq('userId', userId))
        .collect()
    ])
  for (const doc of devices) await ctx.db.delete('devices', doc._id)
  for (const doc of dictionaryEntries) await ctx.db.delete('dictionaryEntries', doc._id)
  for (const doc of snippets) await ctx.db.delete('snippets', doc._id)
  for (const doc of appRules) await ctx.db.delete('appRules', doc._id)
  for (const doc of preferences) await ctx.db.delete('preferences', doc._id)
  for (const doc of stats) await ctx.db.delete('stats', doc._id)
  for (const doc of historyEntries) await ctx.db.delete('historyEntries', doc._id)
  await ctx.db.delete('users', userId)
}

export function toUserDto(user: Doc<'users'>): UserDto {
  return {
    id: user._id,
    clerkId: user.clerkId,
    email: user.email,
    name: user.name,
    imageUrl: user.imageUrl,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingVersion: user.onboardingVersion,
    createdAt: user.createdAt
  }
}
