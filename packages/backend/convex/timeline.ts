import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { authedMutation, authedQuery } from './lib/functions'

const MAX_TEXT = 4000
/** How long rows and their audio are kept (careful transcripts can be asked for until then). */
export const KEEP_MS = 7 * 86_400_000

type Row = Doc<'timelineChunks'>
const dto = ({ _id, userId: _u, _creationTime: _c, audio, objectKey, taken: _t, ...c }: Row) => ({
  id: _id,
  ...c,
  objectKey: objectKey ?? null,
  hasAudio: !!(audio || objectKey)
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

async function drop(ctx: MutationCtx, row: Row): Promise<string | null> {
  if (row.audio) await ctx.storage.delete(row.audio).catch(() => undefined)
  await ctx.db.delete('timelineChunks', row._id)
  return row.objectKey ?? null
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
  args: {
    clerkId: v.string(),
    chunk: chunkArgs,
    /** Legacy only. The inference Worker does not send this; new audio is an R2 key. */
    audio: v.optional(v.id('_storage')),
    objectKey: v.optional(v.string())
  },
  returns: v.object({ replacedObjectKey: v.union(v.string(), v.null()) }),
  handler: async (ctx, { clerkId, chunk, audio, objectKey }) => {
    if (objectKey && !objectKey.startsWith(`timeline/${encodeURIComponent(clerkId)}/`))
      throw new Error('objectKey is not owned by this account')
    const user = await userByClerk(ctx, clerkId)
    if (!user) {
      if (audio) await ctx.storage.delete(audio)
      return { replacedObjectKey: null }
    }
    const row = {
      ...chunk,
      userId: user._id,
      device: chunk.device.slice(0, 120),
      text: chunk.text.slice(0, MAX_TEXT),
      audio,
      objectKey,
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
      const replaced = existing.objectKey && existing.objectKey !== objectKey ? existing.objectKey : null
      await ctx.db.patch('timelineChunks', existing._id, row)
      return { replacedObjectKey: replaced }
    }
    await ctx.db.insert('timelineChunks', row)
    return { replacedObjectKey: null }
  }
})

const SWEEP_BATCH = 50

/**
 * Deletes chunks, and their audio, once they are past [KEEP_MS]. `ack` used to be the only sweep,
 * so a desktop that never picked the timeline up left the wavs in file storage forever. One batch
 * per run; a backlog schedules the next batch. The text is the same week-long cache as the audio.
 */
export const sweepExpired = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    removed: v.number(),
    more: v.boolean(),
    /** R2 keys the caller (the inference Worker) still has to delete. Convex has no R2 binding. */
    objectKeys: v.array(v.string())
  }),
  handler: async (ctx, args) => {
    const cutoff = (args.now ?? Date.now()) - KEEP_MS
    const rows = await ctx.db.query('timelineChunks').order('asc').take(SWEEP_BATCH)
    let removed = 0
    const objectKeys: string[] = []
    for (const row of rows) {
      if (row._creationTime >= cutoff) return { removed, more: false, objectKeys }
      const key = await drop(ctx, row)
      if (key) objectKeys.push(key)
      removed++
    }
    const more = rows.length === SWEEP_BATCH
    if (more) await ctx.scheduler.runAfter(0, internal.timeline.sweepExpired, {})
    return { removed, more, objectKeys }
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
      objectKey: row.objectKey ?? null,
      refinedText: row.refinedText ?? null,
      before: before ? (before.refinedText ?? before.text) : ''
    }
  }
})

/**
 * One page of every file in Convex storage, oldest first. The migration script copies these to R2.
 * It does not delete anything.
 */
export const storagePage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.system.query('_storage').paginate({
      cursor,
      numItems: Math.min(Math.max(1, numItems), 50)
    })
    return {
      files: page.page.map((file) => ({
        id: file._id,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType ?? null
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone
    }
  }
})

/** A short-lived URL for one stored file. The migration downloads it outside Convex. */
export const storageUrl = internalAction({
  args: { id: v.id('_storage') },
  handler: async (ctx, { id }) => {
    return await ctx.storage.getUrl(id)
  }
})

/**
 * Point timeline rows that still reference this Convex file at the R2 key. The Convex file stays
 * until `dropStorage`, which the script calls only after the R2 object matches size and sha256.
 */
export const linkStorage = internalMutation({
  args: { storageId: v.id('_storage'), objectKey: v.string(), sha256: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const meta = await ctx.db.system.get(args.storageId)
    if (!meta) return { ok: false as const, reason: 'missing' }
    if (meta.sha256 !== args.sha256 || meta.size !== args.size)
      return { ok: false as const, reason: 'mismatch', sha256: meta.sha256, size: meta.size }
    const rows = await ctx.db
      .query('timelineChunks')
      .withIndex('by_audio', (q) => q.eq('audio', args.storageId))
      .take(20)
    for (const row of rows) await ctx.db.patch('timelineChunks', row._id, { objectKey: args.objectKey })
    return { ok: true as const, rows: rows.length }
  }
})

/** Delete the Convex file after the script has verified the R2 copy. A mismatch leaves it in place. */
export const dropStorage = internalMutation({
  args: { storageId: v.id('_storage'), objectKey: v.string(), sha256: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const meta = await ctx.db.system.get(args.storageId)
    if (!meta) return { ok: false as const, reason: 'missing' }
    if (meta.sha256 !== args.sha256 || meta.size !== args.size)
      return { ok: false as const, reason: 'mismatch', kept: true }
    const rows = await ctx.db
      .query('timelineChunks')
      .withIndex('by_audio', (q) => q.eq('audio', args.storageId))
      .take(20)
    if (rows.some((row) => row.objectKey !== args.objectKey))
      return { ok: false as const, reason: 'not-linked', kept: true }
    await ctx.storage.delete(args.storageId)
    for (const row of rows) await ctx.db.patch('timelineChunks', row._id, { audio: undefined })
    return { ok: true as const, rows: rows.length }
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
