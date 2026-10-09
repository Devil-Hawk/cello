import { describe, expect, it } from 'vitest'
import { NO_CONSTRAINTS, checkConstraints, containsWord, hasAnyConstraint, parsePayRange, resolveConstraints, sponsorshipRefusal } from './constraints'
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

describe('checkConstraints', () => {
  it('keeps a role when nothing is stated', () => {
    expect(checkConstraints(role(), NO_CONSTRAINTS)).toEqual([])
  })

  it('blocks a ruled out company by whole name, with the reason', () => {
    const c = { ...NO_CONSTRAINTS, excludedCompanies: ['coinbase'] }
    expect(checkConstraints(role({ company: 'Coinbase' }), c)[0]).toEqual({ kind: 'company', text: 'You ruled out Coinbase.' })
    expect(checkConstraints(role({ company: 'Coinbase Custody Labs' }), c)).toHaveLength(1)
    expect(checkConstraints(role({ company: 'Bluecoin' }), c)).toEqual([])
  })

  it('blocks a country they cannot work in', () => {
    const c = { ...NO_CONSTRAINTS, blockedCountries: ['IN'] }
    const r = checkConstraints(role({ location: 'Bangalore, India' }), c)
    expect(r).toHaveLength(1)
    expect(r[0].text).toBe('It is based in India, and you said you cannot work there.')
  })

  it('applies only-these-countries when the location is known and passes when it is not', () => {
    const c = { ...NO_CONSTRAINTS, onlyCountries: ['US'] }
    expect(checkConstraints(role({ location: 'London, UK' }), c)[0].kind).toBe('location')
    expect(checkConstraints(role({ location: 'Remote' }), c)).toEqual([])
    expect(checkConstraints(role({ location: null }), c)).toEqual([])
  })

  it('applies remote-only to roles listed with an office, not to unlisted ones', () => {
    const c = { ...NO_CONSTRAINTS, remoteOnly: true }
    expect(checkConstraints(role({ location: 'Austin, TX' }), c)[0].kind).toBe('remote')
    expect(checkConstraints(role({ location: 'Remote - US' }), c)).toEqual([])
    expect(checkConstraints(role({ location: '' }), c)).toEqual([])
  })

  it('limits on-site work to the cities they named but lets remote and hybrid listings through', () => {
    const c = { ...NO_CONSTRAINTS, onsiteCities: ['seattle'] }
    expect(checkConstraints(role({ location: 'Seattle, WA' }), c)).toEqual([])
    expect(checkConstraints(role({ location: 'Remote - US' }), c)).toEqual([])
    expect(checkConstraints(role({ location: 'Hybrid (Multiple locations)' }), c)).toEqual([])
    expect(checkConstraints(role({ location: 'Austin, TX' }), c)[0].text).toMatch(/on site in Austin, TX/)
  })

  it('blocks on sponsorship only when needed and the posting refuses', () => {
    const d = 'Great team. We are unable to sponsor work visas. Apply now.'
    const need = { ...NO_CONSTRAINTS, needsSponsorship: true }
    expect(checkConstraints(role({ description: d }), need)[0].kind).toBe('sponsorship')
    expect(checkConstraints(role({ description: d }), NO_CONSTRAINTS)).toEqual([])
    expect(checkConstraints(role({ description: 'We sponsor visas.' }), need)).toEqual([])
  })

  it('applies a salary floor only to a stated range whose top is below it', () => {
    const c = { ...NO_CONSTRAINTS, salaryFloorUsd: 190000 }
    expect(checkConstraints(role({ salaryRange: '$120,000 - $160,000' }), c)[0].kind).toBe('salary')
    expect(checkConstraints(role({ salaryRange: '$150,000 - $210,000' }), c)).toEqual([])
    expect(checkConstraints(role({ salaryRange: null }), c)).toEqual([])
    const fromText = role({ description: 'Compensation: The base pay range for this role is $100,000 - $140,000 per year.' })
    expect(checkConstraints(fromText, c)[0].kind).toBe('salary')
    expect(checkConstraints(role({ description: 'We raised $200 million last year.' }), c)).toEqual([])
  })

  it('refuses a level they will not take, from the title', () => {
    const c = { ...NO_CONSTRAINTS, refusedSeniority: ['intern', 'manager'] }
    expect(checkConstraints(role({ title: 'Software Engineering Intern' }), c)[0].kind).toBe('seniority')
    expect(checkConstraints(role({ title: 'Engineering Manager' }), c)[0].kind).toBe('seniority')
    expect(checkConstraints(role({ title: 'Senior Software Engineer' }), c)).toEqual([])
  })

  it('matches excluded title words as whole words', () => {
    const c = { ...NO_CONSTRAINTS, excludedTitleWords: ['intern'] }
    expect(checkConstraints(role({ title: 'Data Intern' }), c)[0].kind).toBe('keyword')
    expect(checkConstraints(role({ title: 'Internal Tools Engineer' }), c)).toEqual([])
  })

  it('reports every broken constraint, not just the first', () => {
    const c = { ...NO_CONSTRAINTS, excludedCompanies: ['acme'], blockedCountries: ['IN'] }
    expect(checkConstraints(role({ location: 'Pune, India' }), c).map((r) => r.kind).sort()).toEqual(['company', 'location'])
  })
})
