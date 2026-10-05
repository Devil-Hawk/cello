import { describe, expect, it } from 'vitest'
import { refreshSummary } from './refresh-button'

const base = { inserted: 7, updated: 2, closed: 3, busy: 0, companiesDone: 12, total: 12 }

describe('refreshSummary', () => {
  it('says what changed, in the product words', () => {
    expect(refreshSummary(base)).toBe('7 new, 2 updated, 3 closed.')
  })

  it('adds that a company was already being checked, singular and plural', () => {
    expect(refreshSummary({ ...base, busy: 1 })).toBe(
      '7 new, 2 updated, 3 closed. 1 company was already being checked; its roles will appear in a few minutes.'
    )
    expect(refreshSummary({ ...base, busy: 3 })).toContain('3 companies were already being checked; their roles')
  })

  it('says how far it got when stopped', () => {
    expect(refreshSummary({ ...base, companiesDone: 5, total: 12 }, true)).toContain('Stopped after 5 of 12 companies.')
  })
})
