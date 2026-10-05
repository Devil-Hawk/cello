import { describe, expect, it } from 'vitest'
import { TRACKED_FILTER, careersSiteUnreadable, isTrackedCompany, trackedOnly } from './watchlist'

describe('trackedOnly', () => {
  it('passes the null-safe or-filter to the query', () => {
    const calls: string[] = []
    const q = {
      or(f: string) {
        calls.push(f)
        return q
      },
    }
    expect(trackedOnly(q)).toBe(q)
    expect(calls).toEqual(['metadata->>suggested.is.null,metadata->>suggested.neq.true'])
    expect(TRACKED_FILTER).toBe(calls[0])
  })
})

describe('isTrackedCompany', () => {
  it('keeps rows without a suggested flag', () => {
    expect(isTrackedCompany({})).toBe(true)
    expect(isTrackedCompany({ metadata: null })).toBe(true)
    expect(isTrackedCompany({ metadata: {} })).toBe(true)
    expect(isTrackedCompany({ metadata: { suggested: false } })).toBe(true)
    expect(isTrackedCompany({ metadata: { suggested: 'true' } })).toBe(true)
  })
  it('drops suggested rows', () => {
    expect(isTrackedCompany({ metadata: { suggested: true, source: 'gmail' } })).toBe(false)
  })
})

describe('careersSiteUnreadable', () => {
  const ats = { provider: 'greenhouse', token: 'x' }
  it('is false while there are open roles', () => {
    expect(careersSiteUnreadable({ metadata: { ats_checked_at: 'x' } }, 3)).toBe(false)
  })
  it('is false for a company that was never checked', () => {
    expect(careersSiteUnreadable({ metadata: null, last_scraped_at: null }, 0)).toBe(false)
  })
  it('is false when a board is mapped', () => {
    expect(careersSiteUnreadable({ metadata: { ats, ats_checked_at: 'x' } }, 0)).toBe(false)
  })
  it('is true after a check found nothing', () => {
    expect(careersSiteUnreadable({ metadata: { ats_checked_at: 'x' } }, 0)).toBe(true)
    expect(careersSiteUnreadable({ metadata: null, last_scraped_at: '2026-10-01' }, 0)).toBe(true)
  })
})
