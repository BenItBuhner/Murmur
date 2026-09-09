import { describe, expect, it } from 'vitest'
import { classifyApp, resolveStyle } from '../src/context'
import {
  EXAMPLES,
  SYSTEM_PROMPT,
  buildCommandMessages,
  buildFormatMessages,
  userMessage
} from '../src/prompt'
import type { FormatContext } from '../src/types'

const ctx: FormatContext = {
  category: 'chat',
  app: 'Slack',
  tone: 'casual',
  language: 'auto',
  dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow', 'wisper flo', 'whisperflow'] }],
  keepVerbatim: ['my sig'],
  precedingText: 'I think we should',
  instructions: 'British spelling.\nDates as ISO.'
}

describe('buildFormatMessages', () => {
  it('keeps everything before the last user turn static so providers can cache it', () => {
    const a = buildFormatMessages('hello there', ctx)
    const b = buildFormatMessages('something else entirely', {
      category: 'terminal',
      tone: 'neutral',
      dictionary: [],
      language: 'de'
    })
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1))
    expect(a[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(a.length).toBe(2 + EXAMPLES.length * 2)
  })

  it('puts every per-dictation fact in the user message', () => {
    const user = userMessage('um hello there', ctx)
    expect(user).toBe(
      [
        'Destination: a chat message (Slack). Tone: casual.',
        'Language: the one the speaker used; never translate.',
        'Dictionary: Wispr Flow (heard as "whisper flow", "wisper flo").',
        'Keep verbatim: "my sig".',
        'Before the cursor: "I think we should"',
        'Instructions: British spelling. Dates as ISO.',
        '',
        'Transcript:',
        'um hello there'
      ].join('\n')
    )
  })

  it('pins a fixed language and adds the strict line on retry', () => {
    const user = userMessage(
      'hallo',
      { category: 'email', tone: 'professional', dictionary: [], language: 'de' },
      true
    )
    expect(user).toContain('Language: German.')
    expect(user).toContain('Strict:')
  })

  it('stays small', () => {
    const chars = buildFormatMessages('hello there', ctx).reduce((n, m) => n + m.content.length, 0)
    expect(chars).toBeLessThan(6500)
  })

  it('examples use the same layout as the real message', () => {
    for (const [exCtx, input] of EXAMPLES) {
      const msg = userMessage(input, exCtx)
      expect(msg.startsWith('Destination: ')).toBe(true)
      expect(msg).toContain('\n\nTranscript:\n')
    }
  })
})

describe('buildCommandMessages', () => {
  it('describes the edit', () => {
    const m = buildCommandMessages({
      selection: 'hello world',
      instruction: 'make it shout',
      category: 'code',
      dictionary: [],
      language: 'en'
    })
    expect(m[0].content).toContain('The user speaks English')
    expect(m[0].content).toContain('keep identifiers and syntax intact')
    expect(m[1].content).toBe('Instruction: make it shout\n\nText:\nhello world')
  })
})

describe('resolveStyle', () => {
  const prefs = {
    mode: 'smart' as const,
    tone: 'auto' as const,
    instructions: 'be brief',
    trailingSpace: true
  }
  it('derives tone from the destination and lets a rule override', () => {
    const slack = classifyApp('slack')
    expect(resolveStyle(prefs, [], slack).tone).toBe('casual')
    const styled = resolveStyle(
      prefs,
      [{ match: 'slack', tone: 'professional', instructions: 'no emoji' }],
      slack
    )
    expect(styled.tone).toBe('professional')
    expect(styled.instructions).toBe('be brief\n\nno emoji')
    expect(styled.rule?.match).toBe('slack')
  })
  it('classifies browser tabs by title', () => {
    expect(classifyApp('chrome', 'Inbox - Gmail').category).toBe('email')
    expect(classifyApp('Code.exe').category).toBe('code')
    expect(classifyApp('konsole').category).toBe('terminal')
  })
})
