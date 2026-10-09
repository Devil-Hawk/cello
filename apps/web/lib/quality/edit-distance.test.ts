import { describe, expect, it } from 'vitest'
import { normalizedEditDistance } from './edit-distance'

describe('normalizedEditDistance', () => {
  it('is 0 for identical text, whatever the whitespace, and for two empty texts', () => {
    expect(normalizedEditDistance('Hello there, team', 'Hello there, team')).toBe(0)
    expect(normalizedEditDistance('Hello  there,\nteam ', 'Hello there, team')).toBe(0)
    expect(normalizedEditDistance('', '   ')).toBe(0)
  })

  it('is 1 when nothing is shared, and for a text against nothing', () => {
    expect(normalizedEditDistance('alpha beta gamma', 'one two three')).toBe(1)
    expect(normalizedEditDistance('alpha beta', '')).toBe(1)
  })

  it('one word changed in ten is 0.1', () => {
    const a = 'one two three four five six seven eight nine ten'
    const b = 'one two three four five six seven eight nine eleven'
    expect(normalizedEditDistance(a, b)).toBeCloseTo(0.1, 10)
  })

  it('counts an added or removed word against the longer text', () => {
    expect(normalizedEditDistance('a b c d', 'a b c d e')).toBeCloseTo(0.2, 10)
    expect(normalizedEditDistance('a b c d e', 'a b d e')).toBeCloseTo(0.2, 10)
  })

  it('is symmetric', () => {
    const a = 'I would love to talk about the backend role'
    const b = 'Happy to talk about the platform role next week'
    expect(normalizedEditDistance(a, b)).toBe(normalizedEditDistance(b, a))
  })
})
