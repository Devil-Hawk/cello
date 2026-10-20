import { describe, expect, it } from 'vitest'
import { groupFallthrough, phraseOf } from './fallthrough'

describe('phraseOf', () => {
  it('keeps the first three words, lowercased, without punctuation', () => {
    expect(phraseOf('What should I focus on this week?')).toBe('what should i')
    expect(phraseOf('  Rewrite, my   RESUME! now')).toBe('rewrite my resume')
  })
  it('keeps what there is when there are fewer than three words', () => {
    expect(phraseOf('Hello!')).toBe('hello')
    expect(phraseOf('')).toBe('')
  })
})

describe('groupFallthrough', () => {
  it('counts by phrase, most first, ties by phrase', () => {
    const lines = ['Tell me more', 'tell me more about it', 'Hi', 'what now?', 'Hi!', 'Tell me more.', 'zed one']
    expect(groupFallthrough(lines)).toEqual([
      { phrase: 'tell me more', count: 3 },
      { phrase: 'hi', count: 2 },
      { phrase: 'what now', count: 1 },
      { phrase: 'zed one', count: 1 },
    ])
  })
  it('is empty for no lines', () => {
    expect(groupFallthrough([])).toEqual([])
  })
})
