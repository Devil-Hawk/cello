import { afterEach, describe, expect, it } from 'vitest'
import { isCronAuthorized, isRunnerAuthorized, secretMatches } from './shared-secret'

const req = (headers: Record<string, string>, url = 'http://localhost/x') => new Request(url, { headers })

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3creT', 's3cret')).toBe(false)
  })
  it('refuses a different length without throwing', () => {
    expect(secretMatches('s3cret-and-more', 's3cret')).toBe(false)
    expect(secretMatches('s', 's3cret')).toBe(false)
  })
  it('refuses missing or empty values on either side', () => {
    expect(secretMatches(null, 's3cret')).toBe(false)
    expect(secretMatches(undefined, 's3cret')).toBe(false)
    expect(secretMatches('', 's3cret')).toBe(false)
    expect(secretMatches('s3cret', undefined)).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('isCronAuthorized', () => {
  const saved = process.env.CRON_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved
  })

  it('refuses everything when CRON_SECRET is unset or empty', () => {
    delete process.env.CRON_SECRET
    expect(isCronAuthorized(req({ authorization: 'Bearer ' }))).toBe(false)
    expect(isCronAuthorized(req({ 'x-cron-secret': '' }))).toBe(false)
    process.env.CRON_SECRET = ''
    expect(isCronAuthorized(req({ authorization: 'Bearer ', 'x-cron-secret': '' }))).toBe(false)
  })

  it('accepts a bearer (any scheme casing) or X-Cron-Secret, nothing else', () => {
    process.env.CRON_SECRET = 'abc123'
    expect(isCronAuthorized(req({ authorization: 'Bearer abc123' }))).toBe(true)
    expect(isCronAuthorized(req({ authorization: 'bearer abc123' }))).toBe(true)
    expect(isCronAuthorized(req({ 'x-cron-secret': 'abc123' }))).toBe(true)
    expect(isCronAuthorized(req({ authorization: 'Bearer abc124' }))).toBe(false)
    expect(isCronAuthorized(req({ authorization: 'abc123' }))).toBe(false)
    expect(isCronAuthorized(req({ authorization: 'Basic abc123' }))).toBe(false)
    expect(isCronAuthorized(req({ 'x-cron-secret': 'abc123x' }))).toBe(false)
    expect(isCronAuthorized(req({}))).toBe(false)
  })

  it('never reads the secret from the query string', () => {
    process.env.CRON_SECRET = 'abc123'
    expect(isCronAuthorized(req({}, 'http://localhost/x?secret=abc123&cron_secret=abc123'))).toBe(false)
  })
})

describe('isRunnerAuthorized', () => {
  const saved = process.env.BROWSER_RUNNER_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.BROWSER_RUNNER_SECRET
    else process.env.BROWSER_RUNNER_SECRET = saved
  })

  it('is bearer-only and fails closed when unset', () => {
    delete process.env.BROWSER_RUNNER_SECRET
    expect(isRunnerAuthorized(req({ authorization: 'Bearer ' }))).toBe(false)
    process.env.BROWSER_RUNNER_SECRET = 'runner-secret'
    expect(isRunnerAuthorized(req({ authorization: 'Bearer runner-secret' }))).toBe(true)
    expect(isRunnerAuthorized(req({ 'x-cron-secret': 'runner-secret' }))).toBe(false)
    expect(isRunnerAuthorized(req({ authorization: 'Bearer nope' }))).toBe(false)
  })

  it('does not accept CRON_SECRET', () => {
    process.env.BROWSER_RUNNER_SECRET = 'runner-secret'
    process.env.CRON_SECRET = 'cron-secret'
    expect(isRunnerAuthorized(req({ authorization: 'Bearer cron-secret' }))).toBe(false)
    delete process.env.CRON_SECRET
  })
})
