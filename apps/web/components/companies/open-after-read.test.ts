import { describe, expect, it } from 'vitest'
import { openAfterRead } from './company-logic'

describe('openAfterRead', () => {
  it("says what a whole board read listed, not the directory's older count", () => {
    expect(openAfterRead({ found: 16, tier: 'board' }, { open: 17 })).toBe(16)
  })
  it('keeps the directory count for a window onto a site and when nothing was found', () => {
    expect(openAfterRead({ found: 9, tier: 'listing' }, { open: 40 })).toBe(40)
    expect(openAfterRead({ found: 0, tier: 'board' }, { open: 12 })).toBe(12)
    expect(openAfterRead({ found: 5, tier: null }, { open: null })).toBe(5)
  })
})
