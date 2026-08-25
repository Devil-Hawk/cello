// Tests for lib/ats-apply/detect.ts — the pure URL-parsing gate that decides
// whether an application even qualifies for the official-API path. This is
// the FIRST guardrail in submitApplication: any URL that doesn't parse into a
// recognized Greenhouse/Lever/Ashby posting must return null here, which is
// what forces submitApplication down the HANDOFF branch and away from any
// possibility of a blind POST. ZERO network, ZERO DB — pure functions only.

import { describe, expect, it } from 'vitest'
import { detectApplyTarget, buildApplyUrl } from './detect'

describe('detectApplyTarget — recognized official-ATS URLs', () => {
  it('parses a standard Greenhouse posting URL', () => {
    const target = detectApplyTarget('https://boards.greenhouse.io/acme/jobs/1234567')
    expect(target).toEqual({ provider: 'greenhouse', slug: 'acme', jobId: '1234567', host: 'boards.greenhouse.io' })
  })

  it('parses a Greenhouse EU-region board host', () => {
    const target = detectApplyTarget('https://boards.eu.greenhouse.io/acme/jobs/9')
    expect(target).toMatchObject({ provider: 'greenhouse', host: 'boards.eu.greenhouse.io' })
  })

  it('parses a Greenhouse embed URL', () => {
    const target = detectApplyTarget('https://boards.greenhouse.io/embed/job_app/acme/jobs/42')
    expect(target).toMatchObject({ provider: 'greenhouse', slug: 'acme', jobId: '42' })
  })

  it('parses a standard Lever posting URL', () => {
    const target = detectApplyTarget('https://jobs.lever.co/acme/abcd-1234-uuid')
    expect(target).toEqual({ provider: 'lever', slug: 'acme', jobId: 'abcd-1234-uuid', host: 'jobs.lever.co' })
  })

  it('parses a standard Ashby posting URL', () => {
    const target = detectApplyTarget('https://jobs.ashbyhq.com/acme/job-uuid-here')
    expect(target).toEqual({ provider: 'ashby', slug: 'acme', jobId: 'job-uuid-here', host: 'jobs.ashbyhq.com' })
  })

  it('a Greenhouse board landing page with no job id still identifies the provider (useful for handoff)', () => {
    const target = detectApplyTarget('https://boards.greenhouse.io/acme')
    expect(target).toEqual({ provider: 'greenhouse', slug: 'acme', jobId: null, host: 'boards.greenhouse.io' })
  })
})

describe('detectApplyTarget — unsupported / malformed URLs return null (never throw)', () => {
  it('a random company career-page URL (not an official ATS) is unsupported', () => {
    expect(detectApplyTarget('https://example.com/careers/senior-engineer')).toBeNull()
  })

  it('a plain http:// URL (not https) is rejected even for an otherwise-valid ATS host', () => {
    expect(detectApplyTarget('http://boards.greenhouse.io/acme/jobs/1234')).toBeNull()
  })

  it('an unparseable string does not throw and returns null', () => {
    expect(detectApplyTarget('not a url at all')).toBeNull()
  })

  it('null/undefined/empty input returns null without throwing', () => {
    expect(detectApplyTarget(null)).toBeNull()
    expect(detectApplyTarget(undefined)).toBeNull()
    expect(detectApplyTarget('')).toBeNull()
  })

  it('a slug containing characters outside the safe allowlist is rejected before being interpolated into any URL', () => {
    // SAFE_SLUG is [a-zA-Z0-9._-]+ — a semicolon/space-bearing slug must never
    // reach buildApplyUrl/postJson, where it would be string-interpolated.
    expect(detectApplyTarget('https://jobs.lever.co/acme%3Bevil/1234')).toBeNull()
    expect(detectApplyTarget('https://jobs.lever.co/ac%20me/1234')).toBeNull()
  })

  it('an entirely unrecognized host never matches, even with a Greenhouse-shaped path', () => {
    expect(detectApplyTarget('https://not-greenhouse.example/acme/jobs/123')).toBeNull()
  })
})

describe('buildApplyUrl', () => {
  it('builds a Greenhouse apply URL with the #app anchor when a jobId is present', () => {
    const target = detectApplyTarget('https://boards.greenhouse.io/acme/jobs/1234567')!
    expect(buildApplyUrl(target, 'https://boards.greenhouse.io/acme/jobs/1234567')).toBe(
      'https://boards.greenhouse.io/acme/jobs/1234567#app'
    )
  })

  it('falls back to the original URL when there is no jobId to build a deep link from', () => {
    const target = detectApplyTarget('https://boards.greenhouse.io/acme')!
    const original = 'https://boards.greenhouse.io/acme'
    expect(buildApplyUrl(target, original)).toBe(original)
  })

  it('builds a Lever apply URL', () => {
    const target = detectApplyTarget('https://jobs.lever.co/acme/abcd-1234')!
    expect(buildApplyUrl(target, 'https://jobs.lever.co/acme/abcd-1234')).toBe(
      'https://jobs.lever.co/acme/abcd-1234/apply'
    )
  })

  it('builds an Ashby apply URL', () => {
    const target = detectApplyTarget('https://jobs.ashbyhq.com/acme/job-uuid')!
    expect(buildApplyUrl(target, 'https://jobs.ashbyhq.com/acme/job-uuid')).toBe(
      'https://jobs.ashbyhq.com/acme/job-uuid/application'
    )
  })
})
