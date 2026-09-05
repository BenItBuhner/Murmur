import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { daysBetween, nextStreak, requireDay } from './lib/streak'
import { statsDtoValidator, type StatsDto } from './lib/validators'

function toDto(doc: Doc<'stats'>): StatsDto {
  return {
    totalWords: doc.totalWords,
    totalSessions: doc.totalSessions,
    totalSpeechMs: doc.totalSpeechMs,
    streakDays: doc.streakDays,
    lastSessionDay: doc.lastSessionDay,
    updatedAt: doc.updatedAt
  }
}

async function loadStats(ctx: AuthedMutationCtx): Promise<Doc<'stats'> | null> {
  return await ctx.db
    .query('stats')
    .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
    .unique()
}

export const get = authedQuery({
  args: {},
  returns: v.union(statsDtoValidator, v.null()),
  handler: async (ctx) => {
    if (!ctx.user) return null
    const doc = await ctx.db
      .query('stats')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .unique()
    return doc ? toDto(doc) : null
  }
})

/** Count one finished dictation. `day` is the device's local calendar day. */
export const recordSession = authedMutation({
  args: { words: v.number(), speechMs: v.number(), day: v.string() },
  returns: statsDtoValidator,
  handler: async (ctx, args) => {
    const day = requireDay(args.day)
    const words = Math.max(0, Math.floor(args.words))
    const speechMs = Math.max(0, Math.floor(args.speechMs))
    const now = Date.now()
    const existing = await loadStats(ctx)
    if (existing) {
      const next = {
        totalWords: existing.totalWords + words,
        totalSessions: existing.totalSessions + 1,
        totalSpeechMs: existing.totalSpeechMs + speechMs,
        streakDays: nextStreak(existing, day),
        lastSessionDay: daysBetween(existing.lastSessionDay || day, day) >= 0 ? day : existing.lastSessionDay,
        updatedAt: now
      }
      await ctx.db.patch('stats', existing._id, next)
      return toDto({ ...existing, ...next })
    }
    const doc = {
      userId: ctx.user._id,
      totalWords: words,
      totalSessions: 1,
      totalSpeechMs: speechMs,
      streakDays: 1,
      lastSessionDay: day,
      updatedAt: now
    }
    const id = await ctx.db.insert('stats', doc)
    return toDto({ ...doc, _id: id, _creationTime: now })
  }
})

/** Fold the totals a device accumulated before it had an account into the account. */
export const importLocal = authedMutation({
  args: {
    totalWords: v.number(),
    totalSessions: v.number(),
    totalSpeechMs: v.number(),
    streakDays: v.number(),
    lastSessionDay: v.string()
  },
  returns: statsDtoValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const lastSessionDay = args.lastSessionDay ? requireDay(args.lastSessionDay) : ''
    const existing = await loadStats(ctx)
    if (existing) {
      const newer = lastSessionDay && (!existing.lastSessionDay || daysBetween(existing.lastSessionDay, lastSessionDay) > 0)
      const next = {
        totalWords: existing.totalWords + Math.max(0, args.totalWords),
        totalSessions: existing.totalSessions + Math.max(0, args.totalSessions),
        totalSpeechMs: existing.totalSpeechMs + Math.max(0, args.totalSpeechMs),
        streakDays: Math.max(existing.streakDays, args.streakDays),
        lastSessionDay: newer ? lastSessionDay : existing.lastSessionDay,
        updatedAt: now
      }
      await ctx.db.patch('stats', existing._id, next)
      return toDto({ ...existing, ...next })
    }
    const doc = {
      userId: ctx.user._id,
      totalWords: Math.max(0, args.totalWords),
      totalSessions: Math.max(0, args.totalSessions),
      totalSpeechMs: Math.max(0, args.totalSpeechMs),
      streakDays: Math.max(0, args.streakDays),
      lastSessionDay,
      updatedAt: now
    }
    const id = await ctx.db.insert('stats', doc)
    return toDto({ ...doc, _id: id, _creationTime: now })
  }
})
