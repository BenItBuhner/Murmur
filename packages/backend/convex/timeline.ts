import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { authedMutation, authedQuery } from './lib/functions'

const MAX_TEXT = 4000
const KEEP_MS = 14 * 86_400_000

/** Chunks waiting for a desktop, oldest first. */
export const pending = authedQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (!ctx.user) return []
    const user = ctx.user
    const rows = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(Math.min(Math.max(1, limit ?? 100), 200))
    return rows.map(({ _id, userId: _u, _creationTime: _c, ...c }) => ({ id: _id, ...c }))
  }
})

/** A desktop took these into its timeline; drop them, and anything stale. */
export const ack = authedMutation({
  args: { ids: v.array(v.id('timelineChunks')) },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, { ids }) => {
    let removed = 0
    for (const id of ids.slice(0, 200)) {
      const row = await ctx.db.get('timelineChunks', id)
      if (row && row.userId === ctx.user._id) {
        await ctx.db.delete('timelineChunks', id)
        removed++
      }
    }
    const cutoff = Date.now() - KEEP_MS
    const stale = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user._id).lt('_creationTime', cutoff))
      .take(100)
    for (const r of stale) await ctx.db.delete('timelineChunks', r._id)
    return { removed: removed + stale.length }
  }
})

/** Keeps what /v1/timeline/audio transcribed. Idempotent per (device, start). */
export const store = internalMutation({
  args: {
    clerkId: v.string(),
    chunk: v.object({
      device: v.string(),
      startedAt: v.string(),
      endedAt: v.string(),
      text: v.string(),
      engine: v.string(),
      rmsDb: v.number(),
      speechRatio: v.number(),
      speakers: v.number(),
      score: v.number(),
      tags: v.array(v.string())
    })
  },
  handler: async (ctx, { clerkId, chunk }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique()
    if (!user) return null
    const row = {
      ...chunk,
      userId: user._id,
      device: chunk.device.slice(0, 120),
      text: chunk.text.slice(0, MAX_TEXT)
    }
    const existing = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user_device_start', (q) =>
        q.eq('userId', user._id).eq('device', row.device).eq('startedAt', row.startedAt)
      )
      .unique()
    if (existing) await ctx.db.patch('timelineChunks', existing._id, row)
    else await ctx.db.insert('timelineChunks', row)
    return null
  }
})
