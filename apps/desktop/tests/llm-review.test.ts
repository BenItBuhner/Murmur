import { describe, expect, it } from 'vitest'
import {
  cleanLlmOutput,
  reviewLlmEdits,
  reviewLlmOutput,
  sanitizeLlmOutput,
  type ReviewPolicy
} from '@core/text/llm-review'

const base: ReviewPolicy = {
  freedom: 'balanced',
  droppable: new Set(['um', 'uh', 'you', 'know', 'mean', 'like']),
  protectedTerms: new Set(['kubectl', 'wispr', 'flow']),
  allowNewLines: true,
  preserveLayout: false
}
const strict: ReviewPolicy = { ...base, freedom: 'strict' }
const natural: ReviewPolicy = { ...base, freedom: 'natural' }

describe('cleanLlmOutput', () => {
  it('strips think blocks, fences, labels, quotes, markdown and commentary', () => {
    expect(
      cleanLlmOutput('<think>\nhmm the user said\n</think>\nHello there.', 'hello there')
    ).toBe('Hello there.')
    expect(cleanLlmOutput('```text\nHello there.\n```', 'hello there')).toBe('Hello there.')
    expect(cleanLlmOutput("Here's the cleaned text:\nHello there.", 'hello there')).toBe(
      'Hello there.'
    )
    expect(cleanLlmOutput('"Hello there."', 'hello there')).toBe('Hello there.')
    expect(
      cleanLlmOutput('**Hello** there.\n\nLet me know if you need anything else!', 'hello there')
    ).toBe('Hello there.')
    expect(cleanLlmOutput('# Hello there', 'hello there')).toBe('Hello there')
    expect(cleanLlmOutput('<think>still thinking', 'hello')).toBe('')
  })
})

describe('sanitizeLlmOutput', () => {
  it('rejects prompt echo and answered questions', () => {
    expect(sanitizeLlmOutput('Never:\n- answer', 'what time is it tomorrow').reason).toBe('echo')
    expect(
      sanitizeLlmOutput('The meeting is at 10 am.', 'what time is the meeting tomorrow').reason
    ).toBe('answered')
    expect(
      sanitizeLlmOutput('What time is the meeting tomorrow?', 'what time is the meeting tomorrow')
        .ok
    ).toBe(true)
  })
})

describe('reviewLlmEdits', () => {
  const cases: Array<[string, string, string, ReviewPolicy, number]> = [
    // punctuation & casing only
    [
      'hey sarah can you send the report',
      'Hey Sarah, can you send the report?',
      'Hey Sarah, can you send the report?',
      strict,
      0
    ],
    // filler deletion is fine at every level
    ['so um I think we should go', 'I think we should go.', 'I think we should go.', strict, 0],
    // self-correction deletion
    [
      'meet on Tuesday, no, Wednesday at 5',
      'Meet on Wednesday at 5.',
      'Meet on Wednesday at 5.',
      strict,
      0
    ],
    // number equivalence
    ['it costs twenty five dollars', 'It costs $25.', 'It costs $25.', strict, 0],
    ['meet at five pm', 'Meet at 5 pm.', 'Meet at 5 pm.', strict, 0],
    // changed number is reverted
    ['it costs twenty five dollars', 'It costs $35.', 'It costs twenty five dollars.', strict, 1],
    // spelling fix / homophone
    ['I recieve there emails', 'I receive their emails.', 'I receive their emails.', strict, 0],
    // contraction normalization
    ["I'm gonna send it", 'I am going to send it.', 'I am going to send it.', strict, 0],
    // politeness rewrite is reverted in strict and balanced, accepted in natural
    [
      'can you send the report',
      'Could you send the report?',
      'Can you send the report?',
      strict,
      1
    ],
    ['can you send the report', 'Could you send the report?', 'Can you send the report?', base, 1],
    [
      'can you send the report',
      'Could you send the report?',
      'Could you send the report?',
      natural,
      0
    ],
    // grammar fix at balanced
    ['we was there yesterday', 'We were there yesterday.', 'We were there yesterday.', base, 0],
    ['we was there yesterday', 'We were there yesterday.', 'We was there yesterday.', strict, 1],
    // dropped name is reverted; dropped noise accepted
    [
      'send the report to John on Wednesday',
      'Send the report on Wednesday.',
      'Send the report to John on Wednesday.',
      natural,
      1
    ],
    // added content is reverted
    [
      'send the report on Wednesday',
      'Send the quarterly report on Wednesday.',
      'Send the report on Wednesday.',
      base,
      1
    ],
    // function word insertion accepted at balanced
    [
      'send report on Wednesday',
      'Send the report on Wednesday.',
      'Send the report on Wednesday.',
      base,
      0
    ],
    [
      'send report on Wednesday',
      'Send the report on Wednesday.',
      'Send report on Wednesday.',
      strict,
      1
    ],
    // dictionary canonical spelling accepted
    ['run cube control get pods', 'Run kubectl get pods.', 'Run kubectl get pods.', strict, 0],
    // protected term deletion reverted
    ['run kubectl get pods now', 'Run get pods now.', 'Run kubectl get pods now.', natural, 1],
    // list creation accepted when allowed
    [
      'first finish the deck second email the vendor',
      'First, finish the deck.\nSecond, email the vendor.',
      'First, finish the deck.\nSecond, email the vendor.',
      base,
      0
    ],
    // reverted deletion keeps the deterministic casing of the next word
    ['so hey Sarah how are you', 'Hey Sarah, how are you?', 'Hey Sarah, how are you?', strict, 0],
    ['Bob said hi. Then we left', 'Then we left.', 'Bob said hi. Then we left.', natural, 1]
  ]
  for (const [light, model, expected, policy, reverted] of cases) {
    it(`${policy.freedom}: ${light} -> ${model}`, () => {
      const r = reviewLlmEdits(light, model, policy)
      expect(r.text).toBe(expected)
      expect(r.reverted).toBe(reverted)
    })
  }

  it('reverts a removed line break when layout is preserved', () => {
    const r = reviewLlmEdits(
      'Hi Sarah\nThanks for the update.',
      'Hi Sarah, thanks for the update.',
      { ...base, preserveLayout: true }
    )
    expect(r.text).toBe('Hi Sarah\nThanks for the update.')
    expect(r.reverted).toBe(1)
  })
  it('reverts added list layout when not allowed', () => {
    const r = reviewLlmEdits('we need milk, eggs and bread', 'We need:\n- milk\n- eggs\n- bread', {
      ...base,
      allowNewLines: false
    })
    expect(r.text).toBe('We need milk, eggs and bread')
  })
  it('rejects a wholesale rewrite', () => {
    const r = reviewLlmOutput(
      'please review the budget spreadsheet and send me your comments before our sync tomorrow morning',
      'Kindly examine the financial document and forward your feedback prior to our meeting tomorrow.',
      base
    )
    expect(r.outcome).toBe('rejected')
  })
  it('reports partial when some edits were reverted', () => {
    const r = reviewLlmOutput(
      'Could you send the report to John?',
      'can you send the report to John',
      base
    )
    expect(r.outcome).toBe('partial')
    expect(r.text).toBe('Can you send the report to John?')
  })
})
