import { describe, expect, it } from 'vitest'
import { resolveStyle } from '@engine'
import { defaultSettings, parseSettings } from '@shared/settings'
import {
  appRuleFromRemote,
  appRulesSpec,
  extractPreferences,
  preferencesPatch,
  sameAppRule,
  toFormattingPatch
} from '../src/main/cloud/reducers'

describe('profiles in settings and sync', () => {
  it('a fresh install uses the Default profile; older files parse to it', () => {
    expect(defaultSettings().formatting.profile).toBe('default')
    expect(parseSettings({ formatting: { tone: 'casual' } }).formatting.profile).toBe('default')
  })

  it('a profile this build does not know survives a round trip and reads as Default', () => {
    const s = parseSettings({ formatting: { profile: 'from-the-future' } })
    expect(s.formatting.profile).toBe('from-the-future')
    const style = resolveStyle(s.formatting, [], { app: 'x', title: '', category: 'email' })
    expect(style.profile).toBe('default')
  })

  it('the global profile is a synced preference', () => {
    const a = defaultSettings()
    const b = { ...a, formatting: { ...a.formatting, profile: 'casual' } }
    const patch = preferencesPatch(extractPreferences(a), extractPreferences(b))
    expect(patch.formatting?.profile).toBe('casual')
    expect(toFormattingPatch({ profile: 'polished' })).toEqual({ profile: 'polished' })
  })

  it("a rule's profile syncs with the rule, and only when it is set", () => {
    const base = { id: 'r1', match: 'slack', tone: 'auto' as const }
    expect(sameAppRule(base, { ...base, profile: 'casual' })).toBe(false)
    expect(appRuleFromRemote({ id: 'x', match: 'slack', tone: 'auto', profile: 'casual' })).toEqual(
      {
        id: 'x',
        match: 'slack',
        tone: 'auto',
        profile: 'casual'
      }
    )
    const fromOp = appRulesSpec.fromOp(
      {
        id: 'op',
        kind: 'appRules.upsert',
        localId: 'r1',
        rule: { match: 'slack', tone: 'auto', createdAt: 1 }
      },
      'r1'
    )
    expect('profile' in fromOp).toBe(false)
  })
})
