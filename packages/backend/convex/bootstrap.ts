import { v } from 'convex/values'
import { authedQuery } from './lib/functions'
import { toUserDto } from './lib/users'
import {
  appRuleDtoValidator,
  deviceDtoValidator,
  dictionaryEntryDtoValidator,
  preferencesDtoValidator,
  snippetDtoValidator,
  statsDtoValidator,
  userDtoValidator
} from './lib/validators'
import { toDto as appRuleDto } from './appRules'
import { toDto as deviceDto } from './devices'
import { toDto as dictionaryEntryDto } from './dictionary'
import { toDto as preferencesDto } from './preferences'
import { toDto as snippetDto } from './snippets'
import { toDto as statsDto } from './stats'

/**
 * Everything a signed-in client needs from the account in one answer: the user, their
 * preferences, app rules, snippets, dictionary, devices (with live last-seen times) and stats.
 *
 * Clients fetch this once per connect, app focus/resume, after their own mutations and on
 * Sync now, and cache it locally — instead of holding seven live subscriptions, each of which
 * re-read and re-sent its whole result after every write it could see. The old queries stay,
 * unchanged, for clients from before this endpoint; both paths read the same tables.
 */
export const get = authedQuery({
  args: {},
  returns: v.object({
    me: v.union(userDtoValidator, v.null()),
    preferences: v.union(preferencesDtoValidator, v.null()),
    appRules: v.array(appRuleDtoValidator),
    snippets: v.array(snippetDtoValidator),
    dictionary: v.array(dictionaryEntryDtoValidator),
    devices: v.array(deviceDtoValidator),
    stats: v.union(statsDtoValidator, v.null())
  }),
  handler: async (ctx) => {
    if (!ctx.user)
      return {
        me: null,
        preferences: null,
        appRules: [],
        snippets: [],
        dictionary: [],
        devices: [],
        stats: null
      }
    const userId = ctx.user._id
    const [preferences, appRules, snippets, dictionary, devices, liveness, stats] = await Promise.all([
      ctx.db.query('preferences').withIndex('by_user', (q) => q.eq('userId', userId)).unique(),
      ctx.db.query('appRules').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('snippets').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('dictionaryEntries').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('devices').withIndex('by_user', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('deviceLiveness').withIndex('by_user_and_deviceId', (q) => q.eq('userId', userId)).collect(),
      ctx.db.query('stats').withIndex('by_user', (q) => q.eq('userId', userId)).unique()
    ])
    // The same orders the per-collection queries return, so the derive step is unchanged.
    const seen = new Map(liveness.map((l) => [l.deviceId, l.lastSeenAt]))
    return {
      me: toUserDto(ctx.user),
      preferences: preferences ? preferencesDto(preferences) : null,
      appRules: appRules.sort((a, b) => a.createdAt - b.createdAt).map(appRuleDto),
      snippets: snippets.sort((a, b) => b.createdAt - a.createdAt).map(snippetDto),
      dictionary: dictionary.sort((a, b) => b.createdAt - a.createdAt).map(dictionaryEntryDto),
      devices: devices
        .map((d) => ({ ...deviceDto(d), lastSeenAt: seen.get(d.deviceId) ?? d.lastSeenAt }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      stats: stats ? statsDto(stats) : null
    }
  }
})
