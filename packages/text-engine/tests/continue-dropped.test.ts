import { describe, expect, it } from 'vitest'
import { continueFrom, finish } from '../src/cleanup'
import { evenParagraphs } from '../src/layout'
import { droppedRun, verifyOutput } from '../src/verify'

describe('continueFrom', () => {
  it('lowers an ordinary first word mid-sentence and adds the space', () => {
    expect(continueFrom('Probably ship it Friday.', 'I think we should', 'document')).toBe(
      ' probably ship it Friday.'
    )
  })
  it('keeps names, I and acronyms', () => {
    expect(continueFrom('Sarah will know.', 'ask ', 'document')).toBe('Sarah will know.')
    expect(continueFrom("I'm not sure.", 'and ', 'document')).toBe("I'm not sure.")
    expect(continueFrom('NASA said so.', 'because ', 'document')).toBe('NASA said so.')
  })
  it('capitalizes after a sentence end', () => {
    expect(continueFrom('then we ship.', 'Done. ', 'document')).toBe('Then we ship.')
    expect(continueFrom('then we ship.', 'Done.', 'document')).toBe(' Then we ship.')
  })
  it('leaves new lines, empty context, code alone', () => {
    expect(continueFrom('Next item.', 'list\n', 'document')).toBe('Next item.')
    expect(continueFrom('Next item.', '', 'document')).toBe('Next item.')
    expect(continueFrom('Next', 'foo', 'code')).toBe('Next')
  })
  it('runs inside finish', () => {
    const f = finish('Probably tomorrow.', {
      category: 'email',
      dictionary: [],
      trailingSpace: false,
      precedingText: 'we can meet'
    })
    expect(f.text).toBe(' probably tomorrow.')
  })
})

describe('droppedRun', () => {
  const said =
    'so the plan is to ship the desktop build on monday then we test the android release with the beta group over the weekend and after that we write the launch post'
  it('catches a dropped middle sentence', () => {
    const cut = 'So the plan is to ship the desktop build on Monday. After that, we write the launch post.'
    expect(droppedRun(said, cut)).toBeGreaterThanOrEqual(7)
    expect(verifyOutput(said, cut)).toEqual({ ok: false, reason: 'dropped' })
  })
  it('passes a full rewrite and a taken-back sentence', () => {
    const full =
      'So the plan is to ship the desktop build on Monday. Then we test the Android release with the beta group over the weekend, and after that we write the launch post.'
    expect(droppedRun(said, full)).toBe(0)
    expect(droppedRun(`${said} scratch that`, 'So the plan is to ship.')).toBe(0)
  })
})

describe('evenParagraphs', () => {
  const p = (n: number, w: string): string =>
    Array.from({ length: n }, (_, i) => `${w} sentence ${i + 1}.`).join(' ')
  it('joins a lone sentence between two long paragraphs to the next one', () => {
    const text = `${p(6, 'Alpha')}\n\nLone one here.\n\n${p(6, 'Beta')}`
    expect(evenParagraphs(text)).toBe(`${p(6, 'Alpha')}\n\nLone one here. ${p(6, 'Beta')}`)
  })
  it('joins it to the shorter neighbour', () => {
    const text = `${p(3, 'Alpha')}\n\nLone one here.\n\n${p(7, 'Beta')}`
    expect(evenParagraphs(text)).toBe(`${p(3, 'Alpha')} Lone one here.\n\n${p(7, 'Beta')}`)
  })
  it('keeps dictated paragraphs and lists', () => {
    const text = `${p(6, 'Alpha')}\n\nLone one here.\n\n${p(6, 'Beta')}`
    expect(evenParagraphs(text, 'alpha new paragraph lone')).toBe(text)
    const list = `${p(6, 'Alpha')}\n\n- item one\n\n${p(6, 'Beta')}`
    expect(evenParagraphs(list)).toBe(list)
  })
})

describe('finish sentence case', () => {
  const opts = { category: 'document' as const, dictionary: [], trailingSpace: false }
  it('capitalizes a sentence that starts in lower case', () => {
    expect(finish('We shipped it. then we tested it.', opts).text).toBe('We shipped it. Then we tested it.')
  })
  it('leaves abbreviations and lower-case profiles alone', () => {
    expect(finish('Ask e.g. the team.', opts).text).toBe('Ask e.g. the team.')
    expect(finish('we shipped. then', { ...opts, casing: 'lowercase' }).text).toBe('we shipped. then')
  })
})

describe('joinRunningSentences', () => {
  const opts = { category: 'document' as const, dictionary: [], trailingSpace: false }
  it('rejoins a sentence a break cut in two', () => {
    expect(finish('- Ship it because that\n\nIs pretty clutch.', opts).text).toBe('- Ship it because that is pretty clutch.')
  })
  it('keeps headings and ordinary breaks', () => {
    expect(finish('Agenda\n\nBudget review.', opts).text).toBe('Agenda\n\nBudget review.')
    expect(finish('We shipped it.\n\nThe next part.', opts).text).toBe('We shipped it.\n\nThe next part.')
  })
})
