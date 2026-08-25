import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetSearchHealthState,
  getAllBackendHealth,
  getBackendHealthRecord,
  isBackendRecentlyFailed,
  recordBackendFailure,
  recordBackendSuccess,
} from './health'

beforeEach(() => {
  _resetSearchHealthState()
})

describe('search backend health memory', () => {
  it('reports no failure for a backend nothing was ever recorded against', () => {
    expect(isBackendRecentlyFailed('duckduckgo')).toBe(false)
    expect(getBackendHealthRecord('duckduckgo')).toBeNull()
  })

  it('marks a backend recently-failed immediately after recordBackendFailure', () => {
    const t0 = 1_000_000
    recordBackendFailure('duckduckgo', 'blocked', 'bot challenge', t0)
    expect(isBackendRecentlyFailed('duckduckgo', t0)).toBe(true)
    const rec = getBackendHealthRecord('duckduckgo', t0)
    expect(rec).toMatchObject({ backend: 'duckduckgo', reason: 'blocked', detail: 'bot challenge' })
  })

  it('self-heals once the reason-specific TTL has passed', () => {
    const t0 = 2_000_000
    recordBackendFailure('duckduckgo', 'blocked', 'bot challenge', t0)
    // blocked TTL is 10 minutes — still down 1ms before it expires...
    expect(isBackendRecentlyFailed('duckduckgo', t0 + 10 * 60_000 - 1)).toBe(true)
    // ...and healthy again the instant it does.
    expect(isBackendRecentlyFailed('duckduckgo', t0 + 10 * 60_000 + 1)).toBe(false)
    expect(getBackendHealthRecord('duckduckgo', t0 + 10 * 60_000 + 1)).toBeNull()
  })

  it('uses a shorter TTL for a plain transient rate limit than for a bot-block', () => {
    const t0 = 3_000_000
    recordBackendFailure('exa', 'rate_limited', '429', t0)
    // rate_limited TTL is 2 minutes — already healed by the 10-minute mark
    // that a 'blocked' failure would still be serving.
    expect(isBackendRecentlyFailed('exa', t0 + 2 * 60_000 + 1)).toBe(false)
  })

  it('clears a remembered failure immediately on recordBackendSuccess, before its TTL', () => {
    const t0 = 4_000_000
    recordBackendFailure('tavily', 'quota', 'monthly cap reached', t0)
    expect(isBackendRecentlyFailed('tavily', t0 + 1000)).toBe(true)
    recordBackendSuccess('tavily')
    expect(isBackendRecentlyFailed('tavily', t0 + 1000)).toBe(false)
  })

  it('tracks every backend independently', () => {
    const t0 = 5_000_000
    recordBackendFailure('duckduckgo', 'blocked', undefined, t0)
    expect(isBackendRecentlyFailed('duckduckgo', t0)).toBe(true)
    expect(isBackendRecentlyFailed('exa', t0)).toBe(false)
    expect(isBackendRecentlyFailed('tavily', t0)).toBe(false)
  })

  it('getAllBackendHealth lists only currently-live (unexpired) records', () => {
    const t0 = 6_000_000
    recordBackendFailure('duckduckgo', 'blocked', undefined, t0) // 10min TTL
    recordBackendFailure('exa', 'rate_limited', undefined, t0) // 2min TTL — expires first
    const later = t0 + 3 * 60_000
    const live = getAllBackendHealth(later)
    expect(live.map((r) => r.backend)).toEqual(['duckduckgo'])
  })

  it('falls back to the default TTL for a reason with no explicit entry', () => {
    const t0 = 7_000_000
    // 'no_key' has no TTL_BY_REASON entry — still must not crash or live
    // forever; falls back to DEFAULT_TTL_MS (5 minutes) rather than being
    // silently dropped.
    recordBackendFailure('searxng', 'no_key', undefined, t0)
    expect(isBackendRecentlyFailed('searxng', t0 + 1000)).toBe(true)
    expect(isBackendRecentlyFailed('searxng', t0 + 5 * 60_000 + 1)).toBe(false)
  })
})
