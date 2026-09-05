import { customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions'
import type { Doc } from '../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../_generated/server'
import { findUserByClerkId, profileFromIdentity, upsertUser } from './users'

/**
 * Custom function wrappers are Murmur's row-level security. Every public function is built from one
 * of these so authentication and ownership are enforced in exactly one place.
 */

async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  return identity
}

/**
 * Authenticated query. `ctx.user` is `null` until the account has been provisioned by a mutation
 * (clients call `users.ensure` right after connecting), so queries return empty results instead of
 * failing during that first round-trip.
 */
export const authedQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const identity = await requireIdentity(ctx)
    const user = await findUserByClerkId(ctx, identity.subject)
    return { identity, user }
  })
)

/** Authenticated mutation. Provisions the user row on first contact so `ctx.user` is always present. */
export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const identity = await requireIdentity(ctx)
    const user = await upsertUser(ctx, identity.subject, profileFromIdentity(identity), Date.now())
    return { identity, user }
  })
)

export type AuthedQueryCtx = QueryCtx & { user: Doc<'users'> | null }
export type AuthedMutationCtx = MutationCtx & { user: Doc<'users'> }
