import { describe, expect, it } from 'vitest'
import { removeHesitations } from '@core/text/hesitations'
import { collapseRepeats } from '@core/text/repeats'
import { convertNumbers } from '@core/text/numbers'
import { formatLists, detectListIntent } from '@core/text/lists'
import { applySelfCorrections } from '@core/text/corrections'

const light = { level: 'light' as const }
const thorough = { level: 'thorough' as const }

describe('hesitations scratch', () => {
  const cases: Array<[string, string, typeof light]> = [
    ['I think, you know, that we should go.', 'I think that we should go.', light],
    ['You know, we should go.', 'We should go.', light],
    ['Do you know if it is ready?', 'Do you know if it is ready?', light],
    ['I like pizza.', 'I like pizza.', light],
    ['It was, like, huge.', 'It was huge.', light],
    ['She was like, no way.', 'She was like, no way.', light],
    ['And like, we went home.', 'And we went home.', light],
    ['Like, we could go tomorrow.', 'We could go tomorrow.', light],
    ['Like I said, tomorrow works.', 'Like I said, tomorrow works.', light],
    ['I mean, the report is done.', 'The report is done.', light],
    ['I mean it.', 'I mean it.', light],
    ['Let me think, the meeting is at five.', 'The meeting is at five.', light],
    ['The plan is, what was it, to ship Friday.', 'The plan is to ship Friday.', light],
    ['You know what I did today.', 'You know what I did today.', light],
    ['That works so yeah.', 'That works.', light],
    ['That works, so yeah.', 'That works.', light],
    ['Okay so, we need milk.', 'We need milk.', light],
    ['We could ship it Friday and', 'We could ship it Friday', light],
    ['It was great, you know?', 'It was great.', light],
    ['So, you know, we left.', 'So, we left.', light],
    ['I tried it and, yeah, it works.', 'I tried it and, yeah, it works.', light],
    ['I tried it and, yeah, it works.', 'I tried it and it works.', thorough],
    ['Yeah, that works.', 'Yeah, that works.', thorough],
    ['That works, right?', 'That works, right?', thorough],
    ['So far so good.', 'So far so good.', thorough],
    ['So, we left early.', 'We left early.', thorough],
    ['Okay, so, um, we left early.', 'We left early.', thorough],
    ['Well, so, we left early.', 'We left early.', thorough],
    ['It was, sort of, a mess.', 'It was a mess.', thorough],
    ['It was sort of a mess.', 'It was sort of a mess.', thorough],
    ['It is done, basically.', 'It is done.', thorough],
    ['Basically, it is done.', 'It is done.', thorough],
    ['We can ship Friday, I guess.', 'We can ship Friday.', thorough],
    ['We can ship Friday or whatever.', 'We can ship Friday.', thorough],
    ['That is all, so yeah.', 'That is all.', thorough],
    ['Anyway, the report is done.', 'The report is done.', thorough]
  ]
  for (const [input, expected, opts] of cases) {
    it(`${opts.level}: ${input}`, () => {
      expect(removeHesitations(input, opts)).toBe(expected)
    })
  }
  it('custom phrases', () => {
    expect(
      removeHesitations('So, at the end of the day, it works.', {
        level: 'light',
        custom: ['at the end of the day']
      })
    ).toBe('So, it works.')
  })
})

describe('repeats scratch', () => {
  const cases: Array<[string, string, 'words' | 'phrases' | 'thorough']> = [
    ['I I think the the report is is ready', 'I think the report is ready', 'words'],
    ['No, no, no', 'No, no, no', 'words'],
    ['I, I think so', 'I think so', 'words'],
    ['th- the report', 'the report', 'words'],
    ['s- s- something', 'something', 'words'],
    ['re-read the book', 're-read the book', 'words'],
    ['I know that that is true', 'I know that that is true', 'words'],
    ['very very good', 'very very good', 'words'],
    ['very, very good', 'very, very good', 'words'],
    // Emphasis and feeling are the speaker's wording, whatever the word.
    ['fuck, fuck, fuck. This is broken', 'fuck, fuck, fuck. This is broken', 'words'],
    ['fuck fuck fuck this is broken', 'fuck fuck fuck this is broken', 'words'],
    ['okay, okay, I get it', 'okay, okay, I get it', 'words'],
    ['go go go go', 'go go go go', 'phrases'],
    ['it was slow, slow, slow', 'it was slow, slow, slow', 'words'],
    // A bare double of a content word is still a stumble; small words stumble however said.
    ['the report report is ready', 'the report is ready', 'words'],
    ['we, we should go', 'we should go', 'words'],
    ['what, what do you mean', 'what do you mean', 'words'],
    ['call five five five one two one two', 'call five five five one two one two', 'words'],
    ['go away, go away, go away', 'go away, go away, go away', 'phrases'],
    ['let me, let me see', 'let me see', 'phrases'],
    ['I think I think we should go', 'I think we should go', 'phrases'],
    ['I think, I think we should go', 'I think we should go', 'phrases'],
    ['we need to we need to go', 'we need to go', 'phrases'],
    ['we need to, we need to go', 'we need to go', 'phrases'],
    ['and then, and then we left', 'and then we left', 'phrases'],
    ['I was - I was going', 'I was going', 'phrases'],
    ['I want to, I need to go', 'I want to, I need to go', 'phrases'],
    ['I want to, I need to go', 'I need to go', 'thorough'],
    ['We should, we could try that', 'We could try that', 'thorough'],
    ['If you want, I can help', 'If you want, I can help', 'thorough'],
    ['I think, I really do', 'I think, I really do', 'thorough'],
    ['yesterday I want to, I need to go', 'yesterday I need to go', 'thorough']
  ]
  for (const [input, expected, scope] of cases) {
    it(`${scope}: ${input}`, () => {
      expect(collapseRepeats(input, scope)).toBe(expected)
    })
  }
})

describe('numbers scratch', () => {
  const smart: Array<[string, string]> = [
    ['meet at five pm', 'meet at 5 pm'],
    ['meet at five thirty pm', 'meet at 5:30 pm'],
    ['meet at five thirty', 'meet at 5:30'],
    ['five thirty works', 'five thirty works'],
    ['seventeen fifty', 'seventeen fifty'],
    ["at five o'clock", "at 5 o'clock"],
    ['I have five apples', 'I have five apples'],
    ['I have twenty five apples', 'I have 25 apples'],
    ['twenty three percent', '23%'],
    ['a hundred percent', '100%'],
    ['ten dollars', '$10'],
    ['ten dollars and fifty cents', '$10.50'],
    ['twenty euros', '€20'],
    ['fifty cents', '50 cents'],
    ['two point five', '2.5'],
    ['zero point one', '0.1'],
    ['version two point three', 'version 2.3'],
    ['version two point three point one', 'version 2.3.1'],
    ['python three', 'python 3'],
    ['in twenty twenty six', 'in 2026'],
    ['in nineteen ninety nine', 'in 1999'],
    ['two thousand twenty six', '2026'],
    ['three thousand', '3,000'],
    ['two thousand dollars', '$2,000'],
    ['one hundred and five', '105'],
    ['we have two million users', 'we have 2 million users'],
    ['one point five million', '1.5 million'],
    ['call five five five one two one two', 'call 5551212'],
    ['one of them', 'one of them'],
    ['step one', 'step 1'],
    ['chapter twelve', 'chapter 12'],
    ['the twenty first', 'the 21st'],
    ['June third', 'June 3rd'],
    ['the third of June', 'the 3rd of June'],
    ['the second option', 'the second option'],
    ['Twenty people came.', 'Twenty people came.'],
    ['Twenty percent of users', '20% of users'],
    ['five to ten percent', '5 to 10%'],
    ['two and a half hours', '2.5 hours'],
    ['three days', '3 days'],
    ['wait a second', 'wait a second'],
    ['one hour', '1 hour'],
    ['First, we go', 'First, we go'],
    ['I said no one came', 'I said no one came'],
    ['I saw twenty-three people', 'I saw 23 people'],
    ['twelve fifteen am', '12:15 am'],
    ['a couple of things', 'a couple of things']
  ]
  for (const [input, expected] of smart) {
    it(`smart: ${input}`, () => {
      expect(convertNumbers(input, 'smart')).toBe(expected)
    })
  }
  const all: Array<[string, string]> = [
    ['I have five apples', 'I have 5 apples'],
    ['one of them', 'one of them'],
    ['git checkout branch two', 'git checkout branch 2'],
    ['Five people came', '5 people came']
  ]
  for (const [input, expected] of all) {
    it(`all: ${input}`, () => {
      expect(convertNumbers(input, 'all')).toBe(expected)
    })
  }
})

describe('lists scratch', () => {
  const auto = {
    mode: 'auto' as const,
    style: 'auto' as const,
    marker: '-' as const,
    capitalize: true
  }
  const spoken = { ...auto, mode: 'spoken' as const }
  const cases: Array<[string, string, typeof auto]> = [
    ['bullet point milk, bullet point eggs, bullet point bread', '- Milk\n- Eggs\n- Bread\n', auto],
    ['we need bullet point milk bullet point eggs', 'We need:\n- Milk\n- Eggs\n', auto],
    [
      'number one, buy milk. number two, call mom. number three, ship it',
      '1. Buy milk.\n2. Call mom.\n3. Ship it.\n',
      auto
    ],
    [
      'first, thanks everyone. second, the budget is approved. third, we ship on friday. let me know what you think',
      '1. Thanks everyone.\n2. The budget is approved.\n3. We ship on friday.\n\nLet me know what you think',
      auto
    ],
    [
      'first, thanks everyone. second, the budget is approved. third, we ship on friday. let me know what you think',
      'first, thanks everyone. second, the budget is approved. third, we ship on friday. let me know what you think',
      spoken
    ],
    ['make this a bulleted list: milk, eggs and bread', '- Milk\n- Eggs\n- Bread\n', auto],
    ['make this a numbered list: milk, eggs and bread', '1. Milk\n2. Eggs\n3. Bread\n', auto],
    ['milk, eggs and bread as a bulleted list', '- Milk\n- Eggs\n- Bread\n', auto],
    [
      'here are three things: milk, eggs and bread',
      'Here are three things:\n- Milk\n- Eggs\n- Bread\n',
      auto
    ],
    [
      'here are three things: milk, eggs, bread and butter',
      'Here are three things:\n- Milk\n- Eggs\n- Bread and butter\n',
      auto
    ],
    [
      'here are three things: milk, eggs, bread, butter and jam',
      'here are three things: milk, eggs, bread, butter and jam',
      auto
    ],
    ['can you grab milk, eggs and bread', 'can you grab milk, eggs and bread', auto],
    [
      'first of all we need milk and second we need eggs',
      'first of all we need milk and second we need eggs',
      spoken
    ],
    [
      'the first time I saw it, the second time I left',
      'the first time I saw it, the second time I left',
      auto
    ],
    ['wait a second, the first option is fine', 'wait a second, the first option is fine', auto],
    [
      'step one, open the app. step two, click settings. step three, enable sync.',
      '1. Open the app.\n2. Click settings.\n3. Enable sync.\n',
      spoken
    ],
    ['bullet list: milk\neggs', '- Milk\n- Eggs\n', auto],
    ['number one, buy milk, number two, call mom', '1. Buy milk\n2. Call mom\n', spoken],
    [
      'the second option is fine, first come first served',
      'the second option is fine, first come first served',
      auto
    ]
  ]
  for (const [input, expected, opts] of cases) {
    it(`${opts.mode}: ${input}`, () => {
      expect(formatLists(input, opts).text).toBe(expected)
    })
  }
  it('intent detection', () => {
    expect(detectListIntent('put this in bullet points: a, b, c').requested).toBe('bullets')
    expect(detectListIntent('as a numbered list please').requested).toBe('numbers')
    expect(detectListIntent('hello there').requested).toBe(null)
  })
})

describe('self-corrections after an unfinished phrase', () => {
  it('treats a marker after a preposition or article as hesitation', () => {
    expect(
      applySelfCorrections(
        'book the flights for, I mean, twenty five people at five pm, no, six pm'
      )
    ).toBe('book the flights for twenty five people at six pm')
    expect(applySelfCorrections("I'll be there at, sorry, 6 pm.")).toBe("I'll be there at 6 pm.")
    expect(applySelfCorrections('Send it to John, I mean, Jane.')).toBe('Send it to Jane.')
  })
})
