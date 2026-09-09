import { describe, expect, it, vi } from 'vitest'
import { basicCleanup, finish, prepareTranscript } from '../src/cleanup'
import { formatTranscript } from '../src/format'
import type { ChatMessage, Complete, FormatContext } from '../src/types'

const ctx: FormatContext = { category: 'chat', app: 'Slack', tone: 'casual', dictionary: [], language: 'auto' }

const answering =
  (...answers: string[]): Complete & { calls: ChatMessage[][] } => {
    const calls: ChatMessage[][] = []
    const fn = (async (messages: ChatMessage[]) => {
      calls.push(messages)
      const text = answers[Math.min(calls.length - 1, answers.length - 1)]
      return { text }
    }) as Complete & { calls: ChatMessage[][] }
    fn.calls = calls
    return fn
  }

describe('prepareTranscript', () => {
  it('extracts press enter and applies line commands before the model', () => {
    const p = prepareTranscript('thanks a lot new line see you tomorrow press enter')
    expect(p.pressEnter).toBe(true)
    expect(p.text).toBe('thanks a lot\nSee you tomorrow')
    expect(p.stages).toEqual(['press-enter', 'line-commands'])
  })
  it('turns spoken punctuation into marks', () => {
    expect(prepareTranscript('are you coming question mark').text).toBe('are you coming?')
  })
})

describe('basicCleanup', () => {
  it('tidies without a model: fillers, quotes, scratch that, casing, dictionary', () => {
    const r = basicCleanup('um so send it tomorrow. actually scratch that. send it to whisper flow today', {
      dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow'] }]
    })
    expect(r.text).toBe('Send it to Wispr Flow today')
    expect(r.stages).toContain('scratch-that')
    expect(r.stages).toContain('dictionary')
  })
  it('leaves numbers exactly as heard', () => {
    expect(basicCleanup('one million two hundred thousand dollars', { dictionary: [] }).text).toBe(
      'One million two hundred thousand dollars'
    )
  })
})

describe('finish', () => {
  const base = { category: 'chat' as const, dictionary: [], trailingSpace: true }
  it('re-asserts dictionary spellings, adds the trailing space and never re-cases (mid-sentence continuations)', () => {
    const f = finish('talk to Konvex about it.', {
      ...base,
      dictionary: [{ word: 'Convex', aliases: [], fuzzy: true }]
    })
    expect(f.text).toBe('talk to Convex about it. ')
    expect(f.stages).toEqual(['dictionary'])
  })
  it('expands snippets after the model and keeps their content verbatim', () => {
    const f = finish('sign off with my sig', {
      ...base,
      snippets: [{ trigger: 'my sig', content: 'Best,\nBen' }]
    })
    expect(f.text).toBe('sign off with Best,\nBen ')
    expect(f.snippetsExpanded).toEqual(['my sig'])
  })
  it('keeps a terminal command on one line without a trailing period', () => {
    const f = finish('git commit -m "fix".\n', { ...base, category: 'terminal', trailingSpace: false })
    expect(f.text).toBe('git commit -m "fix"')
  })
  it('reports an empty result', () => {
    expect(finish('...', base).empty).toBe(true)
  })
})

describe('formatTranscript', () => {
  it('sends the raw transcript, not a rule-mangled one, and uses a verified answer', async () => {
    const complete = answering('The budget is $1,200,000.')
    const r = await formatTranscript(
      { transcript: 'the budget is one million two hundred thousand dollars', mode: 'smart', context: ctx },
      complete
    )
    expect(r.text).toBe('The budget is $1,200,000.')
    expect(r.status).toMatchObject({ outcome: 'used', attempts: 1 })
    const user = complete.calls[0][complete.calls[0].length - 1]
    expect(user.role).toBe('user')
    expect(user.content).toContain('Transcript:\nthe budget is one million two hundred thousand dollars')
    expect(complete.calls[0][0].role).toBe('system')
  })

  it('retries once in strict mode after a rejected answer, then uses the good one', async () => {
    const complete = answering('The code is 7.', 'The code is 0007.')
    const r = await formatTranscript(
      { transcript: 'the code is zero zero zero seven', mode: 'smart', context: ctx },
      complete
    )
    expect(r.text).toBe('The code is 0007.')
    expect(r.status.outcome).toBe('used')
    expect(r.status.attempts).toBe(2)
    expect(r.status.retriedAfter).toMatch(/^numbers-changed/)
    const strictUser = complete.calls[1][complete.calls[1].length - 1].content
    expect(strictUser).toContain('Strict:')
    expect(r.stages).toContain('llm-strict')
  })

  it('falls back to the rule-based cleanup of the transcript when both attempts fail', async () => {
    const complete = answering('The code is 7.', 'Sure! The code is 0007.')
    const r = await formatTranscript(
      { transcript: 'um the code is zero zero zero seven', mode: 'smart', context: ctx },
      complete
    )
    expect(r.status.outcome).toBe('rejected')
    expect(r.status.detail).toBe('chatty')
    expect(r.status.attempts).toBe(2)
    expect(r.text).toBe('The code is zero zero zero seven')
    expect(r.modelText).toBe('Sure! The code is 0007.')
  })

  it('falls back when the model call throws', async () => {
    const complete: Complete = vi.fn(async () => {
      throw new Error('boom')
    })
    const r = await formatTranscript({ transcript: 'hello there everyone', mode: 'smart', context: ctx }, complete)
    expect(r.status).toMatchObject({ outcome: 'failed', detail: 'boom', attempts: 1 })
    expect(r.text).toBe('Hello there everyone')
  })

  it('treats a truncated completion as a rejection', async () => {
    const complete: Complete = vi.fn(async () => ({ text: 'Hello there', finishReason: 'length' }))
    const r = await formatTranscript(
      { transcript: 'hello there everyone how are you', mode: 'smart', context: ctx, retry: false },
      complete
    )
    expect(r.status).toMatchObject({ outcome: 'rejected', detail: 'too-long' })
  })

  it('skips the model for light and off modes and for tiny dictations', async () => {
    const complete = vi.fn(async () => ({ text: 'nope' }))
    const light = await formatTranscript({ transcript: 'um hello there', mode: 'light', context: ctx }, complete)
    expect(light.text).toBe('Hello there')
    expect(light.status).toMatchObject({ outcome: 'skipped', detail: 'light mode' })
    const off = await formatTranscript({ transcript: 'um hello there', mode: 'off', context: ctx }, complete)
    expect(off.text).toBe('um hello there')
    const tiny = await formatTranscript({ transcript: 'okay thanks', mode: 'smart', context: ctx }, complete)
    expect(tiny.status.detail).toBe('shorter than 3 words')
    expect(tiny.text).toBe('Okay thanks')
    const none = await formatTranscript({ transcript: 'hello there everyone', mode: 'smart', context: ctx }, null)
    expect(none.status.detail).toBe('no model configured')
    expect(complete).not.toHaveBeenCalled()
  })

  it('carries press enter through and keeps it out of the transcript', async () => {
    const complete = answering('See you tomorrow.')
    const r = await formatTranscript(
      { transcript: 'see you tomorrow press enter', mode: 'smart', context: ctx },
      complete
    )
    expect(r.pressEnter).toBe(true)
    expect(complete.calls[0][complete.calls[0].length - 1].content).not.toMatch(/press enter/)
    expect(r.stages).toEqual(['press-enter', 'llm'])
  })
})
