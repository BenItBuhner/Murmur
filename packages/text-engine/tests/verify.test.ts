import { describe, expect, it } from 'vitest'
import { cleanModelOutput, verifyOutput } from '../src/verify'

describe('cleanModelOutput', () => {
  it('strips reasoning, fences, labels, quotes and commentary', () => {
    expect(cleanModelOutput('<think>hmm</think>Hello there.', 'hello there')).toBe('Hello there.')
    expect(cleanModelOutput('<think>never closed', 'x')).toBe('')
    expect(cleanModelOutput('```\nHello there.\n```', 'hello there')).toBe('Hello there.')
    expect(cleanModelOutput('Cleaned text: Hello there.', 'hello there')).toBe('Hello there.')
    expect(cleanModelOutput('"Hello there."', 'hello there')).toBe('Hello there.')
    expect(
      cleanModelOutput('Hello there.\n\nLet me know if you need anything else!', 'hello there')
    ).toBe('Hello there.')
    expect(cleanModelOutput('**Hello** there.', 'hello there')).toBe('Hello there.')
    expect(cleanModelOutput('<transcript>Hello there.</transcript>', 'hello there')).toBe(
      'Hello there.'
    )
  })
  it('keeps quotes the speaker dictated', () => {
    expect(cleanModelOutput('"Hands off," she said.', '"hands off" she said')).toBe(
      '"Hands off," she said.'
    )
  })
})

describe('verifyOutput', () => {
  const ok = (raw: string, out: string): void => {
    const v = verifyOutput(raw, out)
    expect(v, `${raw} -> ${out}: ${v.reason ?? ''} ${v.expected ?? ''} ${v.actual ?? ''}`).toEqual({
      ok: true
    })
  }
  const bad = (raw: string, out: string, reason: string): void => {
    expect(verifyOutput(raw, out).reason).toBe(reason)
  }

  it('accepts correct rewrites that the old reviewer rejected', () => {
    ok('the budget is one million two hundred thousand dollars', 'The budget is $1,200,000.')
    ok('we are on version two point oh point one', 'We are on version 2.0.1.')
    ok(
      'count with me one two three four five six seven eight nine ten',
      'Count with me: one, two, three, four, five, six, seven, eight, nine, ten.'
    )
    ok('we need three hundred and twenty thousand more', 'We need 320,000 more.')
    ok('the revenue was three hundred grand', 'The revenue was $300k.')
    ok(
      'I mean it was a hundred and fifty maybe a hundred and sixty people',
      'It was 150, maybe 160 people.'
    )
    ok(
      'first we have one thousand second we have two thousand and third we have three thousand',
      'First we have 1,000, second we have 2,000, and third we have 3,000.'
    )
    ok(
      'I think we should probably go with the second option',
      'I think we should probably go with the second option.'
    )
  })

  it('accepts list layout, with or without spoken numbering', () => {
    ok(
      'okay so three things for today first finish the deck second email the vendor and third book the flights',
      'Three things for today:\n1. Finish the deck\n2. Email the vendor\n3. Book the flights'
    )
    ok(
      'number one finish the deck number two email the vendor',
      '1. Finish the deck\n2. Email the vendor'
    )
    ok('a few things: apples, pears and plums', '- Apples\n- Pears\n- Plums')
  })

  it('rejects changed, lost, merged or invented numbers', () => {
    bad('five thousand five thousand', '5,000', 'numbers-changed')
    bad('the code is zero zero zero seven', 'The code is 7.', 'numbers-changed')
    bad('one two one two', '12', 'numbers-changed')
    bad('call me at five five five one two one two', 'Call me at 555-1213.', 'numbers-changed')
    bad('two dozen eggs please', '24 eggs, please.', 'numbers-changed')
    bad(
      'we need about three hundred units',
      'We need about 300 units by Friday at 5.',
      'numbers-changed'
    )
    bad('one million two hundred thousand dollars', 'one million $200,000', 'numbers-changed')
  })

  it('rejects answers, chat and echoes', () => {
    bad('what time is the meeting tomorrow', 'The meeting is at 10 am.', 'answered')
    bad('can you send me the report', 'Sure! Here is the report.', 'chatty')
    bad('hello world', 'Transcript: hello world', 'echo')
    bad('hello world', '', 'empty')
  })

  it('rejects rewrites that lose or invent most of the content', () => {
    bad(
      'we discussed the quarterly numbers the hiring plan and the office move in some detail',
      'We talked.',
      'too-short'
    )
    bad(
      'send the report',
      'Send the report to the whole team, including the finance department, the legal team and the board members.',
      'too-long'
    )
    bad(
      'the deploy failed because the database migration timed out on the staging cluster',
      'Please remember to water the plants and feed the cat before you leave tonight.',
      'diverged'
    )
  })

  it('accepts an empty answer only for noise', () => {
    expect(verifyOutput('um uh', '', { allowEmpty: true }).ok).toBe(true)
    expect(verifyOutput('um uh', '').ok).toBe(false)
  })
})
