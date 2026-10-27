import { describe, expect, it } from 'vitest'
import { carryInput, joinCarried, joinSeam, splitCarry } from '../src/seam'

describe('joinSeam soft (the cut is a clip end, the formatter decides)', () => {
  const soft = (a: string, b: string): string => joinSeam(a, b, { soft: true }).text
  it('drops the period the clip end added and continues in lower case', () => {
    expect(soft('I want you to dig deeper.', 'And actually merge things yourself.')).toBe(
      'I want you to dig deeper and actually merge things yourself.'
    )
    expect(soft('or make any decisions.', 'Any major mistakes.')).toBe(
      'or make any decisions any major mistakes.'
    )
  })
  it('drops an ellipsis too', () => {
    expect(soft('It is a question of...', 'If we can.')).toBe('It is a question of if we can.')
    expect(soft('Every single…', 'Clip is cut.')).toBe('Every single clip is cut.')
  })
  it('keeps a question or exclamation mark and the capital after it', () => {
    expect(soft('Is it done?', 'Yes it is.')).toBe('Is it done? Yes it is.')
    expect(soft('Wow!', 'That was fast.')).toBe('Wow! That was fast.')
  })
  it('keeps "I" and names capitalized', () => {
    expect(soft('That is the plan.', "I'll send it later.")).toBe("That is the plan I'll send it later.")
    expect(soft('I sent it to.', 'Sarah, and Sarah said no.')).toBe('I sent it to Sarah, and Sarah said no.')
    expect(soft('We moved it to the.', 'API gateway.')).toBe('We moved it to the API gateway.')
  })
  it('still drops words heard by both pieces', () => {
    expect(soft('Everything that would otherwise.', 'Otherwise, be picked up.')).toBe(
      'Everything that would otherwise be picked up.'
    )
    expect(soft('It adds a', 'An extra step.')).toBe('It adds an extra step.')
  })
  it('handles a bare end and empty sides', () => {
    expect(soft('the build is', 'Green now.')).toBe('the build is green now.')
    expect(soft('', 'Hello there.')).toBe('Hello there.')
    expect(soft('Hello there.', '')).toBe('Hello there.')
  })
  it('does not touch an inner period', () => {
    expect(soft('Version 2.0 shipped. We tested it.', 'Then it broke.')).toBe(
      'Version 2.0 shipped. We tested it then it broke.'
    )
  })
})

describe('splitCarry', () => {
  it('carries the last sentence and keeps the rest', () => {
    expect(splitCarry('There are issues. I want you to dig deeper.')).toEqual({
      head: 'There are issues.',
      carry: 'I want you to dig deeper.'
    })
  })
  it('carries an unfinished end', () => {
    expect(splitCarry('We shipped it. Then the build')).toEqual({ head: 'We shipped it.', carry: 'Then the build' })
  })
  it('carries a single sentence whole (head empty)', () => {
    expect(splitCarry('Just one sentence here.')).toEqual({ head: '', carry: 'Just one sentence here.' })
  })
  it('carries nothing when the last sentence is long', () => {
    const long = `Start. ${'word '.repeat(45).trim()}.`
    expect(splitCarry(long)).toEqual({ head: long, carry: '' })
  })
  it('carries nothing from a list item, and only the last line otherwise', () => {
    const list = 'Three things:\n1. Finish the deck\n2. Email the vendor'
    expect(splitCarry(list)).toEqual({ head: list, carry: '' })
    expect(splitCarry('Dear Sam,\n\nThanks for the notes')).toEqual({ head: 'Dear Sam,\n\n', carry: 'Thanks for the notes' })
  })
  it('handles empty text', () => {
    expect(splitCarry('')).toEqual({ head: '', carry: '' })
    expect(splitCarry('   ')).toEqual({ head: '', carry: '' })
  })
  it('respects closing quotes after the mark', () => {
    expect(splitCarry('She said "go." Then we went')).toEqual({ head: 'She said "go."', carry: 'Then we went' })
  })
})

describe('carryInput', () => {
  it('is the carried sentence, soft-joined to the raw words', () => {
    expect(
      carryInput('I want you to dig deeper.', 'And actually merge things yourself. I only want you to hold them when I say.')
    ).toBe('I want you to dig deeper and actually merge things yourself. I only want you to hold them when I say.')
  })
  it('drops an echo of the carry at the start of the raw piece', () => {
    expect(carryInput('so we should test the whole.', 'The whole thing again tomorrow morning before the release goes out.')).toBe(
      'so we should test the whole thing again tomorrow morning before the release goes out.'
    )
  })
  it('joins the old way when the rules, not the model, would format it', () => {
    // A short tail is formatted by rules, which cannot punctuate a run-on.
    expect(carryInput('That is the whole plan for this week and the next.', 'Send it now.')).toBe(
      'That is the whole plan for this week and the next. Send it now.'
    )
    // Short enough overall to pass as already clean.
    expect(carryInput('Okay.', 'Send it to Sarah tomorrow morning please.')).toBe('Okay. Send it to Sarah tomorrow morning please.')
  })
  it('joins by joinSeam when not soft (code, terminals)', () => {
    expect(
      carryInput('I want you to dig deeper.', 'And actually merge things yourself. I only want you to hold them when I say.', { soft: false })
    ).toBe('I want you to dig deeper. And actually merge things yourself. I only want you to hold them when I say.')
  })
})

describe('joinCarried', () => {
  it("replaces the previous piece's last sentence with the carrying piece", () => {
    const parts = [
      { text: 'There are issues. I want you to dig deeper.' },
      { text: 'I want you to dig deeper and actually merge things yourself. Hold only what I say.', carried: true }
    ]
    expect(joinCarried(parts).text).toBe(
      'There are issues. I want you to dig deeper and actually merge things yourself. Hold only what I say.'
    )
  })
  it('chains: a piece carried whole contributes nothing of its own', () => {
    const parts = [
      { text: 'One. Two three' },
      { text: 'Two three four', carried: true },
      { text: 'Two three four five. Six.', carried: true }
    ]
    expect(joinCarried(parts).text).toBe('One. Two three four five. Six.')
  })
  it('uses joinSeam where nothing was carried', () => {
    expect(joinCarried([{ text: 'Everything that would otherwise.' }, { text: 'Otherwise, be picked up.' }]).text).toBe(
      'Everything that would otherwise be picked up.'
    )
  })
  it('keeps a line break before a carried line', () => {
    expect(joinCarried([{ text: 'Dear Sam,\n\nThanks for the' }, { text: 'Thanks for the notes.', carried: true }]).text).toBe(
      'Dear Sam,\n\nThanks for the notes.'
    )
  })
  it('skips empty parts', () => {
    expect(joinCarried([{ text: 'A b.' }, { text: '' }, { text: 'C d.' }]).text).toBe('A b. C d.')
  })
  it('a carried part after nothing is just itself', () => {
    expect(joinCarried([{ text: 'Hi there.', carried: true }]).text).toBe('Hi there.')
  })
})
