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
    ],
    // Numbers are compared as whole values: the model may write one differently ...
    ['one hundred thousand people came', '100,000 people came.', '100,000 people came.', strict, 0],
    ['the number is 1,000,000', 'The number is 1000000.', 'The number is 1000000.', strict, 0],
    ['the number is 1000000', 'The number is 1,000,000.', 'The number is 1,000,000.', strict, 0],
    ['it costs 100 dollars', 'It costs $100.', 'It costs $100.', strict, 0],
    ['it costs twenty five bucks', 'It costs $25.', 'It costs $25.', strict, 0],
    ['ten dollars and fifty cents', '$10.50.', '$10.50.', strict, 0],
    ['it is 20 percent', 'It is 20%.', 'It is 20%.', strict, 0],
    ['the pin is zero zero zero zero', 'The pin is 0000.', 'The pin is 0000.', strict, 0],
    ['the code is 4 0 0 7', 'The code is 4007.', 'The code is 4007.', strict, 0],
    ['call 555 1212', 'Call 555-1212.', 'Call 555-1212.', strict, 0],
    ['meet at five thirty', 'Meet at 5:30.', 'Meet at 5:30.', strict, 0],
    ['meet at 5 pm', 'Meet at 5pm.', 'Meet at 5pm.', strict, 0],
    [
      'we have one point five million users',
      'We have 1.5 million users.',
      'We have 1.5 million users.',
      strict,
      0
    ],
    ['it took two and a half hours', 'It took 2.5 hours.', 'It took 2.5 hours.', strict, 0],
    ['on June third', 'On June 3rd.', 'On June 3rd.', strict, 0],
    ['we got second place', 'We got 2nd place.', 'We got 2nd place.', strict, 0],
    ['I have five apples', 'I have 5 apples.', 'I have 5 apples.', strict, 0],
    // ... digits never go back to words ...
    ['I have 5 apples', 'I have five apples.', 'I have 5 apples.', strict, 0],
    ['the total is 1,000,000', 'The total is one million.', 'The total is 1,000,000.', strict, 0],
    // ... and a number is never changed, dropped or de-duplicated, at any freedom level.
    ['the number is 1,000,000', 'The number is 1,000.', 'The number is 1,000,000.', natural, 1],
    ['the number is 1000 000', 'The number is 1000.', 'The number is 1000 000.', natural, 1],
    ['the code is 4007', 'The code is 407.', 'The code is 4007.', natural, 1],
    ['the rate is 2.5', 'The rate is 25.', 'The rate is 2.5.', natural, 1],
    ['it is 1000', 'It is 100.', 'It is 1000.', natural, 1],
    ['it costs $25', 'It costs €25.', 'It costs $25.', natural, 1],
    ['it costs 1000 dollars', 'It costs $100.', 'It costs 1000 dollars.', natural, 1],
    [
      'the pin is zero zero zero zero',
      'The pin is 0.',
      'The pin is zero zero zero zero.',
      natural,
      1
    ],
    ['the pin is 0 0 0 0', 'The pin is 0.', 'The pin is 0 0 0 0.', natural, 1],
    ['the pin is zero zero seven', 'The PIN is 7.', 'The PIN is zero zero seven.', natural, 1],
    ['I said one two one two', 'I said one two.', 'I said one two one two.', natural, 1],
    ['send 5 5 5 copies', 'Send 5 copies.', 'Send 5 5 5 copies.', natural, 1],
    ['the code is A1 A1 B2', 'The code is A1 B2.', 'The code is A1 A1 B2.', natural, 1],
    ['account 4444 1111', 'Account 4444.', 'Account 4444 1111.', natural, 1],
    ['version 2.0.0 is out', 'Version 2.0 is out.', 'Version 2.0.0 is out.', natural, 1],
    ['meet at five thirty', 'Meet at 530.', 'Meet at five thirty.', natural, 1],
    ['meet at 5 pm', 'Meet at 6 pm.', 'Meet at 5 pm.', natural, 1],
    ['one hundred thousand', '100.', 'one hundred thousand.', natural, 1],
    [
      'we need milk and eggs',
      'We need 2 things: milk and eggs.',
      'We need milk and eggs.',
      natural,
      1
    ],
    // a spoken correction of a number is still a correction
    ['at 5, sorry, 6 pm', 'At 6 pm.', 'At 6 pm.', strict, 0],
    // enumerators may become list markers when lists are allowed
    [
      'first finish the deck second email the vendor',
      '1. Finish the deck\n2. Email the vendor',
      '1. Finish the deck\n2. Email the vendor',
      base,
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
    // A rejected "1." marker leaves no stray dot behind the enumerator it replaced.
    const numbered = reviewLlmEdits(
      'first finish the deck second email the vendor',
      '1. Finish the deck\n2. Email the vendor',
      { ...base, allowNewLines: false }
    )
    expect(numbered.text).toBe('first finish the deck second email the vendor')
  })
  it('never lets the alignment run through the middle of a number', () => {
    // "hundred" used to align with "100" and the merge read "one 100 thousand."
    const r = reviewLlmEdits('one hundred thousand', '100,000.', base)
    expect(r.text).toBe('100,000.')
    expect(r.reverted).toBe(0)
    const dollars = reviewLlmEdits('it costs 100 dollars', 'It costs $100.', base)
    expect(dollars.text).toBe('It costs $100.')
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
