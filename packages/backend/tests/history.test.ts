import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { ada, bob, setup } from './helpers'

const entry = (id: string, createdAt: number) => ({
  entryId: id,
  createdAt,
  mode: 'hold' as const,
  rawText: `raw ${id}`,
  finalText: `Final ${id}.`,
  wordCount: 2,
  speechMs: 900,
  appName: 'Slack',
  provider: 'openai-compatible',
  model: 'whisper-large-v3',
  llmUsed: true
})

describe('history', () => {
  it('pushes idempotently, joins device names and orders newest first', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'desk',
      name: 'Desk',
      platform: 'linux',
      appVersion: '0.1.0'
    })
    const first = await asAda.mutation(api.history.push, {
      deviceId: 'desk',
      entries: [entry('a', 1), entry('b', 2)]
    })
    expect(first).toEqual({ inserted: 2, pruned: 0 })
    const second = await asAda.mutation(api.history.push, {
      deviceId: 'phone',
      entries: [entry('b', 2), entry('c', 3), { ...entry('blank', 4), finalText: '  ' }]
    })
    expect(second).toEqual({ inserted: 1, pruned: 0 })

    const recent = await asAda.query(api.history.recent, {})
    expect(recent.map((e) => e.entryId)).toEqual(['c', 'b', 'a'])
    expect(recent[1].deviceName).toBe('Desk')
    expect(recent[0].deviceName).toBeUndefined()
    expect(recent[0].deviceId).toBe('phone')

    expect(await asAda.query(api.history.recent, { limit: 1 })).toHaveLength(1)
    await t.run(async (ctx) => {
      const [meta] = await ctx.db.query('historyMeta').collect()
      expect(meta?.count).toBe(3)
    })
  })

  it('pushes without touching the account row, so no other subscription re-runs', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'desk',
      name: 'Desk',
      platform: 'linux',
      appVersion: '0.1.0'
    })
    const before = await t.run((ctx) => ctx.db.query('users').collect())
    await asAda.mutation(api.history.push, { deviceId: 'desk', entries: [entry('a', 1)] })
    const after = await t.run((ctx) => ctx.db.query('users').collect())
    // Every authenticated query reads the account row; a patch here would re-run all of a
    // user's live subscriptions after every dictation.
    expect(after).toEqual(before)
  })

  it('removes and clears, keeping the counter in step, and isolates users', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.history.push, { deviceId: 'desk', entries: [entry('a', 1), entry('b', 2)] })
    expect(await t.withIdentity(bob).query(api.history.recent, {})).toEqual([])
    expect(await t.withIdentity(bob).mutation(api.history.remove, { entryId: 'a' })).toBe(false)

    expect(await asAda.mutation(api.history.remove, { entryId: 'a' })).toBe(true)
    expect(await asAda.mutation(api.history.remove, { entryId: 'a' })).toBe(false)
    await t.run(async (ctx) => {
      const ada = (await ctx.db.query('users').collect()).find((u) => u.clerkId === 'user_ada')
      const metas = await ctx.db.query('historyMeta').collect()
      expect(metas).toHaveLength(1)
      expect(metas[0].userId).toBe(ada!._id)
      expect(metas[0].count).toBe(1)
    })
    expect(await asAda.mutation(api.history.clear, {})).toBe(1)
    expect(await asAda.query(api.history.recent, {})).toEqual([])
  })

  it('refuses oversized batches', async () => {
    const t = setup()
    const entries = Array.from({ length: 501 }, (_, i) => entry(`e${i}`, i))
    await expect(
      t.withIdentity(ada).mutation(api.history.push, { deviceId: 'desk', entries })
    ).rejects.toThrow(/at most 500/)
  })
})
