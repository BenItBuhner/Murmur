import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { ada, bob, setup } from './helpers'

describe('snippets', () => {
  it('creates, dedupes by trigger and updates content', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const id = await asAda.mutation(api.snippets.upsert, {
      trigger: ' My Email ',
      content: 'ada@example.com'
    })
    const same = await asAda.mutation(api.snippets.upsert, {
      trigger: 'my email',
      content: 'ada@lovelace.dev'
    })
    expect(same).toBe(id)
    const list = await asAda.query(api.snippets.list, {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ trigger: 'my email', content: 'ada@lovelace.dev' })
  })

  it('renaming onto an existing trigger merges rows', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const a = await asAda.mutation(api.snippets.upsert, { trigger: 'sig', content: 'A' })
    const b = await asAda.mutation(api.snippets.upsert, { trigger: 'signature', content: 'B' })
    expect(await asAda.mutation(api.snippets.upsert, { id: b, trigger: 'SIG', content: 'C' })).toBe(a)
    const list = await asAda.query(api.snippets.list, {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ trigger: 'SIG', content: 'C' })
  })

  it('validates and isolates', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await expect(asAda.mutation(api.snippets.upsert, { trigger: '', content: 'x' })).rejects.toThrow(
      /trigger/
    )
    await expect(
      asAda.mutation(api.snippets.upsert, { trigger: 'x', content: '   ' })
    ).rejects.toThrow(/content/)
    const id = await asAda.mutation(api.snippets.upsert, { trigger: 'x', content: 'y' })
    expect(await t.withIdentity(bob).mutation(api.snippets.remove, { id })).toBe(false)
    expect(await t.withIdentity(bob).query(api.snippets.list, {})).toEqual([])
    expect(await asAda.mutation(api.snippets.remove, { id })).toBe(true)
  })

  it('imports with merge counts', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.snippets.upsert, { trigger: 'addr', content: 'old' })
    const result = await asAda.mutation(api.snippets.importMany, {
      snippets: [
        { trigger: 'ADDR', content: 'new' },
        { trigger: 'phone', content: '555' },
        { trigger: '', content: 'skip' }
      ]
    })
    expect(result).toEqual({ imported: 1, merged: 1 })
    const list = await asAda.query(api.snippets.list, {})
    expect(list.find((s) => s.trigger === 'ADDR')?.content).toBe('new')
  })
})

describe('appRules', () => {
  it('creates, dedupes by match and replaces optional fields', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const id = await asAda.mutation(api.appRules.upsert, {
      match: 'Slack',
      tone: 'casual',
      formatting: 'light',
      trailingSpace: false
    })
    const same = await asAda.mutation(api.appRules.upsert, { match: 'slack', tone: 'neutral' })
    expect(same).toBe(id)
    const [rule] = await asAda.query(api.appRules.list, {})
    expect(rule).toMatchObject({ match: 'slack', tone: 'neutral' })
    expect(rule.formatting).toBeUndefined()
    expect(rule.trailingSpace).toBeUndefined()
  })

  it('defaults tone to auto, lists oldest first, isolates and imports', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.appRules.upsert, { match: 'mail', createdAt: 2 })
    await asAda.mutation(api.appRules.upsert, { match: 'docs', createdAt: 1 })
    const list = await asAda.query(api.appRules.list, {})
    expect(list.map((r) => r.match)).toEqual(['docs', 'mail'])
    expect(list[0].tone).toBe('auto')

    expect(await t.withIdentity(bob).query(api.appRules.list, {})).toEqual([])
    expect(await t.withIdentity(bob).mutation(api.appRules.remove, { id: list[0].id })).toBe(false)

    const result = await asAda.mutation(api.appRules.importMany, {
      rules: [{ match: 'MAIL', tone: 'professional' }, { match: 'terminal' }]
    })
    expect(result).toEqual({ imported: 1, merged: 1 })
  })
})
