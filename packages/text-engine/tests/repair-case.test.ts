import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../src/format'
import type { FormatContext } from '../src/types'
import { repairCase } from '../src/verify'

const chat = { category: 'chat' as const }
const fix = (raw: string, text: string, ctx: Parameters<typeof repairCase>[2] = chat): string =>
  repairCase(raw, text, ctx)

describe('repairCase', () => {
  it('restores capitals a model dropped after sentence ends (Oct 27 phone dictation)', () => {
    const raw =
      "We can keep on working. We can keep on going and we can figure this shit out. I need you to figure it out. I'm fucking tired of it. I've fucking had it with you."
    const model =
      'we can keep on working. we can keep on going and we can figure this shit out. i need you to figure it out. i’m fucking tired of it. i’ve fucking had it with you.'
    expect(fix(raw, model)).toBe(
      'we can keep on working. We can keep on going and we can figure this shit out. I need you to figure it out. I’m fucking tired of it. I’ve fucking had it with you.'
    )
  })
  it('restores the pronoun I in a run-on (Oct 27)', () => {
    expect(
      fix(
        "possible. I'll give you more context. Right now, I think it's best",
        "the most amazing experience possible i'll give you more context, but right now, i think it's best"
      )
    ).toBe("the most amazing experience possible I'll give you more context, but right now, I think it's best")
  })
  it('leaves the first word alone (it may continue the text before the cursor)', () => {
    expect(fix('think what will help', 'think what will help. think again.')).toBe('think what will help. Think again.')
  })
  it('keeps abbreviations, ellipses and initialisms', () => {
    expect(fix('The CEOs, etc. And it can be', 'The CEOs are founders, etc. and it can be based on size.')).toBe(
      'The CEOs are founders, etc. and it can be based on size.'
    )
    expect(fix('a', 'Use e.g. this one, i.e. the second.')).toBe('Use e.g. this one, i.e. the second.')
    expect(fix('a', 'I was thinking... maybe not.')).toBe('I was thinking... maybe not.')
    expect(fix('a', 'We moved to the U.S. last year.')).toBe('We moved to the U.S. last year.')
  })
  it('keeps mixed-case words and words written that way in the transcript', () => {
    expect(fix('a', 'I bought it. iPhone sales are up. eBay too.')).toBe('I bought it. iPhone sales are up. eBay too.')
    expect(fix('version 2. npm install works', 'Version 2. npm install works.')).toBe('Version 2. npm install works.')
  })
  it('does not touch "i" inside words, paths, or a transcript that writes it lower case', () => {
    expect(fix('a', 'Set the iOS flag, run ./i and open i/o. The wi-fi is down.')).toBe(
      'Set the iOS flag, run ./i and open i/o. The wi-fi is down.'
    )
    expect(fix('for i in range', 'for i in range ten')).toBe('for i in range ten')
  })
  it('stays out of code, terminals and lower-case instructions', () => {
    expect(fix('a', 'git commit. then push', { category: 'code' })).toBe('git commit. then push')
    expect(fix('a', 'git commit. then push', { category: 'terminal' })).toBe('git commit. then push')
    expect(fix('a', 'hey. i am here', { category: 'chat', instructions: 'Write everything in lowercase.' })).toBe(
      'hey. i am here'
    )
  })
  it('keeps the lower-case style of the text before the cursor', () => {
    expect(fix('a', 'ok. i will be there', { category: 'chat', precedingText: 'yo are we still on for tonight' })).toBe(
      'ok. i will be there'
    )
    expect(fix('a', 'ok. i will be there', { category: 'chat', precedingText: 'Are we still on for tonight?' })).toBe(
      'ok. I will be there'
    )
    expect(fix('a', 'ok. i will be there', { category: 'chat', precedingText: 'ok' })).toBe('ok. I will be there')
  })
  it('handles questions, exclamations and closing quotes', () => {
    expect(fix('a', 'Really? because I doubt it! and "yes." then go')).toBe('Really? Because I doubt it! And "yes." Then go')
  })
  it('leaves correct text unchanged', () => {
    const t = "I think it's fine. We'll see. I'm sure."
    expect(fix(t, t)).toBe(t)
  })
})

describe('formatTranscript applies repairCase to a model answer', () => {
  const ctx: FormatContext = { category: 'chat', tone: 'casual', dictionary: [], language: 'auto' }
  it('and records the stage', async () => {
    const raw = 'We can keep on working. We can keep on going. I need you to figure it out.'
    const r = await formatTranscript({ transcript: raw, mode: 'smart', context: ctx, cleanMaxWords: 0 }, async () => ({
      text: 'we can keep on working. we can keep on going. i need you to figure it out.'
    }))
    expect(r.text).toBe('we can keep on working. We can keep on going. I need you to figure it out.')
    expect(r.stages).toContain('case')
    expect(r.status.outcome).toBe('used')
  })
})
