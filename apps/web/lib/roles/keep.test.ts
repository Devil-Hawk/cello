import { describe, expect, it } from 'vitest'
import { EMPTY_TARGETING } from '../targeting'
import { hasPersonTargets, type PersonTargets, type TypeStep } from '../jobs/target-relevance'
import { typeTitle } from '../jobs/role-types'
import { NO_CONSTRAINTS, type StatedConstraints } from '../scoring/constraints'
import type { RoleFacts } from '../scoring/types'
import { blockReasons, keepsRole, type RoleToKeep } from './keep'

const day = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * day).toISOString()

const role = (over: Partial<RoleToKeep> = {}): RoleToKeep => ({
  title: 'Platform Engineer',
  job_function: 'engineering',
  seniority: 'senior',
  country: 'US',
  language: 'en',
  is_remote: null,
  postedAt: ago(3),
  ...over,
})

const targets = (over: Record<string, unknown> = {}, titles: string[] = [], constraints?: Partial<StatedConstraints>): PersonTargets => ({
  targeting: { ...EMPTY_TARGETING, ...over },
  titles,
  ...(constraints ? { constraints: { ...NO_CONSTRAINTS, ...constraints } } : {}),
})

describe('hasPersonTargets', () => {
  it('is false with nothing stated, true with a function, a place, an exclusion, a typed title or a dealbreaker', () => {
    expect(hasPersonTargets(targets())).toBe(false)
    expect(hasPersonTargets(targets({ functions: ['engineering'] }))).toBe(true)
    expect(hasPersonTargets(targets({ countries: ['US'] }))).toBe(true)
    expect(hasPersonTargets(targets({ excludedKeywords: ['crypto'] }))).toBe(true)
    expect(hasPersonTargets(targets({}, ['Backend Engineer']))).toBe(true)
    expect(hasPersonTargets(targets({}, ['  ']))).toBe(false)
    expect(hasPersonTargets(targets({}, [], { needsSponsorship: true }))).toBe(true)
    expect(hasPersonTargets(targets({}, [], {}))).toBe(false)
  })
})

describe('keepsRole: the rung that says no, cheapest first', () => {
  const t = targets({ functions: ['engineering'], seniority: ['senior'], countries: ['US'], excludedKeywords: ['crypto'] })

  it('keeps a role inside every stated target', () => {
    expect(keepsRole(role(), t)).toEqual({ keep: true, hidden: false })
  })

  it('keeps everything when nothing is stated', () => {
    expect(keepsRole(role({ job_function: 'other', country: null, is_remote: null }), targets())).toEqual({ keep: true, hidden: false })
    expect(keepsRole(role({ job_function: 'marketing', postedAt: null }), targets())).toEqual({ keep: true, hidden: false })
  })

  it('says place for a country, a language or a remote-only wish the role does not meet', () => {
    expect(keepsRole(role({ country: 'DE' }), t)).toEqual({ keep: false, reason: 'place' })
    expect(keepsRole(role({ language: 'de' }), targets({ languages: ['en'] }))).toEqual({ keep: false, reason: 'place' })
    expect(keepsRole(role({ is_remote: false }), targets({ remoteOnly: true }))).toEqual({ keep: false, reason: 'place' })
  })

  it('says age for a posting older than 180 days, and never for an undated one', () => {
    expect(keepsRole(role({ postedAt: ago(200) }), t)).toEqual({ keep: false, reason: 'age' })
    expect(keepsRole(role({ postedAt: null }), t)).toMatchObject({ keep: true })
  })

  it('says excluded for an excluded word in the title or in the description, and for an excluded company', () => {
    expect(keepsRole(role({ title: 'Platform Engineer, Crypto' }), t)).toEqual({ keep: false, reason: 'excluded' })
    expect(keepsRole(role({ description: 'We build crypto rails.' }), t)).toEqual({ keep: false, reason: 'excluded' })
    expect(keepsRole(role({ description: 'We build rails.' }), t)).toMatchObject({ keep: true })
    expect(keepsRole(role({ company: 'Acme Robotics' }), targets({ excludedCompanies: ['acme'] }))).toEqual({ keep: false, reason: 'excluded' })
    expect(keepsRole(role({ company: 'Globex' }), targets({ excludedCompanies: ['acme'] }))).toMatchObject({ keep: true })
  })

  it('says level for a level that is not theirs, and reads an unmarked title as an ordinary role for junior, mid and senior', () => {
    expect(keepsRole(role({ seniority: 'junior' }), t)).toEqual({ keep: false, reason: 'level' })
    expect(keepsRole(role({ seniority: 'unknown' }), t)).toEqual({ keep: true, hidden: false })
    expect(keepsRole(role({ seniority: null }), targets({ seniority: ['director'] }))).toEqual({ keep: true, hidden: true })
  })

  it('says dealbreaker for each stated dealbreaker the posting breaks', () => {
    const sponsor = targets({}, [], { needsSponsorship: true })
    expect(keepsRole(role({ description: 'We cannot provide visa sponsorship.' }), sponsor)).toEqual({ keep: false, reason: 'dealbreaker' })
    expect(keepsRole(role({ description: 'We sponsor visas.' }), sponsor)).toMatchObject({ keep: true })

    const floor = targets({}, [], { salaryFloorUsd: 150_000 })
    expect(keepsRole(role({ salary_range: '$100,000 - $120,000' }), floor)).toEqual({ keep: false, reason: 'dealbreaker' })
    expect(keepsRole(role({ salary_range: '$160,000 - $200,000' }), floor)).toMatchObject({ keep: true })
    expect(keepsRole(role({ salary_range: null }), floor)).toMatchObject({ keep: true })

    const cities = targets({}, [], { onsiteCities: ['seattle'] })
    expect(keepsRole(role({ location: 'Austin, TX' }), cities)).toEqual({ keep: false, reason: 'dealbreaker' })
    expect(keepsRole(role({ location: 'Seattle, WA' }), cities)).toMatchObject({ keep: true })

    expect(keepsRole(role({ seniority: 'intern', title: 'Software Engineering Intern' }), targets({}, [], { refusedSeniority: ['intern'] }))).toEqual({ keep: false, reason: 'dealbreaker' })
    expect(keepsRole(role({ title: 'Data Intern' }), targets({}, [], { excludedTitleWords: ['intern'] }))).toEqual({ keep: false, reason: 'dealbreaker' })
    expect(keepsRole(role({ title: 'Internal Tools Engineer' }), targets({}, [], { excludedTitleWords: ['intern'] }))).toMatchObject({ keep: true })
  })

  it('says type for another function, or for a title that matches none of their typed titles (the title-word filter, while role_types_live is off)', () => {
    expect(keepsRole(role({ job_function: 'sales', title: 'Account Executive' }), t)).toEqual({ keep: false, reason: 'type' })
    expect(keepsRole(role({ job_function: 'marketing', title: 'Brand Manager' }), targets({}, ['Backend Engineer']))).toEqual({ keep: false, reason: 'type' })
  })

  it('keeps an unconventional title in a function they target, as the title gate always did', () => {
    expect(keepsRole(role({ title: 'Member of Technical Staff', job_function: 'engineering' }), targets({}, ['AI Engineer']))).toMatchObject({ keep: true })
  })

  it('keeps a role hidden when nothing disagrees but a dimension could not be read', () => {
    expect(keepsRole(role({ country: null }), t)).toEqual({ keep: true, hidden: true })
    expect(keepsRole(role({ job_function: 'other' }), t)).toEqual({ keep: true, hidden: true })
    expect(keepsRole(role({ is_remote: null }), targets({ remoteOnly: true }))).toEqual({ keep: true, hidden: true })
  })

  it('names the earliest rung when a role fails several, in the order place, age, excluded, level, dealbreaker, type', () => {
    const all = targets({ functions: ['engineering'], seniority: ['senior'], countries: ['US'], excludedKeywords: ['crypto'] }, [], { needsSponsorship: true })
    const fails = (over: Partial<RoleToKeep>) => keepsRole(role(over), all)
    const worst: Partial<RoleToKeep> = {
      country: 'DE',
      postedAt: ago(200),
      title: 'Sales Crypto Lead',
      seniority: 'junior',
      description: 'No visa sponsorship.',
      job_function: 'sales',
    }
    // each step names the earliest rung that still fails, then removes that rung's cause
    const rungs: [string, (o: Partial<RoleToKeep>) => Partial<RoleToKeep>][] = [
      ['place', ({ country: _c, ...o }) => o],
      ['age', ({ postedAt: _p, ...o }) => o],
      ['excluded', (o) => ({ ...o, title: 'Sales Lead' })],
      ['level', ({ seniority: _s, ...o }) => o],
      ['dealbreaker', ({ description: _d, ...o }) => o],
      ['type', (o) => ({ ...o, job_function: 'engineering' })],
    ]
    let over = worst
    for (const [reason, fix] of rungs) {
      expect(fails(over)).toEqual({ keep: false, reason })
      over = fix(over)
    }
    expect(fails(over)).toMatchObject({ keep: true })
  })
})

describe('keepsRole: the type rung once role_types_live is on', () => {
  const step = (over: Partial<TypeStep> = {}): TypeStep => ({ chosen: ['ai-engineer'], synonyms: {}, words: new Set(['engineer']), live: true, ...over })
  const typed = (title: string, over: Partial<RoleToKeep> = {}): RoleToKeep => ({ ...role({ title, ...over }), ...typeTitle(title) })
  const withStep = (s: TypeStep): PersonTargets => ({ targeting: EMPTY_TARGETING, titles: [], typeStep: s })

  it('keeps a role of a chosen type, says type for another type', () => {
    expect(keepsRole(typed('AI Engineer'), withStep(step()))).toEqual({ keep: true, hidden: false })
    expect(keepsRole(typed('Account Executive'), withStep(step()))).toEqual({ keep: false, reason: 'type' })
  })

  it("lets the person's own word for a title decide", () => {
    const r = typed('Account Executive')
    expect(keepsRole(r, withStep(step({ synonyms: { [r.title_norm!]: 'ai-engineer' } })))).toEqual({ keep: true, hidden: false })
  })

  it('says untyped for a title no tier could type, keeps it hidden when it shares a word with a chosen type', () => {
    expect(keepsRole({ ...role({ title: 'Wizard' }), title_norm: 'wizard', role_type: null }, withStep(step()))).toEqual({ keep: false, reason: 'untyped' })
    expect(keepsRole({ ...role({ title: 'Founding Engineer' }), title_norm: 'founding engineer', role_type: null }, withStep(step()))).toEqual({ keep: true, hidden: true })
  })

  it('decides nothing when the switch is off: the title-word filter still decides', () => {
    expect(keepsRole(typed('Account Executive', { job_function: 'sales' }), withStep(step({ live: false })))).toEqual({ keep: true, hidden: false })
  })
})

function facts(p: Partial<RoleFacts> = {}): RoleFacts {
  return { id: 'j1', title: 'Backend Engineer', company: 'Acme', location: 'Seattle, WA', description: 'Build services.', ...p }
}

describe('blockReasons: the dealbreakers', () => {
  it('keeps a role when nothing is stated', () => {
    expect(blockReasons(facts(), NO_CONSTRAINTS)).toEqual([])
  })

  it('blocks a ruled out company by whole name, with the reason', () => {
    const c = { ...NO_CONSTRAINTS, excludedCompanies: ['coinbase'] }
    expect(blockReasons(facts({ company: 'Coinbase' }), c)[0]).toEqual({ kind: 'company', text: 'You ruled out Coinbase.' })
    expect(blockReasons(facts({ company: 'Coinbase Custody Labs' }), c)).toHaveLength(1)
    expect(blockReasons(facts({ company: 'Bluecoin' }), c)).toEqual([])
  })

  it('blocks a country they cannot work in', () => {
    const c = { ...NO_CONSTRAINTS, blockedCountries: ['IN'] }
    const r = blockReasons(facts({ location: 'Bangalore, India' }), c)
    expect(r).toHaveLength(1)
    expect(r[0].text).toBe('It is based in India, and you said you cannot work there.')
  })

  it('applies only-these-countries when the location is known and passes when it is not', () => {
    const c = { ...NO_CONSTRAINTS, onlyCountries: ['US'] }
    expect(blockReasons(facts({ location: 'London, UK' }), c)[0].kind).toBe('location')
    expect(blockReasons(facts({ location: 'Remote' }), c)).toEqual([])
    expect(blockReasons(facts({ location: null }), c)).toEqual([])
  })

  it('applies remote-only to roles listed with an office, not to unlisted ones', () => {
    const c = { ...NO_CONSTRAINTS, remoteOnly: true }
    expect(blockReasons(facts({ location: 'Austin, TX' }), c)[0].kind).toBe('remote')
    expect(blockReasons(facts({ location: 'Remote - US' }), c)).toEqual([])
    expect(blockReasons(facts({ location: '' }), c)).toEqual([])
  })

  it('limits on-site work to the cities they named but lets remote and hybrid listings through', () => {
    const c = { ...NO_CONSTRAINTS, onsiteCities: ['seattle'] }
    expect(blockReasons(facts({ location: 'Seattle, WA' }), c)).toEqual([])
    expect(blockReasons(facts({ location: 'Remote - US' }), c)).toEqual([])
    expect(blockReasons(facts({ location: 'Hybrid (Multiple locations)' }), c)).toEqual([])
    expect(blockReasons(facts({ location: 'Austin, TX' }), c)[0].text).toMatch(/on site in Austin, TX/)
  })

  it('blocks on sponsorship only when needed and the posting refuses', () => {
    const d = 'Great team. We are unable to sponsor work visas. Apply now.'
    const need = { ...NO_CONSTRAINTS, needsSponsorship: true }
    expect(blockReasons(facts({ description: d }), need)[0].kind).toBe('sponsorship')
    expect(blockReasons(facts({ description: d }), NO_CONSTRAINTS)).toEqual([])
    expect(blockReasons(facts({ description: 'We sponsor visas.' }), need)).toEqual([])
  })

  it('applies a salary floor only to a stated range whose top is below it', () => {
    const c = { ...NO_CONSTRAINTS, salaryFloorUsd: 190000 }
    expect(blockReasons(facts({ salaryRange: '$120,000 - $160,000' }), c)[0].kind).toBe('salary')
    expect(blockReasons(facts({ salaryRange: '$150,000 - $210,000' }), c)).toEqual([])
    expect(blockReasons(facts({ salaryRange: null }), c)).toEqual([])
    const fromText = facts({ description: 'Compensation: The base pay range for this role is $100,000 - $140,000 per year.' })
    expect(blockReasons(fromText, c)[0].kind).toBe('salary')
    expect(blockReasons(facts({ description: 'We raised $200 million last year.' }), c)).toEqual([])
  })

  it.each([
    'Our annual company retreat is on us, and there is a $15,000 learning stipend.',
    'Competitive salary plus annual bonus up to $12,000.',
    'Compensation: competitive, with a $50,000 sign-on bonus.',
    'We offer an annual relocation allowance of $20,000.',
    'Annual equity refresh of $20,000 - $30,000 in stock.',
    'Compensation: a $10,000 - $12,000 signing bonus.',
  ])('keeps a role whose posting states no salary: %s', (description) => {
    const c = { ...NO_CONSTRAINTS, salaryFloorUsd: 150000 }
    expect(blockReasons(facts({ description }), c)).toEqual([])
    expect(keepsRole(role({ description }), targets({}, [], c))).toMatchObject({ keep: true })
  })

  it('keeps a monthly, weekly or daily figure, which is not a yearly salary', () => {
    const c = { ...NO_CONSTRAINTS, salaryFloorUsd: 100000 }
    for (const salaryRange of ['$15k - $20k per month', '$3,000 - $4,000 a week', '$500 - $700 per day', '$9,000 - $12,000 monthly']) {
      expect(blockReasons(facts({ salaryRange }), c)).toEqual([])
    }
  })

  it('still blocks a stated yearly range below the floor, in the field or in a pay paragraph', () => {
    const c = { ...NO_CONSTRAINTS, salaryFloorUsd: 150000 }
    expect(blockReasons(facts({ salaryRange: '$90k to $120k' }), c)[0].kind).toBe('salary')
    expect(blockReasons(facts({ description: 'The salary range for this role is $90,000 - $120,000 plus equity.' }), c)[0].kind).toBe('salary')
  })

  it('refuses a level they will not take, from the title', () => {
    const c = { ...NO_CONSTRAINTS, refusedSeniority: ['intern', 'manager'] }
    expect(blockReasons(facts({ title: 'Software Engineering Intern' }), c)[0].kind).toBe('seniority')
    expect(blockReasons(facts({ title: 'Engineering Manager' }), c)[0].kind).toBe('seniority')
    expect(blockReasons(facts({ title: 'Senior Software Engineer' }), c)).toEqual([])
  })

  it('matches excluded title words as whole words', () => {
    const c = { ...NO_CONSTRAINTS, excludedTitleWords: ['intern'] }
    expect(blockReasons(facts({ title: 'Data Intern' }), c)[0].kind).toBe('keyword')
    expect(blockReasons(facts({ title: 'Internal Tools Engineer' }), c)).toEqual([])
  })

  it('reports every broken constraint, not just the first', () => {
    const c = { ...NO_CONSTRAINTS, excludedCompanies: ['acme'], blockedCountries: ['IN'] }
    expect(blockReasons(facts({ location: 'Pune, India' }), c).map((r) => r.kind).sort()).toEqual(['company', 'location'])
  })
})
