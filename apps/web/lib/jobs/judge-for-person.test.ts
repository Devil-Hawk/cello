import { describe, expect, it } from 'vitest'
import { EMPTY_TARGETING } from '../targeting'
import { hasPersonTargets, judgeForPerson } from './target-relevance'

const day = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * day).toISOString()

const role = (over: Record<string, unknown> = {}) => ({
  title: 'Platform Engineer',
  job_function: 'engineering',
  seniority: 'senior',
  country: 'US',
  language: 'en',
  is_remote: null,
  postedAt: ago(3),
  ...over,
})

const targets = (over: Record<string, unknown> = {}, titles: string[] = []) => ({ targeting: { ...EMPTY_TARGETING, ...over }, titles })

describe('hasPersonTargets', () => {
  it('is false with nothing stated, true with a function, a place, an exclusion or a typed title', () => {
    expect(hasPersonTargets(targets())).toBe(false)
    expect(hasPersonTargets(targets({ functions: ['engineering'] }))).toBe(true)
    expect(hasPersonTargets(targets({ countries: ['US'] }))).toBe(true)
    expect(hasPersonTargets(targets({ excludedKeywords: ['crypto'] }))).toBe(true)
    expect(hasPersonTargets(targets({}, ['Backend Engineer']))).toBe(true)
    expect(hasPersonTargets(targets({}, ['  ']))).toBe(false)
  })
})

describe('judgeForPerson: the stage that says no, cheapest first', () => {
  const t = targets({ functions: ['engineering'], seniority: ['senior'], countries: ['US'], excludedKeywords: ['crypto'] })

  it('keeps a role inside every stated target', () => {
    expect(judgeForPerson(role(), t)).toEqual({ keep: true, hidden: false })
  })

  it('says place for a country that is not theirs', () => {
    expect(judgeForPerson(role({ country: 'DE' }), t)).toEqual({ keep: false, reason: 'place' })
  })

  it('says place before anything else, so a role that fails two stages is counted once, at the first', () => {
    expect(judgeForPerson(role({ country: 'DE', seniority: 'junior', job_function: 'sales' }), t)).toEqual({ keep: false, reason: 'place' })
  })

  it('says age for a posting older than 180 days', () => {
    expect(judgeForPerson(role({ postedAt: ago(200) }), t)).toEqual({ keep: false, reason: 'age' })
  })

  it('says excluded for an excluded word', () => {
    expect(judgeForPerson(role({ title: 'Platform Engineer, Crypto' }), t)).toEqual({ keep: false, reason: 'excluded' })
    expect(judgeForPerson(role(), targets({ excludedCompanies: ['acme'] }), 'Acme Robotics')).toEqual({ keep: false, reason: 'excluded' })
  })

  it('says level for a level that is not theirs', () => {
    expect(judgeForPerson(role({ seniority: 'junior' }), t)).toEqual({ keep: false, reason: 'level' })
  })

  it('says title for another function, or for a title that matches none of their typed titles', () => {
    expect(judgeForPerson(role({ job_function: 'sales', title: 'Account Executive' }), t)).toEqual({ keep: false, reason: 'title' })
    expect(judgeForPerson(role({ job_function: 'marketing', title: 'Brand Manager' }), targets({}, ['Backend Engineer']))).toEqual({ keep: false, reason: 'title' })
  })

  it('keeps an unconventional title in a function they target, as the title gate always did', () => {
    expect(judgeForPerson(role({ title: 'Member of Technical Staff', job_function: 'engineering' }), targets({}, ['AI Engineer']))).toMatchObject({ keep: true })
  })

  it('keeps a role hidden when nothing disagrees but a dimension could not be read', () => {
    expect(judgeForPerson(role({ country: null }), t)).toEqual({ keep: true, hidden: true })
    expect(judgeForPerson(role({ job_function: 'other' }), t)).toEqual({ keep: true, hidden: true })
  })
})
