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
  dictionaryPhrases: new Set(['kubectl', 'wispr flow']),
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
    // a multi-word term the recognizer mangled, fixed by the model, survives the review
    ['I use whisper flow daily', 'I use Wispr Flow daily.', 'I use Wispr Flow daily.', strict, 0],
    [
      'install whisperflow today',
      'Install Wispr Flow today.',
      'Install Wispr Flow today.',
      strict,
      0
    ],
    ['try the whisper floh app', 'Try the Wispr Flow app.', 'Try the Wispr Flow app.', strict, 0],
    // ...but the model may not conjure a dictionary term the speaker never said
    [
      'send the report today',
      'Send the Wispr Flow report today.',
      'Send the report today.',
      base,
      1
    ],
    // protected term deletion reverted
    ['run kubectl get pods now', 'Run get pods now.', 'Run kubectl get pods now.', natural, 1],
    ['and Wispr Flow too', 'And too.', 'And Wispr Flow too.', natural, 1],
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
    ['Bob said hi. Then we left', 'Then we left.', 'Bob said hi. Then we left.', natural, 1],
    // deliberate repetition is the speaker's voice; flattening it is reverted at every level
    [
      'Fuck, fuck, fuck. This is so broken',
      'Fuck. This is so broken.',
      'Fuck, fuck, fuck. This is so broken.',
      natural,
      1
    ],
    ['go go go go', 'Go.', 'Go go go go.', natural, 1],
    ['yeah, yeah, yeah, I know', 'Yeah, I know.', 'Yeah, yeah, yeah, I know.', natural, 1],
    // ...while stutters of small words are still noise
    ['I, I think we should go', 'I think we should go.', 'I think we should go.', strict, 0],
    ['the the report is ready', 'The report is ready.', 'The report is ready.', strict, 0],
    // spoken quote commands the rules missed, turned into marks by the model
    [
      'he said quote I will be late end quote and left',
      'He said "I will be late" and left.',
      'He said "I will be late" and left.',
      strict,
      0
    ],
    [
      'She told me, quote, do not touch that, end quote.',
      'She told me, "Do not touch that."',
      'She told me, "Do not touch that."',
      strict,
      0
    ]
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
