import { describe, expect, it } from 'vitest'
import {
  applyLayout,
  itemText,
  layoutText,
  numberCuedLines,
  numberCuedSentences,
  parseLayout,
  splitUnits
} from '../src/layout'
import type { Complete } from '../src/types'

const long = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `This is sentence number ${i + 1} of the update and it goes on a while.`
  ).join(' ')

describe('splitting into sentences', () => {
  it('keeps the line breaks the text already had', () => {
    const u = splitUnits('One. Two!\n\nThree?\n- four\n- five')
    expect(u.map((x) => [x.text, x.hardBreak, x.listLine])).toEqual([
      ['One.', '', false],
      ['Two!', '', false],
      ['Three?', '\n\n', false],
      ['- four', '\n', true],
      ['- five', '\n', true]
    ])
  })
})

describe('reading the model answer', () => {
  it('takes 1-based numbers, drops what is out of range or overlapping', () => {
    const plan = parseLayout(
      'Sure: {"paragraphs":[1,3,3,9,99],"lists":[{"items":[4,5,6],"end":7,"ordered":true},{"items":[6,8]}]}',
      10
    )
    expect(plan).toEqual({
      paragraphs: [2, 8],
      lists: [{ items: [3, 4, 5], end: 6, ordered: true }]
    })
  })

  it('is null for anything that is not a layout', () => {
    expect(parseLayout('I cannot help with that.', 5)).toBeNull()
    expect(parseLayout('{not json', 5)).toBeNull()
  })
})

describe('laying out', () => {
  const units = splitUnits(
    'Here is the plan. We have three phases. First, design in March. Second, build in April. And finally, launch in May. Next, hiring. We need two engineers. Both start in June.'
  )

  it('puts paragraphs and list items on their own lines, without changing a word', () => {
    const text = applyLayout(units, {
      paragraphs: [5],
      lists: [{ items: [2, 3, 4], end: 4, ordered: true }]
    })
    expect(text).toBe(
      'Here is the plan. We have three phases.\n\n1. Design in March.\n2. Build in April.\n3. Launch in May.\n\nNext, hiring. We need two engineers. Both start in June.'
    )
  })

  it('ignores a plan that breaks after nearly every sentence', () => {
    const text = applyLayout(units, { paragraphs: [1, 2, 3, 4, 5, 6, 7], lists: [] })
    expect(text).not.toContain('\n')
  })

  it('removes only the spoken cue from an item', () => {
    expect(itemText('number two, email the vendor.')).toBe('Email the vendor.')
    expect(itemText('First of all, we ship.')).toBe('We ship.')
    expect(itemText('Firstly.')).toBe('Firstly.')
    expect(itemText('the first thing is speed.')).toBe('The first thing is speed.')
  })
})

describe('layoutText', () => {
  const answer =
    (text: string): Complete =>
    async () => ({ text })

  it('lays out a long document dictation', async () => {
    const r = await layoutText(long(30), 'document', answer('{"paragraphs":[8,16,24],"lists":[]}'))
    expect(r.outcome).toBe('used')
    expect(r.text.split('\n\n')).toHaveLength(4)
    expect(r.text.replace(/\s+/g, ' ')).toBe(long(30))
  })

  it('leaves chat, short text and failures alone', async () => {
    const plan = answer('{"paragraphs":[8],"lists":[]}')
    expect((await layoutText(long(30), 'chat', plan)).outcome).toBe('skipped')
    expect((await layoutText(long(3), 'document', plan)).outcome).toBe('skipped')
    const r = await layoutText(long(30), 'document', async () => {
      throw new Error('503')
    })
    expect(r).toMatchObject({ outcome: 'failed', text: long(30) })
    expect((await layoutText(long(30), 'notes', answer('no'))).outcome).toBe('failed')
  })
})

describe('numberCuedLines', () => {
  it('numbers items the model put on lines of their own with the cue left in', () => {
    expect(
      numberCuedLines(
        'A few things:\nFirst, send it.\nSecond, sign it.\nAnd third, file it.\n\nThanks.'
      )
    ).toBe('A few things:\n1. Send it.\n2. Sign it.\n3. File it.\n\nThanks.')
    expect(numberCuedLines('- Firstly the deck\n- Secondly the vendor')).toBe(
      '1. The deck\n2. The vendor'
    )
    expect(numberCuedLines('Number one, install it\nNumber two, run it\nFinally, open it up')).toBe(
      '1. Install it\n2. Run it\n3. Open it up'
    )
  })

  it('leaves lines that do not count from one in order', () => {
    for (const t of [
      'First the deck.\nThen the vendor.',
      'Second, a b.\nFirst, c d.',
      'First, a b.\nThird, c d.',
      'First, a b. Second, c d.'
    ])
      expect(numberCuedLines(t)).toBe(t)
  })
})

describe('numberCuedSentences', () => {
  it('turns points counted out in one paragraph into a numbered list', () => {
    expect(
      numberCuedSentences(
        'Three things for the launch. First, send the contract. Second, sign it. Third, file it.'
      )
    ).toBe('Three things for the launch.\n\n1. Send the contract.\n2. Sign it.\n3. File it.')
    expect(numberCuedSentences('First, book the room. Second, invite the team.')).toBe(
      '1. Book the room.\n2. Invite the team.'
    )
    expect(
      numberCuedSentences('Number one we install it. Number two we run it. And finally, we ship.')
    ).toBe('1. We install it.\n2. We run it.\n3. We ship.')
  })

  it('keeps a point that runs over sentences together, and what follows the list apart', () => {
    expect(
      numberCuedSentences(
        'First, call Dana. She has the numbers. Second, update the deck. Use the new logo. Thanks for the help. See you Monday.'
      )
    ).toBe(
      '1. Call Dana. She has the numbers.\n2. Update the deck. Use the new logo.\n\nThanks for the help. See you Monday.'
    )
  })

  it('leaves prose, lists that exist already, and counts that are out of order', () => {
    for (const t of [
      'First we tried the old build. Second attempt worked.',
      'First, a b. Third, c d.',
      'Second, a b. First, c d.',
      'First, send it. Then we wait.',
      '1. First, send it.\n2. Second, sign it.',
      'First, a b. One. Two. Three. Four. Five. Second, c d.'
    ])
      expect(numberCuedSentences(t)).toBe(t)
  })
})
