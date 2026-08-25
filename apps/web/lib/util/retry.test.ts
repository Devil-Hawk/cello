import { describe, expect, it } from 'vitest'
import { classifyError, isTransient } from './retry'

/** Minimal shape matching lib/ats/http.ts's HttpError / the OpenAI SDK's APIError. */
class FakeHttpError extends Error {
  readonly status: number
  readonly retryAfter: number | null
  constructor(status: number, retryAfter: number | null = null) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

describe('classifyError', () => {
  it('classifies retryable HTTP statuses as transient', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 522, 524, 529]) {
      expect(classifyError(new FakeHttpError(status)), `status ${status}`).toBe('transient')
    }
  })

  it('classifies non-retryable HTTP statuses as permanent', () => {
    for (const status of [400, 401, 402, 403, 404, 409, 410, 422]) {
      expect(classifyError(new FakeHttpError(status)), `status ${status}`).toBe('permanent')
    }
  })

  it('classifies an unrecognized 5xx as transient and an unrecognized 4xx as permanent', () => {
    expect(classifyError(new FakeHttpError(599))).toBe('transient')
    expect(classifyError(new FakeHttpError(451))).toBe('permanent')
  })

  it('classifies MissingKeyError, BudgetCapError, TruncatedResponseError as permanent by name', () => {
    class MissingKeyError extends Error {
      constructor() {
        super('no key')
        this.name = 'MissingKeyError'
      }
    }
    class BudgetCapError extends Error {
      constructor() {
        super('over budget')
        this.name = 'BudgetCapError'
      }
    }
    class TruncatedResponseError extends Error {
      constructor() {
        super('truncated')
        this.name = 'TruncatedResponseError'
      }
    }
    expect(classifyError(new MissingKeyError())).toBe('permanent')
    expect(classifyError(new BudgetCapError())).toBe('permanent')
    expect(classifyError(new TruncatedResponseError())).toBe('permanent')
  })

  it('classifies network error codes as transient, including nested in .cause', () => {
    const direct = Object.assign(new Error('boom'), { code: 'ECONNRESET' })
    expect(classifyError(direct)).toBe('transient')

    const nested = new Error('fetch failed')
    ;(nested as unknown as { cause: unknown }).cause = { code: 'ETIMEDOUT' }
    expect(classifyError(nested)).toBe('transient')
  })

  it('classifies a plain AbortError as transient (ambiguity resolved by the caller\'s own AbortSignal passed to p-retry)', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    expect(classifyError(err)).toBe('transient')
  })

  it('classifies an unrecognized error as unknown, not transient', () => {
    expect(classifyError(new TypeError('something odd'))).toBe('unknown')
    expect(classifyError('a string')).toBe('unknown')
    expect(classifyError(null)).toBe('unknown')
    expect(classifyError(undefined)).toBe('unknown')
  })

  it('classifies a fetch-failed TypeError (Node/undici network error) as transient by message', () => {
    // What Node's global fetch actually throws on a dropped connection: a
    // bare TypeError with message "fetch failed" and the real cause nested.
    const err = new TypeError('fetch failed')
    expect(classifyError(err)).toBe('transient')
  })
})

describe('isTransient', () => {
  it('mirrors classifyError() === "transient"', () => {
    expect(isTransient(new FakeHttpError(429))).toBe(true)
    expect(isTransient(new FakeHttpError(402))).toBe(false)
    expect(isTransient(new TypeError('bug'))).toBe(false)
  })
})
