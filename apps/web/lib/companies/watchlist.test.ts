import { describe, expect, it } from 'vitest'
import { TRACKED_FILTER, isTrackedCompany, trackedOnly } from './watchlist'

describe('trackedOnly', () => {
  it('passes the watching filter to the query', () => {
    const calls: string[] = []
    const q = {
      or(f: string) {
        calls.push(f)
        return q
      },
    }
    expect(trackedOnly(q)).toBe(q)
    expect(calls).toEqual(['watching.eq.true'])
    expect(TRACKED_FILTER).toBe(calls[0])
  })
})

describe('isTrackedCompany', () => {
  it('follows the watching column when the row has it', () => {
    expect(isTrackedCompany({ watching: true })).toBe(true)
    expect(isTrackedCompany({ watching: false })).toBe(false)
    expect(isTrackedCompany({ watching: false, metadata: {} })).toBe(false)
    expect(isTrackedCompany({ watching: true, metadata: { suggested: true } })).toBe(true)
  })
  it('keeps rows without a suggested flag when the row has no column', () => {
    expect(isTrackedCompany({})).toBe(true)
    expect(isTrackedCompany({ metadata: null })).toBe(true)
    expect(isTrackedCompany({ metadata: {} })).toBe(true)
    expect(isTrackedCompany({ metadata: { suggested: false } })).toBe(true)
    expect(isTrackedCompany({ metadata: { suggested: 'true' } })).toBe(true)
  })
  it('drops suggested rows when the row has no column', () => {
    expect(isTrackedCompany({ metadata: { suggested: true, source: 'gmail' } })).toBe(false)
  })
})
