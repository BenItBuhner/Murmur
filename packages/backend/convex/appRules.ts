import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { LIMITS } from './lib/limits'
import { normalizeKey, requireMaxLength, requireNonEmpty } from './lib/normalize'
import {
  appRuleDtoValidator,
  appRuleInputValidator,
  appRuleOverrides,
  toneValidator,
  type AppRuleDto,
  type AppRuleInput
} from './lib/validators'

function toDto(doc: Doc<'appRules'>): AppRuleDto {
  return {
    id: doc._id,
    match: doc.match,
    tone: doc.tone,
    formatting: doc.formatting,
    trailingSpace: doc.trailingSpace,
    lists: doc.lists,
    numbers: doc.numbers,
    freedom: doc.freedom,
    instructions: doc.instructions,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

async function countRules(ctx: AuthedMutationCtx): Promise<number> {
  const all = await ctx.db
    .query('appRules')
    .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
    .collect()
  return all.length
}

/** One rule per app match string (case-insensitive); re-adding a match updates the rule. */
async function upsertRule(
  ctx: AuthedMutationCtx,
  input: AppRuleInput,
  targetId: Id<'appRules'> | undefined,
  now: number,
  count: { value: number }
): Promise<{ id: Id<'appRules'>; created: boolean }> {
  const match = requireMaxLength(requireNonEmpty(input.match, 'match'), LIMITS.appRuleMatchLength, 'match')
  const matchKey = normalizeKey(match)
  const instructions = input.instructions?.trim()
  if (instructions !== undefined) requireMaxLength(instructions, LIMITS.instructionsLength, 'instructions')
  const fields = {
    match,
    matchKey,
    tone: input.tone ?? ('auto' as const),
    formatting: input.formatting,
    trailingSpace: input.trailingSpace,
    lists: input.lists,
    numbers: input.numbers,
    freedom: input.freedom,
    instructions: instructions || undefined,
    updatedAt: now
  }
  const target = targetId ? await ctx.db.get('appRules', targetId) : null
  if (targetId && (!target || target.userId !== ctx.user._id)) throw new Error('App rule not found')
  const byKey = await ctx.db
    .query('appRules')
    .withIndex('by_user_and_matchKey', (q) => q.eq('userId', ctx.user._id).eq('matchKey', matchKey))
    .unique()

  if (byKey && (!target || byKey._id !== target._id)) {
    await ctx.db.replace('appRules', byKey._id, { userId: ctx.user._id, createdAt: byKey.createdAt, ...fields })
    if (target) {
      await ctx.db.delete('appRules', target._id)
      count.value--
    }
    return { id: byKey._id, created: false }
  }
  if (target) {
    await ctx.db.replace('appRules', target._id, { userId: ctx.user._id, createdAt: target.createdAt, ...fields })
    return { id: target._id, created: false }
  }
  if (count.value >= LIMITS.appRules) throw new Error(`App rule limit reached (${LIMITS.appRules})`)
  const id = await ctx.db.insert('appRules', {
    userId: ctx.user._id,
    createdAt: input.createdAt ?? now,
    ...fields
  })
  count.value++
  return { id, created: true }
}

export const list = authedQuery({
  args: {},
  returns: v.array(appRuleDtoValidator),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const docs = await ctx.db
      .query('appRules')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .collect()
    return docs.sort((a, b) => a.createdAt - b.createdAt).map(toDto)
  }
})

export const upsert = authedMutation({
  args: {
    id: v.optional(v.id('appRules')),
    match: v.string(),
    tone: v.optional(toneValidator),
    ...appRuleOverrides,
    createdAt: v.optional(v.number())
  },
  returns: v.id('appRules'),
  handler: async (ctx, args) => {
    const count = { value: await countRules(ctx) }
    const { id: targetId, ...input } = args
    const result = await upsertRule(ctx, input, targetId, Date.now(), count)
    return result.id
  }
})

export const remove = authedMutation({
  args: { id: v.id('appRules') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get('appRules', args.id)
    if (!doc || doc.userId !== ctx.user._id) return false
    await ctx.db.delete('appRules', doc._id)
    return true
  }
})

export const importMany = authedMutation({
  args: { rules: v.array(appRuleInputValidator) },
  returns: v.object({ imported: v.number(), merged: v.number() }),
  handler: async (ctx, args) => {
    if (args.rules.length > LIMITS.batch) throw new Error(`Import at most ${LIMITS.batch} rules per call`)
    const now = Date.now()
    const count = { value: await countRules(ctx) }
    let imported = 0
    let merged = 0
    for (const rule of args.rules) {
      if (!rule.match.trim()) continue
      const result = await upsertRule(ctx, rule, undefined, now, count)
      if (result.created) imported++
      else merged++
    }
    return { imported, merged }
  }
})
