import { describe, expect, it } from 'vitest'
import { CANONICAL_RESUME } from '@/lib/resume/test-fixtures'
import { buildFacts, parseCorrection, yearsOfWork, type FactsInput } from './facts'

const input = (over: Partial<FactsInput> = {}): FactsInput => ({
  fullName: 'Jordan Rivera',
  preferences: {},
  resume: CANONICAL_RESUME,
  resumeLabel: 'Data Platform',
  resumeAt: '2026-10-04T10:00:00Z',
  mail: true,
  model: 'anthropic/claude-sonnet-5',
  emailCount: null,
  now: new Date('2026-10-06T00:00:00Z'),
  ...over,
})
const by = (facts: ReturnType<typeof buildFacts>, key: string) => facts.find((f) => f.key === key)

describe('buildFacts', () => {
  it('shows a model by its name, never its id', () => {
    const model = by(buildFacts(input()), 'model')
    expect(model?.value).toBe('Claude Sonnet 5')
    expect(JSON.stringify(buildFacts(input()))).not.toContain('anthropic/')
  })

  it('gives every fact a source', () => {
    const facts = buildFacts(
      input({
        preferences: {
          targeting: { functions: ['engineering'], seniority: ['senior'] },
          constraints: { onlyCountries: ['US'], onsiteCities: ['seattle'], needsSponsorship: true, salaryFloorUsd: 180000, excludedCompanies: ['acme'] },
        },
        emailCount: 35,
      })
    )
    expect(facts.length).toBeGreaterThanOrEqual(12)
    for (const f of facts) expect(f.source.length, f.key).toBeGreaterThan(0)
  })

  it('says where each value came from', () => {
    const facts = buildFacts(input({ preferences: { targeting: { seniority: ['senior'] } } }))
    expect(by(facts, 'level')?.source).toBe('You set this')
    expect(by(facts, 'headline')?.source).toBe('From your resume, Data Platform')
    expect(by(facts, 'years')?.source).toBe('Counted from your resume, Data Platform')
    expect(by(facts, 'mail')?.source).toBe('From your connections')
  })

  it("reads a model-structured resume as Cello's read, with the day", () => {
    const resume = structuredClone(CANONICAL_RESUME)
    resume.meta.cello.structuredBy = 'llm'
    expect(by(buildFacts(input({ resume })), 'headline')?.source).toBe("Cello's read of your resume, Oct 4")
  })

  it('lets a correction win over the resume and says so', () => {
    const preferences = { facts: { headline: { value: 'Staff Platform Engineer', origin: 'person', prov: { door: 'session' }, at: '2026-10-05T00:00:00Z' } } }
    const headline = by(buildFacts(input({ preferences })), 'headline')
    expect(headline).toMatchObject({ value: 'Staff Platform Engineer', source: 'You corrected this', raw: 'Staff Platform Engineer' })
  })

  it('ignores a stored fact that no person set', () => {
    const preferences = { facts: { headline: { value: 'Injected', origin: 'model' } } }
    expect(by(buildFacts(input({ preferences })), 'headline')?.value).toBe(CANONICAL_RESUME.basics.label)
  })

  it('hides empty values and the email count until it exists', () => {
    const facts = buildFacts(input({ resume: null, fullName: null }))
    for (const key of ['name', 'headline', 'years', 'places', 'payFloor', 'roleTypes', 'leaveOut', 'emailCount']) expect(by(facts, key), key).toBeUndefined()
    expect(by(buildFacts(input({ emailCount: 35 })), 'emailCount')?.value).toBe('35 past applications found in your email')
  })

  it('shows sponsorship as not set until it is stated', () => {
    expect(by(buildFacts(input()), 'sponsorship')).toMatchObject({ value: 'Not set', source: 'Not set yet' })
    expect(by(buildFacts(input({ preferences: { constraints: { needsSponsorship: true } } })), 'sponsorship')).toMatchObject({ value: 'Yes', source: 'You set this' })
  })
})

describe('yearsOfWork', () => {
  it('counts overlapping jobs once and a current job to today', () => {
    const resume = structuredClone(CANONICAL_RESUME)
    resume.work = [
      { ...resume.work[0], startDate: '2018-01', endDate: '2020-01', current: false },
      { ...resume.work[1], startDate: '2019-01', endDate: '2022-01', current: false },
      { ...resume.work[1], startDate: '2024-01', endDate: undefined, current: true },
    ]
    // 2018-01 to 2022-01 is 4 years; 2024-01 to 2026-10 is about 2.75.
    expect(yearsOfWork(resume, new Date('2026-10-06T00:00:00Z'))).toBe(7)
  })

  it('is null with no dated job', () => {
    const resume = structuredClone(CANONICAL_RESUME)
    resume.work = []
    expect(yearsOfWork(resume)).toBeNull()
  })
})

describe('parseCorrection', () => {
  it('turns lists, numbers and yes or no into stored values', () => {
    expect(parseCorrection('onlyCountries', 'list', 'us, ca, us')).toEqual({ ok: true, value: ['US', 'CA'] })
    expect(parseCorrection('salaryFloorUsd', 'number', '180000')).toEqual({ ok: true, value: 180000 })
    expect(parseCorrection('needsSponsorship', 'yesno', 'yes')).toEqual({ ok: true, value: true })
  })

  it('refuses what the field cannot hold', () => {
    expect(parseCorrection('onlyCountries', 'list', 'USA').ok).toBe(false)
    expect(parseCorrection('functions', 'list', 'wizard').ok).toBe(false)
    expect(parseCorrection('seniority', 'list', 'Senior, Staff')).toEqual({ ok: true, value: ['senior', 'staff'] })
    expect(parseCorrection('years', 'number', '61').ok).toBe(false)
    expect(parseCorrection('headline', 'text', 'x'.repeat(201)).ok).toBe(false)
    expect(parseCorrection('headline', 'text', '   ').ok).toBe(false)
  })
})
