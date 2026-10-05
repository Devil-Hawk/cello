import { describe, expect, it } from 'vitest'
import { TRACKED_FILTER, isTrackedCompany, trackedOnly } from './watchlist'

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
