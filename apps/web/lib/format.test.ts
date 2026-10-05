import { describe, expect, it } from 'vitest'
import { isUnknownText, knownParts } from './format'
import { computeJobProvenance } from './sources/provenance'

describe('knownParts', () => {
  it('drops placeholder and blank values from meta lines', () => {
    expect(knownParts('Bengaluru', null, 'unknown', ' Unknown ', '', 'N/A', 'Full-time')).toEqual([
      'Bengaluru',
      'Full-time',
    ])
  })

  it('keeps real values that merely contain a placeholder word', () => {
    expect(isUnknownText('Unknown Worlds, Remote')).toBe(false)
    expect(isUnknownText(undefined)).toBe(true)
  })
})

describe('provenance discovery date', () => {
  const base = {
    jobId: 'j1',
    jobUrl: 'https://example.com/jobs/1',
    jobSource: 'greenhouse',
    description: 'x'.repeat(200),
    postedAt: null,
    companyId: 'c1',
    companyName: 'Stripe',
    companyDomain: 'stripe.com',
    companySuggested: false,
    companyAtsProvider: null,
  }

  it('renders a readable date, never the raw ISO timestamp', () => {
    const reasons = computeJobProvenance({ ...base, discoveredAt: '2020-10-05T08:34:15.439+00:00' }).reasons
    const seen = reasons.find((r) => r.startsWith('Seen once on'))
    expect(seen).toBe('Seen once on Oct 5, 2020 and never re-checked since.')
    expect(seen).not.toMatch(/T\d\d:/)
  })
})
