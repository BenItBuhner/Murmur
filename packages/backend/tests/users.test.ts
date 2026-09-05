import { describe, expect, it } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { ada, bob, setup } from './helpers'

describe('users', () => {
  it('rejects unauthenticated callers', async () => {
    const t = setup()
    await expect(t.query(api.users.me, {})).rejects.toThrow(/Not authenticated/)
    await expect(t.mutation(api.users.ensure, {})).rejects.toThrow(/Not authenticated/)
    await expect(t.query(api.dictionary.list, {})).rejects.toThrow(/Not authenticated/)
  })

  it('returns null before the account is provisioned, then the profile from the JWT', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect(await asAda.query(api.users.me, {})).toBeNull()

    const created = await asAda.mutation(api.users.ensure, {})
    expect(created.clerkId).toBe('user_ada')
    expect(created.email).toBe('ada@example.com')
    expect(created.name).toBe('Ada Lovelace')
    expect(created.imageUrl).toBe('https://img.clerk.com/ada.png')
    expect(created.onboardingCompletedAt).toBeUndefined()

    const again = await asAda.mutation(api.users.ensure, {})
    expect(again.id).toBe(created.id)
    const me = await asAda.query(api.users.me, {})
    expect(me?.id).toBe(created.id)
  })

  it('derives a display name from given/family name claims', async () => {
    const t = setup()
    const user = await t.withIdentity(bob).mutation(api.users.ensure, {})
    expect(user.name).toBe('Bob Builder')
  })

  it('never blanks webhook-provided profile fields with an empty JWT', async () => {
    const t = setup()
    await t.mutation(internal.users.upsertFromClerk, {
      clerkId: 'user_x',
      email: 'x@example.com',
      name: 'X Æ',
      imageUrl: 'https://img.clerk.com/x.png'
    })
    const user = await t.withIdentity({ subject: 'user_x' }).mutation(api.users.ensure, {})
    expect(user.email).toBe('x@example.com')
    expect(user.name).toBe('X Æ')
    expect(user.imageUrl).toBe('https://img.clerk.com/x.png')
  })

  it('records account-level onboarding once and keeps the newest version', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const done = await asAda.mutation(api.users.completeOnboarding, {})
    expect(done.onboardingCompletedAt).toBeTypeOf('number')
    expect(done.onboardingVersion).toBe(1)

    const repeat = await asAda.mutation(api.users.completeOnboarding, { version: 1 })
    expect(repeat.onboardingCompletedAt).toBe(done.onboardingCompletedAt)

    const upgraded = await asAda.mutation(api.users.completeOnboarding, { version: 2 })
    expect(upgraded.onboardingVersion).toBe(2)
  })

  it('deleteMyData cascades through every table', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.dictionary.upsert, { word: 'Murmur' })
    await asAda.mutation(api.snippets.upsert, { trigger: 'my email', content: 'ada@example.com' })
    await asAda.mutation(api.appRules.upsert, { match: 'slack', tone: 'casual' })
    await asAda.mutation(api.preferences.update, { language: 'en' })
    await asAda.mutation(api.stats.recordSession, { words: 5, speechMs: 1000, day: '2026-09-05' })
    await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'dev-1',
      name: 'Desk',
      platform: 'linux',
      appVersion: '0.1.0'
    })
    await asAda.mutation(api.history.push, {
      deviceId: 'dev-1',
      entries: [
        {
          entryId: 'h1',
          createdAt: 1,
          mode: 'hold',
          finalText: 'hello',
          wordCount: 1,
          speechMs: 500,
          provider: 'openai-compatible',
          model: 'whisper-1',
          llmUsed: false
        }
      ]
    })
    // Another user's data must survive.
    await t.withIdentity(bob).mutation(api.dictionary.upsert, { word: 'Bobcat' })

    await asAda.mutation(api.users.deleteMyData, {})

    await t.run(async (ctx) => {
      const users = await ctx.db.query('users').collect()
      expect(users.map((u) => u.clerkId)).toEqual(['user_bob'])
      const dictionary = await ctx.db.query('dictionaryEntries').collect()
      expect(dictionary).toHaveLength(1)
      expect(dictionary[0].userId).toBe(users[0]._id)
      for (const table of [
        'snippets',
        'appRules',
        'preferences',
        'stats',
        'devices',
        'historyEntries'
      ] as const) {
        expect(await ctx.db.query(table).collect()).toHaveLength(0)
      }
    })
    expect(await asAda.query(api.users.me, {})).toBeNull()
    expect(await t.withIdentity(bob).query(api.dictionary.list, {})).toHaveLength(1)
  })

  it('purges by Clerk id for the user.deleted webhook', async () => {
    const t = setup()
    await t.withIdentity(ada).mutation(api.dictionary.upsert, { word: 'Murmur' })
    expect(await t.mutation(internal.users.purgeByClerkId, { clerkId: 'user_ada' })).toBe(true)
    expect(await t.mutation(internal.users.purgeByClerkId, { clerkId: 'user_ada' })).toBe(false)
    await t.run(async (ctx) => {
      expect(await ctx.db.query('dictionaryEntries').collect()).toHaveLength(0)
      expect(await ctx.db.query('users').collect()).toHaveLength(0)
    })
  })
})
