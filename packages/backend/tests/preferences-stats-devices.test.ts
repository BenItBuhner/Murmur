import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { daysBetween, nextStreak } from '../convex/lib/streak'
import { ada, bob, setup } from './helpers'

describe('preferences', () => {
  it('is null until saved and merges sections field by field', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect(await asAda.query(api.preferences.get, {})).toBeNull()

    await asAda.mutation(api.preferences.update, {
      formatting: { mode: 'smart', tone: 'casual', fillerWords: ['Um', 'uh', 'um', ' '] },
      language: 'en'
    })
    // The phone only knows about tone; nothing else may be lost.
    const merged = await asAda.mutation(api.preferences.update, {
      formatting: { tone: 'professional' },
      sync: { history: true }
    })
    expect(merged.formatting).toEqual({
      mode: 'smart',
      tone: 'professional',
      fillerWords: ['um', 'uh']
    })
    expect(merged.language).toBe('en')
    expect(merged.sync).toEqual({ history: true })

    const blankLanguage = await asAda.mutation(api.preferences.update, { language: '  ' })
    expect(blankLanguage.language).toBe('auto')
    expect(await t.withIdentity(bob).query(api.preferences.get, {})).toBeNull()
  })

  it('syncs the cleanup, structure and model style fields', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const saved = await asAda.mutation(api.preferences.update, {
      formatting: {
        hesitations: 'thorough',
        hesitationPhrases: ['At The End Of The Day', 'so yeah', 'so yeah'],
        repetitionScope: 'thorough',
        lists: 'spoken',
        listStyle: 'numbers',
        bulletMarker: '•',
        numbers: 'all',
        llmFreedom: 'natural',
        llmStructure: 'keep',
        llmInstructions: '  Use British spelling.  '
      }
    })
    expect(saved.formatting).toEqual({
      hesitations: 'thorough',
      hesitationPhrases: ['at the end of the day', 'so yeah'],
      repetitionScope: 'thorough',
      lists: 'spoken',
      listStyle: 'numbers',
      bulletMarker: '•',
      numbers: 'all',
      llmFreedom: 'natural',
      llmStructure: 'keep',
      llmInstructions: 'Use British spelling.'
    })
    // An older client that only knows the classic fields leaves the new ones untouched.
    const merged = await asAda.mutation(api.preferences.update, { formatting: { tone: 'casual' } })
    expect(merged.formatting?.llmFreedom).toBe('natural')
    expect(merged.formatting?.tone).toBe('casual')
  })
})

describe('stats', () => {
  it('streak helpers follow consecutive local days', () => {
    expect(daysBetween('2026-09-04', '2026-09-05')).toBe(1)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(nextStreak({ streakDays: 0, lastSessionDay: '' }, '2026-09-05')).toBe(1)
    expect(nextStreak({ streakDays: 3, lastSessionDay: '2026-09-05' }, '2026-09-05')).toBe(3)
    expect(nextStreak({ streakDays: 3, lastSessionDay: '2026-09-04' }, '2026-09-05')).toBe(4)
    expect(nextStreak({ streakDays: 3, lastSessionDay: '2026-09-01' }, '2026-09-05')).toBe(1)
    expect(nextStreak({ streakDays: 3, lastSessionDay: '2026-09-06' }, '2026-09-05')).toBe(3)
  })

  it('records sessions across devices and imports local totals', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect(await asAda.query(api.stats.get, {})).toBeNull()
    await asAda.mutation(api.stats.recordSession, { words: 10, speechMs: 4000, day: '2026-09-04' })
    const second = await asAda.mutation(api.stats.recordSession, {
      words: 5,
      speechMs: 1000,
      day: '2026-09-05'
    })
    expect(second).toMatchObject({
      totalWords: 15,
      totalSessions: 2,
      totalSpeechMs: 5000,
      streakDays: 2,
      lastSessionDay: '2026-09-05'
    })
    await expect(
      asAda.mutation(api.stats.recordSession, { words: 1, speechMs: 1, day: 'yesterday' })
    ).rejects.toThrow(/YYYY-MM-DD/)

    // A replayed operation (same session id) must not count twice.
    const once = await asAda.mutation(api.stats.recordSession, {
      words: 7,
      speechMs: 700,
      day: '2026-09-05',
      sessionId: 'session-1'
    })
    const twice = await asAda.mutation(api.stats.recordSession, {
      words: 7,
      speechMs: 700,
      day: '2026-09-05',
      sessionId: 'session-1'
    })
    expect(once.totalSessions).toBe(3)
    expect(twice).toEqual(once)

    const imported = await asAda.mutation(api.stats.importLocal, {
      totalWords: 100,
      totalSessions: 20,
      totalSpeechMs: 60_000,
      streakDays: 7,
      lastSessionDay: '2026-09-01'
    })
    expect(imported).toMatchObject({
      totalWords: 122,
      totalSessions: 23,
      totalSpeechMs: 65_700,
      streakDays: 7,
      lastSessionDay: '2026-09-05'
    })
    expect(await t.withIdentity(bob).query(api.stats.get, {})).toBeNull()
  })
})

describe('devices', () => {
  it('registers, refreshes and removes devices', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const desk = await asAda.mutation(api.devices.heartbeat, {
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
    const again = await asAda.mutation(api.devices.heartbeat, {
      deviceId: 'desk',
      name: 'Desk (renamed)',
      platform: 'win32',
      appVersion: '0.2.0'
    })
    expect(again.id).toBe(desk.id)
    expect(again).toMatchObject({ name: 'Desk (renamed)', appVersion: '0.2.0' })

    const list = await asAda.query(api.devices.list, {})
    expect(list).toHaveLength(2)
    expect(list[0].deviceId).toBe('desk')
    expect(await t.withIdentity(bob).query(api.devices.list, {})).toEqual([])
    expect(await t.withIdentity(bob).mutation(api.devices.remove, { deviceId: 'desk' })).toBe(false)
    expect(await asAda.mutation(api.devices.remove, { deviceId: 'phone' })).toBe(true)
    expect((await asAda.query(api.devices.list, {})).map((d) => d.deviceId)).toEqual(['desk'])
    await expect(
      asAda.mutation(api.devices.heartbeat, {
        deviceId: '',
        name: 'x',
        platform: 'linux',
        appVersion: '1'
      })
    ).rejects.toThrow(/deviceId/)
  })
})
