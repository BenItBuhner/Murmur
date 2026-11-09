import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { authedMutation, authedQuery } from './lib/functions'

const MAX_TEXT = 4000
/** How long rows and their audio are kept (careful transcripts can be asked for until then). */
export const KEEP_MS = 7 * 86_400_000

type Row = Doc<'timelineChunks'>
const dto = ({ _id, userId: _u, _creationTime: _c, audio, taken: _t, ...c }: Row) => ({
  id: _id,
  ...c,
  hasAudio: !!audio
})

async function userByClerk(
  ctx: { db: MutationCtx['db'] },
  clerkId: string
): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
    .unique()
}

async function drop(ctx: MutationCtx, row: Row): Promise<void> {
  if (row.audio) await ctx.storage.delete(row.audio).catch(() => undefined)
  await ctx.db.delete('timelineChunks', row._id)
}

/** Chunks the desktop has not taken yet, oldest first. */
export const pending = authedQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (!ctx.user) return []
    const user = ctx.user
    const rows = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user_taken', (q) => q.eq('userId', user._id).eq('taken', false))
      .take(Math.min(Math.max(1, limit ?? 100), 200))
    return rows.map(dto)
  }
})

/** The desktop took these into its timeline. Rows past the keep window go, with their audio. */
export const ack = authedMutation({
  args: { ids: v.array(v.id('timelineChunks')) },
  returns: v.object({ taken: v.number(), removed: v.number() }),
  handler: async (ctx, { ids }) => {
    let taken = 0
    for (const id of ids.slice(0, 200)) {
      const row = await ctx.db.get('timelineChunks', id)
      if (row && row.userId === ctx.user._id) {
        await ctx.db.patch('timelineChunks', id, { taken: true })
        taken++
      }
    }
    const stale = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user', (q) =>
        q.eq('userId', ctx.user._id).lt('_creationTime', Date.now() - KEEP_MS)
      )
      .take(100)
    for (const r of stale) await drop(ctx, r)
    return { taken, removed: stale.length }
  }
})

const chunkArgs = v.object({
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

/** Keeps what /v1/timeline/audio transcribed, and its audio. Idempotent per (device, start). */
export const store = internalMutation({
  args: { clerkId: v.string(), chunk: chunkArgs, audio: v.optional(v.id('_storage')) },
  handler: async (ctx, { clerkId, chunk, audio }) => {
    const user = await userByClerk(ctx, clerkId)
    if (!user) {
      if (audio) await ctx.storage.delete(audio)
      return null
    }
    const row = {
      ...chunk,
      userId: user._id,
      device: chunk.device.slice(0, 120),
      text: chunk.text.slice(0, MAX_TEXT),
      audio,
      taken: false
    }
    const existing = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user_device_start', (q) =>
        q.eq('userId', user._id).eq('device', row.device).eq('startedAt', row.startedAt)
      )
      .unique()
    if (existing) {
      if (existing.audio && existing.audio !== audio) await ctx.storage.delete(existing.audio)
      await ctx.db.patch('timelineChunks', existing._id, row)
    } else await ctx.db.insert('timelineChunks', row)
    return null
  }
})

/** One chunk of this account, by device and start, with the text just before it (for context). */
export const forRefine = internalQuery({
  args: { clerkId: v.string(), device: v.string(), startedAt: v.string() },
  handler: async (ctx, { clerkId, device, startedAt }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique()
    if (!user) return null
    const row = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user_device_start', (q) =>
        q.eq('userId', user._id).eq('device', device).eq('startedAt', startedAt)
      )
      .unique()
    if (!row) return null
    const before = await ctx.db
      .query('timelineChunks')
      .withIndex('by_user_device_start', (q) =>
        q.eq('userId', user._id).eq('device', device).lt('startedAt', startedAt)
      )
      .order('desc')
      .first()
    return {
      id: row._id as Id<'timelineChunks'>,
      audio: row.audio ?? null,
      refinedText: row.refinedText ?? null,
      before: before ? (before.refinedText ?? before.text) : ''
    }
  }
})

export const saveRefined = internalMutation({
  args: { id: v.id('timelineChunks'), text: v.string() },
  handler: async (ctx, { id, text }) => {
    const row = await ctx.db.get('timelineChunks', id)
    if (row && row.refinedText == null)
      await ctx.db.patch('timelineChunks', id, { refinedText: text.slice(0, MAX_TEXT) })
    return null
  }
})
