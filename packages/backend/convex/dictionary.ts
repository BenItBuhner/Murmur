import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { LIMITS } from './lib/limits'
import { cleanAliases, normalizeKey, requireMaxLength, requireNonEmpty } from './lib/normalize'
import {
  dictionaryEntryDtoValidator,
  dictionaryEntryInputValidator,
  type DictionaryEntryDto,
  type DictionaryEntryInput
} from './lib/validators'

function toDto(doc: Doc<'dictionaryEntries'>): DictionaryEntryDto {
  return {
    id: doc._id,
    word: doc.word,
    aliases: doc.aliases,
    fuzzy: doc.fuzzy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

function validateInput(input: DictionaryEntryInput): {
  word: string
  wordKey: string
  aliases: string[]
  fuzzy: boolean
} {
  const word = requireMaxLength(requireNonEmpty(input.word, 'word'), LIMITS.wordLength, 'word')
  const aliases = cleanAliases(word, input.aliases)
    .slice(0, LIMITS.aliasesPerEntry)
    .map((a) => requireMaxLength(a, LIMITS.aliasLength, 'alias'))
  return { word, wordKey: normalizeKey(word), aliases, fuzzy: input.fuzzy ?? false }
}

function unionAliases(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const alias of [...a, ...b]) {
    const key = normalizeKey(alias)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
  }
  return out.slice(0, LIMITS.aliasesPerEntry)
}

async function findByKey(
  ctx: AuthedMutationCtx,
  wordKey: string
): Promise<Doc<'dictionaryEntries'> | null> {
  return await ctx.db
    .query('dictionaryEntries')
    .withIndex('by_user_and_wordKey', (q) => q.eq('userId', ctx.user._id).eq('wordKey', wordKey))
    .unique()
}

async function countEntries(ctx: AuthedMutationCtx): Promise<number> {
  const all = await ctx.db
    .query('dictionaryEntries')
    .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
    .collect()
  return all.length
}

/**
 * Write one entry. Words are unique per user (case-insensitive): writing a word that already exists
 * merges into the existing row instead of creating a duplicate.
 */
async function upsertEntry(
  ctx: AuthedMutationCtx,
  input: DictionaryEntryInput,
  targetId: Id<'dictionaryEntries'> | undefined,
  now: number,
  count: { value: number }
): Promise<{ id: Id<'dictionaryEntries'>; created: boolean; merged: boolean }> {
  const { word, wordKey, aliases, fuzzy } = validateInput(input)
  const target = targetId ? await ctx.db.get('dictionaryEntries', targetId) : null
  if (targetId && (!target || target.userId !== ctx.user._id)) {
    throw new Error('Dictionary entry not found')
  }
  const byKey = await findByKey(ctx, wordKey)

  if (byKey && (!target || byKey._id !== target._id)) {
    // Same word already stored: merge the incoming data into it and drop the renamed row, if any.
    await ctx.db.patch('dictionaryEntries', byKey._id, {
      word,
      aliases: unionAliases(byKey.aliases, aliases),
      fuzzy: byKey.fuzzy || fuzzy,
      updatedAt: now
    })
    if (target) {
      await ctx.db.delete('dictionaryEntries', target._id)
      count.value--
    }
    return { id: byKey._id, created: false, merged: true }
  }
  if (target) {
    await ctx.db.patch('dictionaryEntries', target._id, { word, wordKey, aliases, fuzzy, updatedAt: now })
    return { id: target._id, created: false, merged: false }
  }
  if (count.value >= LIMITS.dictionaryEntries) {
    throw new Error(`Dictionary limit reached (${LIMITS.dictionaryEntries} entries)`)
  }
  const id = await ctx.db.insert('dictionaryEntries', {
    userId: ctx.user._id,
    word,
    wordKey,
    aliases,
    fuzzy,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  })
  count.value++
  return { id, created: true, merged: false }
}

/** Every dictionary entry for the account, newest first. Bounded by LIMITS.dictionaryEntries. */
export const list = authedQuery({
  args: {},
  returns: v.array(dictionaryEntryDtoValidator),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const docs = await ctx.db
      .query('dictionaryEntries')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .collect()
    return docs.sort((a, b) => b.createdAt - a.createdAt).map(toDto)
  }
})

/** Create or update an entry. Returns the id that now holds the word (may differ after a merge). */
export const upsert = authedMutation({
  args: {
    id: v.optional(v.id('dictionaryEntries')),
    word: v.string(),
    aliases: v.optional(v.array(v.string())),
    fuzzy: v.optional(v.boolean()),
    createdAt: v.optional(v.number())
  },
  returns: v.id('dictionaryEntries'),
  handler: async (ctx, args) => {
    const count = { value: await countEntries(ctx) }
    const result = await upsertEntry(
      ctx,
      { word: args.word, aliases: args.aliases, fuzzy: args.fuzzy, createdAt: args.createdAt },
      args.id,
      Date.now(),
      count
    )
    return result.id
  }
})

/** Delete an entry. Returns false when it does not exist (or belongs to someone else). */
export const remove = authedMutation({
  args: { id: v.id('dictionaryEntries') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get('dictionaryEntries', args.id)
    if (!doc || doc.userId !== ctx.user._id) return false
    await ctx.db.delete('dictionaryEntries', doc._id)
    return true
  }
})

/**
 * Bulk import, used when a device that already has a local dictionary signs in for the first time.
 * Duplicates (by normalized word) are merged rather than duplicated.
 */
export const importMany = authedMutation({
  args: { entries: v.array(dictionaryEntryInputValidator) },
  returns: v.object({ imported: v.number(), merged: v.number() }),
  handler: async (ctx, args) => {
    if (args.entries.length > LIMITS.batch) {
      throw new Error(`Import at most ${LIMITS.batch} entries per call`)
    }
    const now = Date.now()
    const count = { value: await countEntries(ctx) }
    let imported = 0
    let merged = 0
    for (const entry of args.entries) {
      if (!entry.word.trim()) continue
      const result = await upsertEntry(ctx, entry, undefined, now, count)
      if (result.created) imported++
      else merged++
    }
    return { imported, merged }
  }
})
