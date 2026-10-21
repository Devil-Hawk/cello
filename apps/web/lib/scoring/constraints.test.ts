import { describe, expect, it } from 'vitest'
import { NO_CONSTRAINTS, containsWord, hasAnyConstraint, parsePayRange, resolveConstraints, sponsorshipRefusal } from './constraints'
import type { RoleFacts } from './types'

function role(p: Partial<RoleFacts> = {}): RoleFacts {
  return { id: 'j1', title: 'Backend Engineer', company: 'Acme', location: 'Seattle, WA', description: 'Build services.', ...p }
}

describe('resolveConstraints', () => {
  it('reads nothing from an empty or malformed blob and never throws', () => {
    expect(resolveConstraints(null)).toEqual(NO_CONSTRAINTS)
    expect(resolveConstraints({ constraints: 'x', targeting: 5 })).toEqual(NO_CONSTRAINTS)
    expect(hasAnyConstraint(NO_CONSTRAINTS)).toBe(false)
  })

  it('merges the older targeting fields in', () => {
    const c = resolveConstraints({
      constraints: { needsSponsorship: true, salaryFloorUsd: 150000, blockedCountries: ['in'] },
      targeting: { excludedCompanies: ['Coinbase'], countries: ['us'], remoteOnly: true, excludedKeywords: ['intern'] },
    })
    expect(c).toMatchObject({
      needsSponsorship: true,
      salaryFloorUsd: 150000,
      blockedCountries: ['IN'],
      onlyCountries: ['US'],
      remoteOnly: true,
      excludedCompanies: ['coinbase'],
      excludedTitleWords: ['intern'],
    })
    expect(hasAnyConstraint(c)).toBe(true)
  })
})

describe('containsWord', () => {
  it('matches whole words only', () => {
    expect(containsWord('Software Intern', 'intern')).toBe(true)
    expect(containsWord('Internal Tools Engineer', 'intern')).toBe(false)
    expect(containsWord('Senior Director, Sales', 'director')).toBe(true)
    expect(containsWord('Wholesale Buyer', 'sale')).toBe(false)
  })
})

describe('parsePayRange', () => {
  it('reads dollar ranges in several spellings', () => {
    expect(parsePayRange('$150,000 - $200,000')).toEqual({ min: 150000, max: 200000 })
    expect(parsePayRange('$150k to $210k USD')).toEqual({ min: 150000, max: 210000 })
    expect(parsePayRange('$60 - $80 per hour')).toEqual({ min: 124800, max: 166400 })
  })
  it('refuses what is not a salary', () => {
    expect(parsePayRange('Competitive')).toBeNull()
    expect(parsePayRange(null)).toBeNull()
    expect(parsePayRange('€90,000 - €110,000')).toBeNull()
    expect(parsePayRange('$5')).toBeNull()
  })
})

describe('sponsorshipRefusal', () => {
  it.each([
    'We are unable to sponsor visas at this time.',
    'Candidates must be authorized to work in the US without sponsorship.',
    'This role does not offer visa sponsorship.',
    'No sponsorship available for this position.',
  ])('finds %s', (s) => {
    expect(sponsorshipRefusal(`Intro text. ${s} More text.`)).toContain(s.slice(0, 15))
  })
  it('stays silent when the posting says nothing or offers sponsorship', () => {
    expect(sponsorshipRefusal('We sponsor visas for strong candidates.')).toBeNull()
    expect(sponsorshipRefusal(null)).toBeNull()
  })
})
