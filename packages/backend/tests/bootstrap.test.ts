import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { ada, bob, setup } from './helpers'

describe('bootstrap', () => {
  it('answers everything the account holds in one call, with live last-seen times', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)

    // Before the account is provisioned: the empty answers, in the shape clients expect.
    expect(await asAda.query(api.bootstrap.get, {})).toEqual({
      me: null,
      preferences: null,
      appRules: [],
      snippets: [],
      dictionary: [],
      devices: [],
      stats: null
    })

    await asAda.mutation(api.users.ensure, {})
    await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'desk',
      name: 'Desk',
      platform: 'win32',
      appVersion: '0.1.0'
    })
    await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'phone',
      name: 'Pixel',
      platform: 'android',
      appVersion: '0.1.0'
    })
    await asAda.mutation(api.snippets.upsert, { trigger: 'hw', content: 'Hello, world!' })
    await asAda.mutation(api.appRules.upsert, { match: 'Slack', tone: 'casual' })
    await asAda.mutation(api.dictionary.upsert, { word: 'Kafka', aliases: [], fuzzy: false })
    await asAda.mutation(api.preferences.update, { language: 'en' })
    await asAda.mutation(api.stats.recordSession, { words: 3, speechMs: 900, day: '2026-09-04' })

    const boot = await asAda.query(api.bootstrap.get, {})
    expect(boot.me?.email).toBe('ada@example.com')
    expect(boot.preferences?.language).toBe('en')
    expect(boot.snippets.map((s) => s.trigger)).toEqual(['hw'])
    expect(boot.appRules.map((r) => r.match)).toEqual(['Slack'])
    expect(boot.dictionary.map((d) => d.word)).toEqual(['Kafka'])
    expect(boot.stats?.totalWords).toBe(3)
    expect(boot.devices).toHaveLength(2)
    // The same shapes devices.list answers with, but with the live liveness time.
    expect(boot.devices.map((d) => d.name).sort()).toEqual(['Desk', 'Pixel'])
    expect(boot.devices[0].lastSeenAt).toBeGreaterThan(0)

    // Another account sees nothing of Ada's, and its own empty answers.
    const bobBoot = await t.withIdentity(bob).query(api.bootstrap.get, {})
    expect(bobBoot.me).toBeNull()
    expect(bobBoot.devices).toEqual([])
    expect(bobBoot.snippets).toEqual([])
  })
})
