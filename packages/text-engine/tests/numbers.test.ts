import { describe, expect, it } from 'vitest'
import { countUnits, digitSignature, numberList } from '../src/numbers'

/** Spoken and written renderings of the same numbers must produce the same signature. */
const SAME: Array<[string, string]> = [
  ['the budget is one million two hundred thousand dollars', 'The budget is $1,200,000.'],
  ['we are on version two point oh point one', 'We are on version 2.0.1.'],
  [
    'count with me one two three four five six seven eight nine ten',
    'Count with me: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.'
  ],
  [
    'count with me one two three four five six seven eight nine ten',
    'Count with me: one, two, three, four, five, six, seven, eight, nine, ten.'
  ],
  ['we need three hundred and twenty thousand more', 'We need 320,000 more.'],
  ['it cost about two thousand five hundred dollars', 'It cost about $2,500.'],
  ['we had one thousand two hundred and fifty people', 'We had 1,250 people.'],
  ['twelve hundred units', '1,200 units'],
  ['fifteen hundred and fifty', '1,550'],
  ['a hundred and twenty three', '123'],
  ['about twenty five hundred', 'About 2,500.'],
  ['three point five million dollars', '$3.5 million'],
  ['three point five million dollars', '$3,500,000'],
  ['one point two billion', '1.2 billion'],
  ['the year two thousand and five', 'the year 2005'],
  ['in twenty twenty four', 'in 2024'],
  ['nineteen ninety nine', '1999'],
  ['my number is five five five one two one two', 'My number is 555-1212.'],
  ['the code is zero zero zero seven', 'The code is 0007.'],
  ['call me at five five five, one two three, four five six seven', 'Call me at (555) 123-4567.'],
  ['seven hundred and eighty seven point five', '787.5'],
  ['forty two thousand one hundred and eight', '42,108'],
  ['two thousand twenty six dollars', '$2,026'],
  ['ninety nine thousand nine hundred and ninety nine', '99,999'],
  ['five thousand five thousand', '5,000 5,000'],
  ['one hundred one hundred', '100 100'],
  ['four thousand four hundred and forty four', '4,444'],
  ['six hundred sixty six thousand', '666,000'],
  ['one hundred twenty thousand five hundred', '120,500'],
  ['ten thousand and one', '10,001'],
  ['i need eleven hundred dollars by five thirty pm', 'I need $1,100 by 5:30 pm.'],
  ['chapter three, verse sixteen', 'Chapter 3, verse 16'],
  ['set the timer to ninety seconds', 'Set the timer to 90 seconds.'],
  ['twenty five thirty', '25:30'],
  ['seventeen fifty', '17:50'],
  ['seventeen fifty', '1750'],
  ['room two oh one', 'Room 201'],
  ['flight one oh one seven', 'Flight 1017'],
  ['two point five percent', '2.5%'],
  ['hundred thousand', '100,000'],
  ['two thousand two hundred twenty two', '2,222'],
  ['twenty two thousand two hundred', '22,200'],
  ['ten dollars and fifty cents', '$10.50'],
  ['two and a half hours', '2.5 hours'],
  ['two and a half million', '2,500,000'],
  ['the revenue was three hundred grand', 'The revenue was $300k.'],
  ['the revenue was three hundred grand', 'The revenue was 300 grand.'],
  ['twenty-five apples', '25 apples'],
  ['double oh seven', '007'],
  ['triple five one two one two', '555-1212'],
  ['march third twenty twenty four', 'March 3rd, 2024'],
  ['march third twenty twenty four', 'March 3, 2024'],
  ['first finish the deck second email the vendor', '1. Finish the deck\n2. Email the vendor'],
  [
    'first we have one thousand second we have two thousand and third we have three thousand',
    'First we have 1,000, second we have 2,000, and third we have 3,000.'
  ],
  [
    'I mean it was a hundred and fifty maybe a hundred and sixty people',
    'It was 150, maybe 160 people.'
  ],
  ['five to ten percent', '5-10%'],
  ['one of them said no', 'One of them said no.'],
  ['a couple of things', 'A couple of things.'],
  ['half the team', 'Half the team.'],
  ['ten k users', '10k users'],
  ['five m in revenue', '5 m in revenue'],
  ['iPhone fifteen pro', 'iPhone 15 Pro'],
  ['twenty twenty vision', '20/20 vision'],
  ['at ten to eleven', 'at 10 to 11'],
  ['version two point three', 'version 2.3'],
  ['ninety nine point nine percent uptime', '99.9% uptime'],
  ['one two one two', '1212'],
  ['the two of us', 'the 2 of us']
]

/** Renderings that lose, change, merge, invent or de-duplicate a number must differ. */
const DIFFERENT: Array<[string, string]> = [
  ['five thousand five thousand', '5,000'],
  ['one two one two', '12'],
  ['the code is zero zero zero seven', 'The code is 7.'],
  ['two dozen eggs', '24 eggs'],
  ['we need three hundred and twenty thousand more', 'We need 320 more.'],
  ['send two copies', 'Send a couple of copies.'],
  ['one million two hundred thousand', 'one million 200,000'],
  ['call me at five five five one two one two', 'Call me at 555-1213.'],
  [
    'finish the deck and email the vendor',
    '1. Finish the deck\n2. Email the vendor and call 5 people'
  ]
]

describe('digitSignature', () => {
  for (const [spoken, written] of SAME) {
    it(`agrees: ${JSON.stringify(spoken)} ~ ${JSON.stringify(written)}`, () => {
      expect(digitSignature(written)).toBe(digitSignature(spoken))
    })
  }
  for (const [spoken, written] of DIFFERENT) {
    it(`differs: ${JSON.stringify(spoken)} vs ${JSON.stringify(written)}`, () => {
      expect(digitSignature(written)).not.toBe(digitSignature(spoken))
    })
  }

  it('reads the exact values', () => {
    expect(numberList('one million two hundred thousand dollars')).toEqual(['1200000'])
    expect(numberList('five five five one two one two')).toEqual([
      '5',
      '5',
      '5',
      '1',
      '2',
      '1',
      '2'
    ])
    expect(numberList('twenty twenty four')).toEqual(['20', '24'])
    expect(numberList('two point oh point one')).toEqual(['20', '1'])
    expect(numberList('2.0.1')).toEqual(['201'])
    expect(numberList('$1,200,000.')).toEqual(['1200000'])
    expect(numberList('5:30 pm')).toEqual(['530'])
    expect(numberList('300k')).toEqual(['300000'])
    expect(numberList('1.5 billion')).toEqual(['1500000000'])
    expect(numberList('3rd of March')).toEqual([])
    expect(numberList('the third option')).toEqual([])
    expect(numberList('grand piano')).toEqual([])
    expect(numberList('5 m tall')).toEqual(['5'])
    expect(numberList('1. Finish\n2. Email', true)).toEqual([])
    expect(numberList('1. Finish\n2. Email', false)).toEqual(['1', '2'])
  })

  it('never merges an ordinary "and"', () => {
    expect(numberList('five and six')).toEqual(['5', '6'])
    expect(numberList('one hundred and five')).toEqual(['105'])
  })
})

describe('countUnits', () => {
  it('counts a spoken number once', () => {
    expect(countUnits('one million two hundred thousand dollars')).toBe(2)
    expect(countUnits('$1,200,000')).toBe(1)
    expect(countUnits('five five five one two one two')).toBe(7)
    expect(countUnits('555-1212')).toBe(2)
    expect(countUnits('hello world')).toBe(2)
  })
})
