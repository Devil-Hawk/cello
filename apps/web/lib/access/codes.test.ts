import { describe, expect, it } from 'vitest'
import {
  ACCESS_CODE_TTL_HOURS,
  accessCodeExpiry,
  accessCodePrefix,
  accessCodeUsability,
  describeTimeRemaining,
  generateAccessCode,
  hashAccessCode,
  looksLikeAccessCode,
  normalizeAccessCode,
} from './codes'

describe('generateAccessCode', () => {
  it('produces a grouped, readable code', () => {
    expect(generateAccessCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })

  it('never emits characters people confuse when retyping', () => {
    // 0/O, 1/I/L and U are excluded on purpose — a demo that fails because
    // someone typed a lowercase l is a bug, not user error.
    const sample = Array.from({ length: 300 }, () => generateAccessCode()).join('')
    expect(sample).not.toMatch(/[OIL01U]/)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateAccessCode()))
    expect(seen.size).toBe(500)
  })
})

describe('normalizeAccessCode', () => {
  it('accepts the forms a code takes after travelling through chat or a phone call', () => {
    const canonical = normalizeAccessCode('P7QK-3M9X-TCR2')
    for (const variant of [
      'p7qk-3m9x-tcr2',
      'P7QK 3M9X TCR2',
      ' P7QK-3M9X-TCR2 ',
      'P7QK3M9XTCR2',
      'P7QK—3M9X—TCR2', // em dashes, courtesy of autocorrect
      'P7QK_3M9X_TCR2',
    ]) {
      expect(normalizeAccessCode(variant)).toBe(canonical)
    }
  })

  it('handles empty input without throwing', () => {
    expect(normalizeAccessCode('')).toBe('')
  })
})

describe('hashAccessCode', () => {
  it('is stable across every equivalent spelling', () => {
    const a = hashAccessCode('P7QK-3M9X-TCR2')
    expect(hashAccessCode('p7qk3m9xtcr2')).toBe(a)
    expect(hashAccessCode('P7QK 3M9X TCR2')).toBe(a)
  })

  it('differs for different codes', () => {
    expect(hashAccessCode('P7QK-3M9X-TCR2')).not.toBe(hashAccessCode('P7QK-3M9X-TCR3'))
  })

  it('does not contain the code itself — a table dump must not yield a working code', () => {
    const code = generateAccessCode()
    const hash = hashAccessCode(code)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(normalizeAccessCode(code))
  })
})

describe('looksLikeAccessCode', () => {
  it('accepts what generateAccessCode produces', () => {
    for (let i = 0; i < 50; i++) expect(looksLikeAccessCode(generateAccessCode())).toBe(true)
  })

  it('rejects wrong lengths and out-of-alphabet characters', () => {
    expect(looksLikeAccessCode('')).toBe(false)
    expect(looksLikeAccessCode('P7QK-3M9X')).toBe(false)
    expect(looksLikeAccessCode('P7QK-3M9X-TCR2-EXTRA')).toBe(false)
    expect(looksLikeAccessCode('P0QK-3M9X-TCR2')).toBe(false) // 0 is not in the alphabet
    expect(looksLikeAccessCode('PIQK-3M9X-TCR2')).toBe(false) // I is not either
  })
})

describe('accessCodeExpiry', () => {
  it('is exactly 72 hours out', () => {
    const from = new Date('2026-08-03T10:00:00Z')
    expect(accessCodeExpiry(from).toISOString()).toBe('2026-08-06T10:00:00.000Z')
    expect(ACCESS_CODE_TTL_HOURS).toBe(72)
  })
})

describe('accessCodeUsability', () => {
  const now = new Date('2026-08-03T12:00:00Z')

  it('accepts a live code', () => {
    const v = accessCodeUsability({ expires_at: '2026-08-06T12:00:00Z', revoked_at: null }, now)
    expect(v.usable).toBe(true)
  })

  it('refuses an expired code', () => {
    const v = accessCodeUsability({ expires_at: '2026-08-03T11:59:59Z', revoked_at: null }, now)
    expect(v.usable).toBe(false)
    expect(v.reason).toBe('expired')
  })

  it('treats the exact expiry instant as expired', () => {
    const v = accessCodeUsability({ expires_at: now.toISOString(), revoked_at: null }, now)
    expect(v.usable).toBe(false)
  })

  it('refuses a revoked code even while it is still in date', () => {
    const v = accessCodeUsability(
      { expires_at: '2026-08-06T12:00:00Z', revoked_at: '2026-08-03T11:00:00Z' },
      now
    )
    expect(v.usable).toBe(false)
    expect(v.reason).toBe('revoked')
  })

  // The failure mode this codebase has already been bitten by once, in the
  // outreach guardrails: every comparison against NaN is false, so a naive
  // check treats a corrupt timestamp as "not yet expired" — forever.
  it('FAILS CLOSED when the expiry cannot be read', () => {
    for (const bad of [null, '', 'not-a-date', 'yesterday']) {
      const v = accessCodeUsability({ expires_at: bad, revoked_at: null }, now)
      expect(v.usable).toBe(false)
      expect(v.reason).toBe('unreadable-expiry')
    }
  })

  it('never leaks why beyond a plain sentence', () => {
    const v = accessCodeUsability({ expires_at: 'garbage', revoked_at: null }, now)
    expect(v.message).toBe('This access code is not valid.')
  })
})

describe('accessCodePrefix', () => {
  it('is the first four canonical characters', () => {
    expect(accessCodePrefix('P7QK-3M9X-TCR2')).toBe('P7QK')
    expect(accessCodePrefix('p7qk3m9xtcr2')).toBe('P7QK')
  })
})

describe('describeTimeRemaining', () => {
  const now = new Date('2026-08-03T12:00:00Z')

  it('reads naturally across the ranges the owner will see', () => {
    expect(describeTimeRemaining('2026-08-06T12:00:00Z', now)).toBe('3d left')
    expect(describeTimeRemaining('2026-08-05T18:00:00Z', now)).toBe('2d 6h left')
    expect(describeTimeRemaining('2026-08-03T17:00:00Z', now)).toBe('5h left')
    expect(describeTimeRemaining('2026-08-03T12:30:00Z', now)).toBe('30m left')
    expect(describeTimeRemaining('2026-08-03T11:00:00Z', now)).toBe('expired')
  })
})
