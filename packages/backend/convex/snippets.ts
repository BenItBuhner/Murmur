import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { authedMutation, authedQuery, type AuthedMutationCtx } from './lib/functions'
import { LIMITS } from './lib/limits'
import { normalizeKey, requireMaxLength, requireNonEmpty } from './lib/normalize'
import { snippetDtoValidator, snippetInputValidator, type SnippetDto, type SnippetInput } from './lib/validators'

function toDto(doc: Doc<'snippets'>): SnippetDto {
  return {
    id: doc._id,
    trigger: doc.trigger,
    content: doc.content,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

function validateInput(input: SnippetInput): { trigger: string; triggerKey: string; content: string } {
  const trigger = requireMaxLength(
    requireNonEmpty(input.trigger, 'trigger'),
    LIMITS.snippetTriggerLength,
    'trigger'
  )
  const content = requireMaxLength(input.content, LIMITS.snippetContentLength, 'content')
  if (!content.trim()) throw new Error('content must not be empty')
  return { trigger, triggerKey: normalizeKey(trigger), content }
}

async function countSnippets(ctx: AuthedMutationCtx): Promise<number> {
  const all = await ctx.db
    .query('snippets')
    .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
    .collect()
  return all.length
}

/** Triggers are unique per user; writing an existing trigger replaces that snippet's content. */
async function upsertSnippet(
  ctx: AuthedMutationCtx,
  input: SnippetInput,
  targetId: Id<'snippets'> | undefined,
  now: number,
  count: { value: number }
): Promise<{ id: Id<'snippets'>; created: boolean }> {
  const { trigger, triggerKey, content } = validateInput(input)
  const target = targetId ? await ctx.db.get('snippets', targetId) : null
  if (targetId && (!target || target.userId !== ctx.user._id)) throw new Error('Snippet not found')
  const byKey = await ctx.db
    .query('snippets')
    .withIndex('by_user_and_triggerKey', (q) =>
      q.eq('userId', ctx.user._id).eq('triggerKey', triggerKey)
    )
    .unique()

  if (byKey && (!target || byKey._id !== target._id)) {
    await ctx.db.patch('snippets', byKey._id, { trigger, content, updatedAt: now })
    if (target) {
      await ctx.db.delete('snippets', target._id)
      count.value--
    }
    return { id: byKey._id, created: false }
  }
  if (target) {
    await ctx.db.patch('snippets', target._id, { trigger, triggerKey, content, updatedAt: now })
    return { id: target._id, created: false }
  }
  if (count.value >= LIMITS.snippets) throw new Error(`Snippet limit reached (${LIMITS.snippets})`)
  const id = await ctx.db.insert('snippets', {
    userId: ctx.user._id,
    trigger,
    triggerKey,
    content,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  })
  count.value++
  return { id, created: true }
}

export const list = authedQuery({
  args: {},
  returns: v.array(snippetDtoValidator),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const docs = await ctx.db
      .query('snippets')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .collect()
    return docs.sort((a, b) => b.createdAt - a.createdAt).map(toDto)
  }
})

export const upsert = authedMutation({
  args: {
    id: v.optional(v.id('snippets')),
    trigger: v.string(),
    content: v.string(),
    createdAt: v.optional(v.number())
  },
  returns: v.id('snippets'),
  handler: async (ctx, args) => {
    const count = { value: await countSnippets(ctx) }
    const result = await upsertSnippet(
      ctx,
      { trigger: args.trigger, content: args.content, createdAt: args.createdAt },
      args.id,
      Date.now(),
      count
    )
    return result.id
  }
})

export const remove = authedMutation({
  args: { id: v.id('snippets') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get('snippets', args.id)
    if (!doc || doc.userId !== ctx.user._id) return false
    await ctx.db.delete('snippets', doc._id)
    return true
  }
})

export const importMany = authedMutation({
  args: { snippets: v.array(snippetInputValidator) },
  returns: v.object({ imported: v.number(), merged: v.number() }),
  handler: async (ctx, args) => {
    if (args.snippets.length > LIMITS.batch) {
      throw new Error(`Import at most ${LIMITS.batch} snippets per call`)
    }
    const now = Date.now()
    const count = { value: await countSnippets(ctx) }
    let imported = 0
    let merged = 0
    for (const snippet of args.snippets) {
      if (!snippet.trigger.trim() || !snippet.content.trim()) continue
      const result = await upsertSnippet(ctx, snippet, undefined, now, count)
      if (result.created) imported++
      else merged++
    }
    return { imported, merged }
  }
})
