import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery } from './lib/functions'
import { LIMITS } from './lib/limits'
import {
  formattingPreferencesValidator,
  preferencesDtoValidator,
  syncPreferencesValidator,
  type FormattingPreferences,
  type PreferencesDto
} from './lib/validators'

function toDto(doc: Doc<'preferences'>): PreferencesDto {
  return { formatting: doc.formatting, language: doc.language, sync: doc.sync, updatedAt: doc.updatedAt }
}

function cleanFormatting(input: FormattingPreferences | undefined): FormattingPreferences | undefined {
  if (!input) return undefined
  const out: FormattingPreferences = { ...input }
  if (out.fillerWords) {
    out.fillerWords = [
      ...new Set(out.fillerWords.map((w) => w.trim().toLowerCase()).filter(Boolean))
    ].slice(0, LIMITS.fillerWords)
  }
  return out
}

/** The account's cross-device preferences, or null before anything was saved. */
export const get = authedQuery({
  args: {},
  returns: v.union(preferencesDtoValidator, v.null()),
  handler: async (ctx) => {
    if (!ctx.user) return null
    const doc = await ctx.db
      .query('preferences')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .unique()
    return doc ? toDto(doc) : null
  }
})

/**
 * Merge a partial update. Sections merge field-by-field so a client that only knows about some
 * settings (the phone) never wipes the ones it does not have.
 */
export const update = authedMutation({
  args: {
    formatting: v.optional(formattingPreferencesValidator),
    language: v.optional(v.string()),
    sync: v.optional(syncPreferencesValidator)
  },
  returns: preferencesDtoValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('preferences')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
      .unique()
    const formatting = cleanFormatting(args.formatting)
    const next = {
      userId: ctx.user._id,
      formatting:
        formatting || existing?.formatting
          ? { ...(existing?.formatting ?? {}), ...(formatting ?? {}) }
          : undefined,
      language: args.language !== undefined ? args.language.trim() || 'auto' : existing?.language,
      sync:
        args.sync || existing?.sync ? { ...(existing?.sync ?? {}), ...(args.sync ?? {}) } : undefined,
      updatedAt: now
    }
    if (existing) {
      await ctx.db.replace('preferences', existing._id, next)
      return toDto({ ...existing, ...next })
    }
    const id = await ctx.db.insert('preferences', next)
    const inserted = await ctx.db.get('preferences', id)
    if (!inserted) throw new Error('Failed to save preferences')
    return toDto(inserted)
  }
})
