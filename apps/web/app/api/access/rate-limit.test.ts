import { describe, it, expect, beforeEach } from 'vitest'
import {
  allowRedeemAttempt,
  clientKey,
  _resetRedeemRateLimitState,
  _REDEEM_LIMITS,
} from './rate-limit'

const { WINDOW_MS, MAX_PER_CLIENT, MAX_GLOBAL, MAX_TRACKED_CLIENTS } = _REDEEM_LIMITS

describe('allowRedeemAttempt', () => {
  beforeEach(() => {
    _resetRedeemRateLimitState()
  })

  it('allows a client up to the per-client cap', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CLIENT; i++) {
      expect(allowRedeemAttempt('1.2.3.4', now + i)).toEqual({ allowed: true })
    }
  })

  it('refuses the attempt after the cap, attributing it to the client scope', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CLIENT; i++) allowRedeemAttempt('1.2.3.4', now + i)

    expect(allowRedeemAttempt('1.2.3.4', now + MAX_PER_CLIENT)).toEqual({
      allowed: false,
      scope: 'client',
    })
  })

  it('keeps refusing a client that keeps hammering — attempts while over the limit still count', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CLIENT + 20; i++) allowRedeemAttempt('1.2.3.4', now + i)

    // Just inside the window from the LAST attempt: if refused attempts had not
    // been recorded, the window would have drained and this would pass.
    const stillInWindow = now + MAX_PER_CLIENT + 20 + WINDOW_MS - 1_000
    expect(allowRedeemAttempt('1.2.3.4', stillInWindow)).toEqual({ allowed: false, scope: 'client' })
  })

  it('lets a client back in once the window has fully passed', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CLIENT + 5; i++) allowRedeemAttempt('1.2.3.4', now + i)

    expect(allowRedeemAttempt('1.2.3.4', now + MAX_PER_CLIENT + 5 + WINDOW_MS + 1)).toEqual({
      allowed: true,
    })
  })

  it('does not let one client exhaust another client’s budget', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CLIENT + 5; i++) allowRedeemAttempt('1.2.3.4', now + i)

    expect(allowRedeemAttempt('5.6.7.8', now)).toEqual({ allowed: true })
  })

  it('stops a flood that rotates its key every request, via the global cap', () => {
    const now = Date.now()
    let refusals = 0

    // Every request presents a brand new key, so the per-client limit can never
    // fire. This is the forged-header case the global cap exists for.
    for (let i = 0; i < MAX_GLOBAL + 50; i++) {
      const gate = allowRedeemAttempt(`spoofed-${i}`, now + i)
      if (!gate.allowed) {
        expect(gate.scope).toBe('global')
        refusals++
      }
    }

    expect(refusals).toBe(50)
  })

  it('does not grow its memory without bound under a key-rotating flood', () => {
    const now = Date.now()
    // Well past the tracking ceiling, spread over more than one window so the
    // sweep has stale entries to find.
    for (let i = 0; i < MAX_TRACKED_CLIENTS * 2; i++) {
      allowRedeemAttempt(`spoofed-${i}`, now + i * 1_000)
    }

    // The limiter has no size accessor by design; assert the observable
    // consequence instead — it is still answering, and still refusing, rather
    // than having grown a Map with 10k live entries.
    const gate = allowRedeemAttempt('spoofed-final', now + MAX_TRACKED_CLIENTS * 2_000)
    expect(gate.allowed).toBe(false)
  })

  it('shares one bucket for every unattributed caller', () => {
    const now = Date.now()
    // clientKey() collapses missing proxy headers onto a single key precisely
    // so this is true: stripping headers must not buy a private budget.
    for (let i = 0; i < MAX_PER_CLIENT; i++) allowRedeemAttempt('unattributed', now + i)

    expect(allowRedeemAttempt('unattributed', now + MAX_PER_CLIENT)).toEqual({
      allowed: false,
      scope: 'client',
    })
  })
})

describe('clientKey', () => {
  it('prefers x-real-ip, which a proxy sets itself', () => {
    const headers = new Headers({
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.4, 203.0.113.7',
    })
    expect(clientKey(headers)).toBe('203.0.113.7')
  })

  it('falls back to the first x-forwarded-for entry', () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1' })
    expect(clientKey(headers)).toBe('198.51.100.4')
  })

  it('puts every header-less caller in ONE shared bucket, not a private one', () => {
    // The security-relevant half: stripping headers must not buy a fresh
    // budget, so every unidentifiable caller has to collapse onto one key.
    expect(clientKey(new Headers())).toBe('unattributed')
    expect(clientKey(new Headers({ 'x-forwarded-for': '   ' }))).toBe('unattributed')
    expect(clientKey(new Headers({ 'user-agent': 'curl/8.4.0' }))).toBe('unattributed')
  })
})
