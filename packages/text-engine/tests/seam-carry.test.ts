import { describe, expect, it } from 'vitest'
import { carryInput, joinCarried, splitCarry } from '../src/seam'

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
  it('is the carried sentence, then the raw words, with the pause period kept for the model', () => {
    expect(
      carryInput('I want you to dig deeper.', 'And actually merge things yourself. I only want you to hold them when I say.')
    ).toBe('I want you to dig deeper. And actually merge things yourself. I only want you to hold them when I say.')
    expect(carryInput('It was past its prime.', 'I still want this to work.')).toBe(
      'It was past its prime. I still want this to work.'
    )
  })
  it('drops an echo of the carry at the start of the raw piece', () => {
    expect(carryInput('so we should test the whole.', 'The whole thing again tomorrow morning before the release goes out.')).toBe(
      'so we should test the whole thing again tomorrow morning before the release goes out.'
    )
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
