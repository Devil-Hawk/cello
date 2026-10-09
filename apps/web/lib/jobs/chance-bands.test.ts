import { describe, expect, it } from 'vitest'
import { CHANCE_BANDS, chanceBandFor, chanceBandLabel } from './chance-bands'

describe('chanceBandFor', () => {
  it('uses the chance when there is one', () => {
    expect(chanceBandFor('strong')).toBe('strong')
    expect(chanceBandFor('possible', [])).toBe('possible')
    expect(chanceBandFor('stretch')).toBe('stretch')
  })

  it('says not assessed yet for no chance, and for a role that could not be read', () => {
    expect(chanceBandFor(null)).toBe('unassessed')
    expect(chanceBandFor(undefined)).toBe('unassessed')
    expect(chanceBandFor('cannot_assess')).toBe('unassessed')
  })

  it('puts a role a stated fact rules out in its own band, whatever else is on the row', () => {
    expect(chanceBandFor(null, [{ kind: 'location', text: 'x' }])).toBe('filtered')
    expect(chanceBandFor('strong', [{ kind: 'company', text: 'x' }])).toBe('filtered')
  })

  it('has a plain label for every band and no numbers in them', () => {
    expect(CHANCE_BANDS.map((b) => b.key)).toEqual(['unassessed', 'filtered', 'stretch', 'possible', 'strong'])
    for (const b of CHANCE_BANDS) {
      expect(chanceBandLabel(b.key)).toBe(b.label)
      expect(b.label).not.toMatch(/\d/)
    }
  })
})
