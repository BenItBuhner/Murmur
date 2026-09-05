import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { ada, bob, setup } from './helpers'

describe('dictionary', () => {
  it('is empty before provisioning and after, until words are added', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect(await asAda.query(api.dictionary.list, {})).toEqual([])
    await asAda.mutation(api.users.ensure, {})
    expect(await asAda.query(api.dictionary.list, {})).toEqual([])
  })

  it('creates entries with cleaned aliases and lists newest first', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const first = await asAda.mutation(api.dictionary.upsert, {
      word: ' Wispr Flow ',
      aliases: ['whisper flow', ' wisper flow', 'WHISPER FLOW', 'Wispr Flow', ''],
      fuzzy: true,
      createdAt: 1000
    })
    const second = await asAda.mutation(api.dictionary.upsert, { word: 'Murmur', createdAt: 2000 })
    const list = await asAda.query(api.dictionary.list, {})
    expect(list.map((e) => e.id)).toEqual([second, first])
    expect(list[1]).toMatchObject({
      word: 'Wispr Flow',
      aliases: ['whisper flow', 'wisper flow'],
      fuzzy: true,
      createdAt: 1000
    })
    expect(list[0]).toMatchObject({ word: 'Murmur', aliases: [], fuzzy: false })
  })

  it('treats words as unique per user, case-insensitively, merging aliases', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const id = await asAda.mutation(api.dictionary.upsert, { word: 'Convex', aliases: ['konvex'] })
    const same = await asAda.mutation(api.dictionary.upsert, {
      word: 'convex',
      aliases: ['con vex'],
      fuzzy: true
    })
    expect(same).toBe(id)
    const list = await asAda.query(api.dictionary.list, {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ word: 'convex', aliases: ['konvex', 'con vex'], fuzzy: true })
  })

  it('renaming an entry onto an existing word merges the two rows', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const a = await asAda.mutation(api.dictionary.upsert, { word: 'Clerk', aliases: ['clark'] })
    const b = await asAda.mutation(api.dictionary.upsert, { word: 'Klerk', aliases: ['klurk'] })
    const merged = await asAda.mutation(api.dictionary.upsert, { id: b, word: 'clerk' })
    expect(merged).toBe(a)
    const list = await asAda.query(api.dictionary.list, {})
    expect(list).toHaveLength(1)
    expect(list[0].aliases).toEqual(['clark'])
  })

  it('updates in place when the id is given and the word is unchanged', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const id = await asAda.mutation(api.dictionary.upsert, { word: 'Groq' })
    const updated = await asAda.mutation(api.dictionary.upsert, { id, word: 'Groq', fuzzy: true })
    expect(updated).toBe(id)
    const [entry] = await asAda.query(api.dictionary.list, {})
    expect(entry.fuzzy).toBe(true)
  })

  it('validates input', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await expect(asAda.mutation(api.dictionary.upsert, { word: '   ' })).rejects.toThrow(/word/)
    await expect(
      asAda.mutation(api.dictionary.upsert, { word: 'x'.repeat(121) })
    ).rejects.toThrow(/at most 120/)
  })

  it('isolates users from each other', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const asBob = t.withIdentity(bob)
    const adaId = await asAda.mutation(api.dictionary.upsert, { word: 'Ada only' })
    await asBob.mutation(api.dictionary.upsert, { word: 'Bob only' })

    expect((await asBob.query(api.dictionary.list, {})).map((e) => e.word)).toEqual(['Bob only'])
    expect(await asBob.mutation(api.dictionary.remove, { id: adaId })).toBe(false)
    await expect(
      asBob.mutation(api.dictionary.upsert, { id: adaId, word: 'hijack' })
    ).rejects.toThrow(/not found/)
    expect((await asAda.query(api.dictionary.list, {})).map((e) => e.word)).toEqual(['Ada only'])
  })

  it('removes entries', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const id = await asAda.mutation(api.dictionary.upsert, { word: 'Temporary' })
    expect(await asAda.mutation(api.dictionary.remove, { id })).toBe(true)
    expect(await asAda.mutation(api.dictionary.remove, { id })).toBe(false)
    expect(await asAda.query(api.dictionary.list, {})).toEqual([])
  })

  it('imports a local dictionary, merging duplicates instead of duplicating them', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.dictionary.upsert, { word: 'Existing', aliases: ['old'] })
    const result = await asAda.mutation(api.dictionary.importMany, {
      entries: [
        { word: 'existing', aliases: ['new'], fuzzy: true, createdAt: 5 },
        { word: 'Fresh', createdAt: 10 },
        { word: 'fresh' },
        { word: '' }
      ]
    })
    expect(result).toEqual({ imported: 1, merged: 2 })
    const list = await asAda.query(api.dictionary.list, {})
    // Merging keeps one row per word; the most recently written casing wins.
    expect(list.map((e) => e.word).sort()).toEqual(['existing', 'fresh'])
    expect(list.find((e) => e.word === 'existing')).toMatchObject({
      aliases: ['old', 'new'],
      fuzzy: true
    })
  })

  it('refuses oversized import batches', async () => {
    const t = setup()
    const entries = Array.from({ length: 501 }, (_, i) => ({ word: `w${i}` }))
    await expect(
      t.withIdentity(ada).mutation(api.dictionary.importMany, { entries })
    ).rejects.toThrow(/at most 500/)
  })
})
