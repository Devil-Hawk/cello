import { beforeEach, describe, expect, it } from 'vitest'
import { _resetSearchRateLimitState, allowSearchRequest } from './rate-limit'

beforeEach(() => {
  _resetSearchRateLimitState()
})

describe('allowSearchRequest', () => {
  it('allows requests under the per-window cap and blocks the next one', () => {
    const userId = 'user-1'
    const t0 = 1_000_000
    for (let i = 0; i < 12; i++) {
      expect(allowSearchRequest(userId, t0 + i)).toBe(true)
    }
    expect(allowSearchRequest(userId, t0 + 12)).toBe(false)
  })

  it('tracks separate users independently', () => {
    const t0 = 2_000_000
    for (let i = 0; i < 12; i++) allowSearchRequest('user-a', t0 + i)
    expect(allowSearchRequest('user-a', t0 + 12)).toBe(false)
    expect(allowSearchRequest('user-b', t0 + 12)).toBe(true)
  })

  it('allows again once the window has fully slid past the earlier hits', () => {
    const userId = 'user-2'
    const t0 = 3_000_000
    for (let i = 0; i < 12; i++) allowSearchRequest(userId, t0 + i)
    expect(allowSearchRequest(userId, t0 + 12)).toBe(false)
    // 60s+1ms later, every earlier hit has aged out of the window.
    expect(allowSearchRequest(userId, t0 + 60_001)).toBe(true)
  })
})
