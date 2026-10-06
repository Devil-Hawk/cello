import { describe, expect, it } from 'vitest'
import { cleanCites, citesSupport, contentWords, mergeLines, numberLines, sharesContentWord } from './lines'

describe('numberLines', () => {
  it('numbers non-empty lines from 1 with the prefix, and keeps the text by id', () => {
    const l = numberLines('Senior Engineer\n\n  Built a ledger in Go  \n', 'R')
    expect(l.block).toBe('R1: Senior Engineer\nR2: Built a ledger in Go')
    expect(l.byId.get('R2')).toBe('Built a ledger in Go')
  })

  it('splits a long paragraph at sentence ends into short ids', () => {
    const sentence = 'We build payment systems that move money for millions of businesses every day.'
    const l = numberLines(Array(8).fill(sentence).join(' '), 'J')
    expect(l.byId.size).toBeGreaterThan(2)
    for (const text of l.byId.values()) expect(text.length).toBeLessThanOrEqual(300)
  })

  it('caps the number of lines and handles null', () => {
    expect(numberLines(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'), 'G', { maxLines: 10 }).byId.size).toBe(10)
    expect(numberLines(null, 'J').block).toBe('')
  })

  it('mergeLines puts several sources behind one lookup', () => {
    const all = mergeLines(numberLines('a b c', 'R'), numberLines('d e f', 'J'))
    expect([...all.keys()]).toEqual(['R1', 'J1'])
  })
})

describe('citations', () => {
  const lines = mergeLines(numberLines('Led a Kubernetes migration of 30 services', 'R'), numberLines('You will run Kubernetes clusters\nGreat snacks', 'J'))

  it('cleanCites keeps real-looking ids once, upper case', () => {
    expect(cleanCites(['r1', ' J2 ', 'R1', 'x9', 3, 'J1000'])).toEqual(['R1', 'J2'])
    expect(cleanCites('R1')).toEqual([])
  })

  it('a claim is supported when every id exists and one cited line shares a content word', () => {
    expect(citesSupport('Your Kubernetes migration matches the clusters they run', ['R1', 'J1'], lines)).toBe(true)
  })

  it('no citations, an unknown id, or an unrelated line is not support', () => {
    expect(citesSupport('Kubernetes experience', [], lines)).toBe(false)
    expect(citesSupport('Kubernetes experience', ['R1', 'J9'], lines)).toBe(false)
    expect(citesSupport('Kubernetes experience', ['J2'], lines)).toBe(false)
  })

  it('content words ignore common words and short ones', () => {
    expect([...contentWords('The cat is on the C++ mat')].sort()).toEqual(['c++', 'cat', 'mat'])
    expect(sharesContentWord('the and of', 'the and of')).toBe(false)
  })
})
