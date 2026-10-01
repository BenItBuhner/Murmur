import { describe, expect, it } from 'vitest'
import { NAV, ROUTES, resolveRoute } from '../src/renderer/src/lib/navigation'

/**
 * The rail's structure (src/renderer/src/lib/navigation.ts): the same five destinations and names
 * as the Android drawer, the settings pages under one heading, the account only at the rail's foot,
 * and nothing listed twice.
 */
describe('sidebar structure', () => {
  it('lists Home, History, Dictionary and snippets, Style, then the settings pages under Settings', () => {
    expect(NAV.map((n) => n.label)).toEqual([
      'Home',
      'History',
      'Dictionary and snippets',
      'Style',
      'Speech model',
      'Shortcuts',
      'Microphone',
      'Dictation button',
      'Appearance',
      'General'
    ])
    expect(NAV.filter((n) => n.group).map((n) => [n.group, n.id])).toEqual([
      ['Personalize', 'dictionary'],
      ['Settings', 'providers']
    ])
  })

  it('has no duplicate ids or labels, no Account item and no Listening item', () => {
    const ids = NAV.map((n) => n.id)
    const labels = NAV.map((n) => n.label)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(labels).size).toBe(labels.length)
    expect(ids).not.toContain('account')
    expect(labels.some((l) => /account|listening/i.test(l))).toBe(false)
  })

  it('every screen the shell shows is a rail item or the account', () => {
    expect([...ROUTES].sort()).toEqual([...NAV.map((n) => n.id), 'account'].sort())
  })

  it('resolves the names the tray and deep links use, old and new', () => {
    for (const route of ROUTES) expect(resolveRoute(route)).toBe(route)
    expect(resolveRoute('snippets')).toBe('dictionary')
    expect(resolveRoute('models')).toBe('providers')
    expect(resolveRoute('settings')).toBe('general')
    expect(resolveRoute('nowhere')).toBeNull()
  })
})
