import { describe, expect, it, vi } from 'vitest'
import { basicCleanup, finish, prepareTranscript } from '../src/cleanup'
import { applyDictionary } from '../src/dictionary'
import { formatTranscript } from '../src/format'
import type { ChatMessage, Complete, FormatContext } from '../src/types'

const ctx: FormatContext = {
  category: 'chat',
  app: 'Slack',
  tone: 'casual',
  dictionary: [],
  language: 'auto'
}

const answering = (...answers: string[]): Complete & { calls: ChatMessage[][] } => {
  const calls: ChatMessage[][] = []
  const fn: Complete = async (messages) => {
    calls.push(messages)
    const text = answers[Math.min(calls.length - 1, answers.length - 1)]
    return { text }
  }
  return Object.assign(fn, { calls })
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
  it("leaves the speech model's words alone, a cut contraction included", () => {
    const p = prepareTranscript("I don' think so. They didn’ call. It hasn' shipped press enter")
    expect(p.text).toBe("I don' think so. They didn’ call. It hasn' shipped")
    expect(p.stages).toEqual(['press-enter'])
  })
})

describe('basicCleanup', () => {
  it('tidies without a model: fillers, quotes, scratch that, casing, dictionary', () => {
    const r = basicCleanup(
      'um so send it tomorrow. actually scratch that. send it to whisper flow today',
      {
        dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow'] }]
      }
    )
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
    const f = finish('git commit -m "fix".\n', {
      ...base,
      category: 'terminal',
      trailingSpace: false
    })
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
      {
        transcript: 'the budget is one million two hundred thousand dollars',
        mode: 'smart',
        context: ctx
      },
      complete
    )
    expect(r.text).toBe('The budget is $1,200,000.')
    expect(r.status).toMatchObject({ outcome: 'used', attempts: 1 })
    const user = complete.calls[0][complete.calls[0].length - 1]
    expect(user.role).toBe('user')
    expect(user.content).toContain(
      'Transcript:\nthe budget is one million two hundred thousand dollars'
    )
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
    const r = await formatTranscript(
      { transcript: 'hello there everyone', mode: 'smart', context: ctx },
      complete
    )
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
    const light = await formatTranscript(
      { transcript: 'um hello there', mode: 'light', context: ctx },
      complete
    )
    expect(light.text).toBe('Hello there')
    expect(light.status).toMatchObject({ outcome: 'skipped', detail: 'light mode' })
    const off = await formatTranscript(
      { transcript: 'um hello there', mode: 'off', context: ctx },
      complete
    )
    expect(off.text).toBe('um hello there')
    const tiny = await formatTranscript(
      { transcript: 'okay thanks', mode: 'smart', context: ctx },
      complete
    )
    expect(tiny.status.detail).toBe('shorter than 3 words')
    expect(tiny.text).toBe('Okay thanks')
    const none = await formatTranscript(
      { transcript: 'hello there everyone', mode: 'smart', context: ctx },
      null
    )
    expect(none.status.detail).toBe('no model configured')
    expect(complete).not.toHaveBeenCalled()
  })

  it('finishes an already clean short dictation with the rules and never calls the model', async () => {
    const complete = vi.fn(async () => ({ text: 'nope' }))
    const r = await formatTranscript(
      {
        transcript: 'Sounds good, i will send it to whisper flow tomorrow.',
        mode: 'smart',
        context: { ...ctx, dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow'] }] }
      },
      complete
    )
    expect(complete).not.toHaveBeenCalled()
    expect(r.status).toEqual({ outcome: 'skipped-clean', detail: 'already clean', attempts: 0 })
    expect(r.text).toBe('Sounds good, I will send it to Wispr Flow tomorrow.')
    expect(r.stages).toEqual(['dictionary', 'capitalize'])
    expect(r.llmMs).toBe(0)
    expect(r.modelText).toBeUndefined()
  })

  it('keeps calling the model when the clean skip is turned off or the transcript is not clean', async () => {
    const complete = answering('Sounds good, see you tomorrow.')
    const off = await formatTranscript(
      { transcript: 'Sounds good, see you tomorrow.', mode: 'smart', context: ctx, cleanMaxWords: 0 },
      complete
    )
    expect(off.status.outcome).toBe('used')
    const filler = await formatTranscript(
      { transcript: 'Sounds good, um, see you tomorrow.', mode: 'smart', context: ctx },
      complete
    )
    expect(filler.status.outcome).toBe('used')
    expect(complete.calls).toHaveLength(2)
  })

  it('ranks the clean skip after mode, size and model availability', async () => {
    const complete = vi.fn(async () => ({ text: 'nope' }))
    const light = await formatTranscript(
      { transcript: 'Sounds good, see you tomorrow.', mode: 'light', context: ctx },
      complete
    )
    expect(light.status).toMatchObject({ outcome: 'skipped', detail: 'light mode' })
    const none = await formatTranscript(
      { transcript: 'Sounds good, see you tomorrow.', mode: 'smart', context: ctx },
      null
    )
    expect(none.status).toMatchObject({ outcome: 'skipped', detail: 'no model configured' })
    const tiny = await formatTranscript(
      { transcript: 'Sounds good.', mode: 'smart', context: ctx },
      complete
    )
    expect(tiny.status).toMatchObject({ outcome: 'skipped', detail: 'shorter than 3 words' })
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

describe('apostrophes, quotes and non-ASCII punctuation', () => {
  const ASCII = "I don't recall, it's fine, we'll see, Bennett's phone."
  const CURLY = 'I don’t recall, it’s fine, we’ll see, Bennett’s phone.'
  const MARKS = 'She said “it’s ‘fine’” — sure… café, naïve, “don’t”.'
  const dictionary = [
    { word: 'Bennett', aliases: ['bennet'], fuzzy: true },
    { word: 'T3 Chat', aliases: [] }
  ]
  const withDictionary: FormatContext = { ...ctx, dictionary }

  it('keeps every character through prepare, the rule-based cleanup and finishing', () => {
    for (const text of [ASCII, CURLY, MARKS]) {
      const prepared = prepareTranscript(text)
      expect(prepared.text).toBe(text)
      expect(basicCleanup(prepared.text, { dictionary }).text).toBe(text)
      expect(finish(text, { category: 'chat', dictionary, trailingSpace: true }).text).toBe(
        `${text} `
      )
      expect(finish(text, { category: 'terminal', dictionary, trailingSpace: false }).text).toBe(
        text.replace(/\.$/, '')
      )
    }
  })

  it('corrects an entry inside its possessive and keeps the punctuation after the word', () => {
    expect(applyDictionary("that is bennet's phone", dictionary)).toBe("that is Bennett's phone")
    expect(applyDictionary('that is bennet’s phone', dictionary)).toBe('that is Bennett’s phone')
    expect(finish("bennet's phone", { category: 'chat', dictionary, trailingSpace: false }).text).toBe(
      "Bennett's phone"
    )
    const bennetts = [{ word: 'Bennetts', aliases: ['bennets'] }]
    expect(applyDictionary("the bennets' house", bennetts)).toBe("the Bennetts' house")
    expect(applyDictionary('the Bennetts’ house', bennetts)).toBe('the Bennetts’ house')
    expect(applyDictionary("call it 'Bennet' for now", dictionary)).toBe("call it 'Bennett' for now")
  })

  it('keeps contractions inside spoken quotes and next to fillers', () => {
    expect(
      basicCleanup("um he said quote I don't know end quote and uh it's fine", { dictionary })
        .text
    ).toBe('He said "I don\'t know" and it\'s fine')
    expect(basicCleanup('um I can’t go uh it’s late', { dictionary }).text).toBe('I can’t go it’s late')
  })

  it('keeps contractions when the clean skip finishes the transcript without a model', async () => {
    for (const text of [ASCII, CURLY]) {
      const complete = answering('unused')
      const r = await formatTranscript({ transcript: text, mode: 'smart', context: withDictionary }, complete)
      expect(r.status.outcome).toBe('skipped-clean')
      expect(complete.calls).toHaveLength(0)
      expect(r.text).toBe(text)
    }
  })

  it('keeps a model answer that writes typographic apostrophes and quotes', async () => {
    const transcript = "what are you referring to i don't recall i have the worst memory in the world"
    const answer = 'What are you referring to? I don’t recall — I have the worst memory in the world…'
    const r = await formatTranscript(
      { transcript, mode: 'smart', context: withDictionary },
      answering(answer)
    )
    expect(r.status.outcome).toBe('used')
    expect(r.text).toBe(answer)
    expect(finish(r.text, { category: 'chat', dictionary, trailingSpace: true }).text).toBe(`${answer} `)
  })

  it('keeps contractions in the fallback when the model fails or is off', async () => {
    const transcript = "i don't recall, it's fine, we'll see, bennet said so"
    const failed = await formatTranscript(
      { transcript, mode: 'smart', context: withDictionary },
      async () => {
        throw new Error('down')
      }
    )
    expect(failed.text).toBe("I don't recall, it's fine, we'll see, Bennett said so")
    const off = await formatTranscript({ transcript, mode: 'off', context: withDictionary }, null)
    expect(off.text).toBe(transcript)
  })
})
