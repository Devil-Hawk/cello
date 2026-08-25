import { describe, expect, it } from 'vitest'
import { SCORE_BANDS, scoreBandFor, scoreBandLabel } from './score-bands'

describe('scoreBandFor', () => {
  it('buckets null/undefined/NaN as unscored', () => {
    expect(scoreBandFor(null)).toBe('unscored')
    expect(scoreBandFor(undefined)).toBe('unscored')
    expect(scoreBandFor(NaN)).toBe('unscored')
  })

  it('buckets the boundary values on the correct side', () => {
    expect(scoreBandFor(0)).toBe('weak')
    expect(scoreBandFor(49)).toBe('weak')
    expect(scoreBandFor(50)).toBe('fair')
    expect(scoreBandFor(69)).toBe('fair')
    expect(scoreBandFor(70)).toBe('good')
    expect(scoreBandFor(84)).toBe('good')
    expect(scoreBandFor(85)).toBe('strong')
    expect(scoreBandFor(100)).toBe('strong')
  })
})

describe('scoreBandLabel', () => {
  it('returns a label for every band SCORE_BANDS declares', () => {
    for (const band of SCORE_BANDS) {
      expect(scoreBandLabel(band.key)).toBe(band.label)
    }
  })
})
