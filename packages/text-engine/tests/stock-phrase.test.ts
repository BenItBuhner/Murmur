import { describe, expect, it } from 'vitest'
import { dropLastWords, trailingStockPhrase } from '../src/hallucination'

const timed = (...ws: string[]) => ws.map((word, i) => ({ word, start: i, end: i + 1 }))

describe('a stock phrase at the end of a transcript', () => {
  it('is found with where it starts', () => {
    expect(trailingStockPhrase(timed('Looks', 'right.', 'Thank', 'you.'))).toEqual({
      count: 2,
      start: 2,
      end: 4
    })
    expect(trailingStockPhrase(timed('done.', 'Thanks', 'for', 'watching!'))).toMatchObject({
      count: 3
    })
  })

  it('is not found in ordinary endings', () => {
    expect(trailingStockPhrase(timed('Ship', 'it.'))).toBeNull()
    expect(
      trailingStockPhrase(timed('I', 'want', 'to', 'thank', 'you', 'all', 'again.'))
    ).toBeNull()
  })

  it('drops the last words and what followed them', () => {
    expect(dropLastWords('They look right to me. Thank you.', 2)).toBe('They look right to me.')
    expect(dropLastWords("it's fine, thanks!", 1)).toBe("it's fine,")
    expect(dropLastWords('one', 2)).toBe('one')
  })
})
