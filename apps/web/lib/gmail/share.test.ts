import { describe, expect, it } from 'vitest'
import { MAX_SHARE_BODY_LENGTH, MAX_SHARE_FIELD_LENGTH, validateShareInput } from './share'

const VALID = { subject: 'Your application to Acme', from: 'careers@acme.com', body: 'Thanks for applying.' }

describe('validateShareInput', () => {
  it('accepts a well-formed paste, defaulting receivedAt to now', () => {
    const before = Date.now()
    const result = validateShareInput(VALID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject).toBe(VALID.subject)
      expect(result.value.from).toBe(VALID.from)
      expect(result.value.body).toBe(VALID.body)
      expect(result.value.receivedAt.getTime()).toBeGreaterThanOrEqual(before)
    }
  })

  it('accepts an explicit valid receivedAt', () => {
    const result = validateShareInput({ ...VALID, receivedAt: '2026-01-01T00:00:00.000Z' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.receivedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('trims whitespace from string fields', () => {
    const result = validateShareInput({ subject: '  hi  ', from: '  a@b.com  ', body: '  body  ' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject).toBe('hi')
      expect(result.value.from).toBe('a@b.com')
      expect(result.value.body).toBe('body')
    }
  })

  for (const field of ['subject', 'from', 'body'] as const) {
    it(`rejects a missing ${field}`, () => {
      const raw = { ...VALID, [field]: undefined }
      const result = validateShareInput(raw)
      expect(result.ok).toBe(false)
    })

    it(`rejects a whitespace-only ${field}`, () => {
      const result = validateShareInput({ ...VALID, [field]: '   ' })
      expect(result.ok).toBe(false)
    })

    it(`rejects a non-string ${field}`, () => {
      const result = validateShareInput({ ...VALID, [field]: 12345 })
      expect(result.ok).toBe(false)
    })
  }

  it('rejects a subject over the length limit', () => {
    const result = validateShareInput({ ...VALID, subject: 'x'.repeat(MAX_SHARE_FIELD_LENGTH + 1) })
    expect(result.ok).toBe(false)
  })

  it('rejects a body over the length limit', () => {
    const result = validateShareInput({ ...VALID, body: 'x'.repeat(MAX_SHARE_BODY_LENGTH + 1) })
    expect(result.ok).toBe(false)
  })

  it('accepts a body exactly at the length limit', () => {
    const result = validateShareInput({ ...VALID, body: 'x'.repeat(MAX_SHARE_BODY_LENGTH) })
    expect(result.ok).toBe(true)
  })

  it('rejects an invalid receivedAt string', () => {
    const result = validateShareInput({ ...VALID, receivedAt: 'not-a-date' })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-string receivedAt', () => {
    const result = validateShareInput({ ...VALID, receivedAt: 12345 })
    expect(result.ok).toBe(false)
  })
})
