import { describe, expect, it } from 'vitest'
import { DIRECTORY_MAX_AGE_DAYS, ROLE_MAX_AGE_DAYS, isStalePosting, openRolesOnly, staleCutoffIso } from './freshness'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const DAY = 86_400_000

describe('isStalePosting', () => {
  it('is 180 days', () => {
    expect(ROLE_MAX_AGE_DAYS).toBe(180)
  })

  it('keeps a posting at exactly 180 days and drops one a moment older', () => {
    expect(isStalePosting(new Date(NOW - 180 * DAY).toISOString(), NOW)).toBe(false)
    expect(isStalePosting(new Date(NOW - 180 * DAY - 1000).toISOString(), NOW)).toBe(true)
  })

  it('keeps recent and future-dated postings', () => {
    expect(isStalePosting(new Date(NOW - 10 * DAY).toISOString(), NOW)).toBe(false)
    expect(isStalePosting(new Date(NOW + DAY).toISOString(), NOW)).toBe(false)
  })

  it('does not drop an undated or unparseable posting: there is nothing to prove it old', () => {
    expect(isStalePosting(undefined, NOW)).toBe(false)
    expect(isStalePosting(null, NOW)).toBe(false)
    expect(isStalePosting('', NOW)).toBe(false)
    expect(isStalePosting('last tuesday', NOW)).toBe(false)
  })

  it('is 30 days at an employer nobody follows', () => {
    expect(DIRECTORY_MAX_AGE_DAYS).toBe(30)
    const posted = new Date(NOW - 31 * DAY).toISOString()
    expect(isStalePosting(posted, NOW, DIRECTORY_MAX_AGE_DAYS)).toBe(true)
    expect(isStalePosting(posted, NOW)).toBe(false)
  })

  it('drops the Amazon 2017 post', () => {
    expect(isStalePosting('2017-05-23T07:50:24+00:00', NOW)).toBe(true)
  })
})

describe('openRolesOnly', () => {
  function recorder() {
    const calls: unknown[][] = []
    const q = {
      or(...args: unknown[]) {
        calls.push(['or', ...args])
        return q
      },
      not(...args: unknown[]) {
        calls.push(['not', ...args])
        return q
      },
    }
    return { q, calls }
  }

  it('limits a jobs query to recent or undated rows that are not closed', () => {
    const { q, calls } = recorder()
    expect(openRolesOnly(q, { now: NOW })).toBe(q)
    expect(calls).toEqual([
      ['or', `posted_at.gte.${staleCutoffIso(NOW)},posted_at.is.null`, undefined],
      ['not', 'still_open', 'is', false],
    ])
  })

  it('filters only the embedded jobs when the query is on another table', () => {
    const { q, calls } = recorder()
    openRolesOnly(q, { referencedTable: 'jobs', now: NOW })
    expect(calls).toEqual([
      ['or', `posted_at.gte.${staleCutoffIso(NOW)},posted_at.is.null`, { referencedTable: 'jobs' }],
      ['not', 'jobs.still_open', 'is', false],
    ])
  })
})
