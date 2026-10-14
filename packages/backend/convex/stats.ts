import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { daysBetween, nextStreak, requireDay } from './lib/streak'
import { statsDtoValidator, type StatsDto } from './lib/validators'

export function toDto(doc: Doc<'stats'>): StatsDto {
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

const RECENT_SESSION_IDS = 100

/**
 * Count one finished dictation. `day` is the device's local calendar day. `sessionId` makes the
 * call idempotent so an offline queue can safely replay it.
 */
export const recordSession = authedMutation({
  args: {
    words: v.number(),
    speechMs: v.number(),
    day: v.string(),
    sessionId: v.optional(v.string())
  },
  returns: statsDtoValidator,
  handler: async (ctx, args) => {
    const day = requireDay(args.day)
    const words = Math.max(0, Math.floor(args.words))
    const speechMs = Math.max(0, Math.floor(args.speechMs))
    const now = Date.now()
    const existing = await loadStats(ctx)
    if (existing) {
      if (args.sessionId && existing.recentSessionIds?.includes(args.sessionId)) return toDto(existing)
      const recentSessionIds = args.sessionId
        ? [...(existing.recentSessionIds ?? []), args.sessionId].slice(-RECENT_SESSION_IDS)
        : existing.recentSessionIds
      const next = {
        totalWords: existing.totalWords + words,
        totalSessions: existing.totalSessions + 1,
        totalSpeechMs: existing.totalSpeechMs + speechMs,
        streakDays: nextStreak(existing, day),
        lastSessionDay:
          daysBetween(existing.lastSessionDay || day, day) >= 0 ? day : existing.lastSessionDay,
        recentSessionIds,
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
      recentSessionIds: args.sessionId ? [args.sessionId] : undefined,
      updatedAt: now
    }
    const id = await ctx.db.insert('stats', doc)
    return toDto({ ...doc, _id: id, _creationTime: now })
  }
})

/** Largest batch `recordMany` accepts. */
export const RECORD_MANY_MAX = 100

/**
 * Many finished dictations in one call (an outbox draining after time offline): the same rules as
 * `recordSession`, applied in order, with one read and one write of the stats row.
 */
export const recordMany = authedMutation({
  args: {
    sessions: v.array(
      v.object({ words: v.number(), speechMs: v.number(), day: v.string(), sessionId: v.optional(v.string()) })
    )
  },
  returns: v.union(statsDtoValidator, v.null()),
  handler: async (ctx, args) => {
    if (args.sessions.length > RECORD_MANY_MAX) throw new Error(`Record at most ${RECORD_MANY_MAX} sessions per call`)
    const now = Date.now()
    const existing = await loadStats(ctx)
    let state = existing
      ? {
          totalWords: existing.totalWords,
          totalSessions: existing.totalSessions,
          totalSpeechMs: existing.totalSpeechMs,
          streakDays: existing.streakDays,
          lastSessionDay: existing.lastSessionDay,
          recentSessionIds: existing.recentSessionIds ?? [],
          updatedAt: existing.updatedAt
        }
      : null
    let changed = false
    for (const session of args.sessions) {
      const day = requireDay(session.day)
      const words = Math.max(0, Math.floor(session.words))
      const speechMs = Math.max(0, Math.floor(session.speechMs))
      if (state) {
        if (session.sessionId && state.recentSessionIds.includes(session.sessionId)) continue
        state = {
          totalWords: state.totalWords + words,
          totalSessions: state.totalSessions + 1,
          totalSpeechMs: state.totalSpeechMs + speechMs,
          streakDays: nextStreak(state, day),
          lastSessionDay: daysBetween(state.lastSessionDay || day, day) >= 0 ? day : state.lastSessionDay,
          recentSessionIds: session.sessionId
            ? [...state.recentSessionIds, session.sessionId].slice(-RECENT_SESSION_IDS)
            : state.recentSessionIds,
          updatedAt: now
        }
      } else {
        state = {
          totalWords: words,
          totalSessions: 1,
          totalSpeechMs: speechMs,
          streakDays: 1,
          lastSessionDay: day,
          recentSessionIds: session.sessionId ? [session.sessionId] : [],
          updatedAt: now
        }
      }
      changed = true
    }
    if (!state) return null
    const fields = { ...state, recentSessionIds: state.recentSessionIds.length ? state.recentSessionIds : undefined }
    if (existing) {
      if (changed) await ctx.db.patch('stats', existing._id, fields)
      return toDto({ ...existing, ...fields })
    }
    const id = await ctx.db.insert('stats', { userId: ctx.user._id, ...fields })
    return toDto({ ...fields, userId: ctx.user._id, _id: id, _creationTime: now })
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
