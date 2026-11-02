import { describe, expect, it } from 'vitest'
import {
  AUTOCORRECT_SYSTEM_PROMPT,
  AUTOCORRECT_TEMPERATURE,
  autocorrectMaxTokens,
  buildAutocorrectMessages,
  splitAutocorrectInput
} from '../src/autocorrect'

describe('splitAutocorrectInput', () => {
  it('keeps the AHK default prompt when the text has no brace block', () => {
    const text = 'hey can u send me the report tmrw'
    expect(splitAutocorrectInput(text)).toEqual({
      systemPrompt: AUTOCORRECT_SYSTEM_PROMPT,
      userText: text
    })
  })

  it('uses the first {instructions} block as the system prompt, the way the AHK script does', () => {
    expect(splitAutocorrectInput('{Make it formal}hey can u send it')).toEqual({
      systemPrompt: 'Make it formal',
      userText: 'hey can u send it'
    })
  })

  it('takes only the first block when more than one is present', () => {
    expect(splitAutocorrectInput('{tone: terse}one {leave this} two')).toEqual({
      systemPrompt: 'tone: terse',
      userText: 'one {leave this} two'
    })
  })

  it('strips every copy of the first matched block, the way AHK StrReplace does', () => {
    expect(splitAutocorrectInput('{x}hello{x}')).toEqual({
      systemPrompt: 'x',
      userText: 'hello'
    })
  })

  it('keeps an empty instruction when the braces are empty', () => {
    expect(splitAutocorrectInput('{}unchanged words')).toEqual({
      systemPrompt: '',
      userText: 'unchanged words'
    })
  })
})

describe('buildAutocorrectMessages', () => {
  it('sends the AHK system prompt and the selection, nothing else', () => {
    expect(buildAutocorrectMessages('its broken')).toEqual([
      { role: 'system', content: AUTOCORRECT_SYSTEM_PROMPT },
      { role: 'user', content: 'its broken' }
    ])
  })

  it('does not invent a second correction language around embedded instructions', () => {
    const messages = buildAutocorrectMessages('{British spelling}colour it in')
    expect(messages[0]).toEqual({ role: 'system', content: 'British spelling' })
    expect(messages[1]).toEqual({ role: 'user', content: 'colour it in' })
  })
})

describe('autocorrect sizing', () => {
  it('uses the AHK temperature and leaves room for the whole selection', () => {
    expect(AUTOCORRECT_TEMPERATURE).toBe(0.2)
    expect(autocorrectMaxTokens('one two')).toBe(1024)
    expect(autocorrectMaxTokens(Array.from({ length: 1000 }, () => 'word').join(' '))).toBe(4096)
  })
})
