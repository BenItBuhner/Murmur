import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { LIMITS } from './lib/limits'
import { historyEntryDtoValidator, historyEntryInputValidator, type HistoryEntryDto } from './lib/validators'

const DEFAULT_RECENT = 200
const MAX_RECENT = 500

function toDto(doc: Doc<'historyEntries'>, deviceName: string | undefined): HistoryEntryDto {
  return {
    id: doc._id,
    entryId: doc.entryId,
    deviceId: doc.deviceId,
    deviceName,
    createdAt: doc.createdAt,
    mode: doc.mode,
    rawText: doc.rawText,
    finalText: doc.finalText,
    wordCount: doc.wordCount,
    speechMs: doc.speechMs,
    appName: doc.appName,
    provider: doc.provider,
    model: doc.model,
    llmUsed: doc.llmUsed
  }
}

async function setHistoryCount(ctx: AuthedMutationCtx, count: number): Promise<void> {
  await ctx.db.patch('users', ctx.user._id, { historyCount: Math.max(0, count) })
}

/** Most recent dictations across all of the account's devices (history sync is opt-in). */
export const recent = authedQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(historyEntryDtoValidator),
  handler: async (ctx, args) => {
    if (!ctx.user) return []
    const limit = Math.min(MAX_RECENT, Math.max(1, Math.floor(args.limit ?? DEFAULT_RECENT)))
    const [docs, devices] = await Promise.all([
      ctx.db
        .query('historyEntries')
        .withIndex('by_user_and_createdAt', (q) => q.eq('userId', ctx.user!._id))
        .order('desc')
        .take(limit),
      ctx.db
        .query('devices')
        .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
        .collect()
    ])
    const names = new Map(devices.map((d) => [d.deviceId, d.name]))
    return docs.map((doc) => toDto(doc, names.get(doc.deviceId)))
  }
})

/** Idempotent batch push from a device; entries already known (by entryId) are skipped. */
export const push = authedMutation({
  args: { deviceId: v.string(), entries: v.array(historyEntryInputValidator) },
  returns: v.object({ inserted: v.number(), pruned: v.number() }),
  handler: async (ctx, args) => {
    if (args.entries.length > LIMITS.batch) throw new Error(`Push at most ${LIMITS.batch} entries per call`)
    let count = ctx.user.historyCount ?? 0
    let inserted = 0
    for (const entry of args.entries) {
      if (!entry.entryId.trim() || !entry.finalText.trim()) continue
      const existing = await ctx.db
        .query('historyEntries')
        .withIndex('by_user_and_entryId', (q) => q.eq('userId', ctx.user._id).eq('entryId', entry.entryId))
        .unique()
      if (existing) continue
      await ctx.db.insert('historyEntries', {
        userId: ctx.user._id,
        deviceId: args.deviceId,
        entryId: entry.entryId,
        createdAt: entry.createdAt,
        mode: entry.mode,
        rawText: entry.rawText?.slice(0, LIMITS.historyTextLength),
        finalText: entry.finalText.slice(0, LIMITS.historyTextLength),
        wordCount: entry.wordCount,
        speechMs: entry.speechMs,
        appName: entry.appName,
        provider: entry.provider,
        model: entry.model,
        llmUsed: entry.llmUsed
      })
      inserted++
      count++
    }
    let pruned = 0
    if (count > LIMITS.historyEntries) {
      const oldest = await ctx.db
        .query('historyEntries')
        .withIndex('by_user_and_createdAt', (q) => q.eq('userId', ctx.user._id))
        .order('asc')
        .take(count - LIMITS.historyEntries)
      for (const doc of oldest) await ctx.db.delete('historyEntries', doc._id)
      pruned = oldest.length
      count -= pruned
    }
    if (inserted || pruned || ctx.user.historyCount === undefined) await setHistoryCount(ctx, count)
    return { inserted, pruned }
  }
})

export const remove = authedMutation({
  args: { entryId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('historyEntries')
      .withIndex('by_user_and_entryId', (q) => q.eq('userId', ctx.user._id).eq('entryId', args.entryId))
      .unique()
    if (!doc) return false
    await ctx.db.delete('historyEntries', doc._id)
    await setHistoryCount(ctx, (ctx.user.historyCount ?? 1) - 1)
    return true
  }
})

/** Delete every synced history entry for the account. */
export const clear = authedMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('historyEntries')
      .withIndex('by_user_and_createdAt', (q) => q.eq('userId', ctx.user._id))
      .collect()
    for (const doc of docs) await ctx.db.delete('historyEntries', doc._id)
    await setHistoryCount(ctx, 0)
    return docs.length
  }
})
