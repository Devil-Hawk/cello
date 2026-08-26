// Pins the SOURCE_FETCH_HOSTS exclusion scripts/backfill-company-identity.ts
// calls MANDATORY: a domain derived from a company's own job URLs must never
// be an aggregator host, because companies.domain feeds scanMergeCandidates'
// same-domain AUTO-merge. See company-domain.ts's header for the historical
// incident this guards against.

import { describe, expect, it } from 'vitest'
import { assertNotAggregatorHost, deriveCompanyDomain } from './company-domain'
import { SOURCE_FETCH_HOSTS } from '../sources/util'

describe('assertNotAggregatorHost', () => {
  it('throws for every host in SOURCE_FETCH_HOSTS', () => {
    for (const host of SOURCE_FETCH_HOSTS) {
      expect(() => assertNotAggregatorHost(host)).toThrow(/aggregator host/)
      expect(() => assertNotAggregatorHost(`www.${host}`)).toThrow(/aggregator host/)
    }
  })

  it('never throws for a real employer domain', () => {
    expect(() => assertNotAggregatorHost('acme.example.com')).not.toThrow()
  })
})

describe('deriveCompanyDomain', () => {
  it('skips aggregator-hosted job URLs and returns the first real employer domain', () => {
    const domain = deriveCompanyDomain([
      'https://www.themuse.com/jobs/acme/senior-engineer',
      'https://arbeitnow.com/view/some-id',
      'https://careers.acme.example.com/senior-engineer',
    ])
    expect(domain).toBe('careers.acme.example.com')
  })

  it('returns null when every URL is an aggregator (or none parse)', () => {
    expect(deriveCompanyDomain(['https://www.themuse.com/jobs/x', null, 'not a url'])).toBeNull()
    expect(deriveCompanyDomain([])).toBeNull()
  })
})
