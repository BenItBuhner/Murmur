import { describe, expect, it } from 'vitest'
import { finishOnServer } from '../convex/lib/gatewayCore'
import { parseFinishRequest, parseFormatRequest } from '../convex/lib/inference'

const ctx = (extra: Record<string, unknown> = {}) => {
  const r = parseFormatRequest({ transcript: 'x', context: { category: 'chat', ...extra } })
  if (!r.ok) throw new Error(r.message)
  return r.request.context
}

describe('finishing on the server (Ephemeris clients)', () => {
  it('reads nothing from a request that does not ask', () => {
    expect(parseFinishRequest(undefined)).toBeNull()
    expect(parseFinishRequest([1])).toBeNull()
  })

  it('applies dictionary spellings, snippets and the trailing space', () => {
    const req = parseFinishRequest({ trailingSpace: true, snippets: [{ trigger: 'my sign off', content: 'Cheers, B' }] })!
    const out = finishOnServer('Thanks for the help my sign off', ctx({ dictionary: [{ word: 'Ephemeris', aliases: ['ephemerous'] }] }), req)
    expect(out.text).toBe('Thanks for the help Cheers, B ')
    expect(out.stages).toContain('snippets')
    const spelled = finishOnServer('I use ephemerous daily.', ctx({ dictionary: [{ word: 'Ephemeris', aliases: ['ephemerous'] }] }), req)
    expect(spelled.text).toBe('I use Ephemeris daily. ')
  })

  it('leaves the trailing space off when asked, and reads {date} on the user clock', () => {
    const req = parseFinishRequest({ trailingSpace: false, utcOffsetMinutes: -360, snippets: [{ trigger: 'today', content: '{date}' }] })!
    // 03:00 UTC on Jan 2 is still Jan 1 at UTC-6.
    const out = finishOnServer('today', ctx(), req, Date.UTC(2027, 0, 2, 3, 0))
    expect(out.text.endsWith(' ')).toBe(false)
    expect(out.text).not.toContain('{date}')
  })

  it('bounds what it takes', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ trigger: `t${i}`, content: 'c' }))
    expect(parseFinishRequest({ snippets: many })!.snippets.length).toBe(500)
    expect(parseFinishRequest({ utcOffsetMinutes: 99999 })!.utcOffsetMinutes).toBe(840)
  })
})
