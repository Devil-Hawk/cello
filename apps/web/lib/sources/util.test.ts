import { describe, expect, it } from 'vitest'
import { compileKeyword, relevanceScore } from './util'
import type { JobLead } from './types'

function lead(overrides: Partial<JobLead> = {}): JobLead {
  return {
    company: 'Acme',
    title: '',
    url: 'https://acme.example/jobs/1',
    location: null,
    salary: null,
    description: '',
    source: 'themuse',
    externalId: 'acme-1',
    tags: [],
    ...overrides,
  }
}

describe('compileKeyword — word-boundary port of career-ops scan.mjs compileKeyword', () => {
  it('a 2-3 letter all-alpha keyword matches only as a whole word', () => {
    const matches = compileKeyword('ml')
    expect(matches('ml engineer')).toBe(true)
    expect(matches('senior ml engineer')).toBe(true)
    // The exact case from the task: "ML" must NOT match inside "HTML5".
    expect(matches('html5 developer')).toBe(false)
  })

  it('"ai" does not match inside unrelated words', () => {
    const matches = compileKeyword('ai')
    expect(matches('ai engineer')).toBe(true)
    expect(matches('head of ai')).toBe(true)
    expect(matches('facilities chair')).toBe(false)
    expect(matches('captain of the team')).toBe(false)
    expect(matches('detail oriented')).toBe(false)
  })

  it('"go" does not match inside "chicago"/"mango"/"algorithm"', () => {
    const matches = compileKeyword('go')
    expect(matches('go developer')).toBe(true)
    expect(matches('golang engineer')).toBe(false) // "go" is a prefix, not a whole word
    expect(matches('based in chicago')).toBe(false)
    expect(matches('mango studios')).toBe(false)
    expect(matches('algorithm engineer')).toBe(false)
  })

  it('a longer keyword keeps substring matching', () => {
    const matches = compileKeyword('engineer')
    expect(matches('senior engineering manager')).toBe(true) // substring of "engineering"
  })

  it('a keyword containing non-letters keeps substring matching (word-boundary would break on punctuation)', () => {
    const dotnet = compileKeyword('.net')
    expect(dotnet('experience with .net required')).toBe(true)
    const cplusplus = compileKeyword('c++')
    expect(cplusplus('c++ developer wanted')).toBe(true)
  })

  it('a 4+ letter all-alpha keyword is NOT boundary-restricted (only 2-3 letter acronyms are)', () => {
    // "lead" substring-matches inside "leadership" — this is the documented
    // tradeoff: only short acronyms get the stricter \b treatment.
    const matches = compileKeyword('lead')
    expect(matches('leadership team')).toBe(true)
  })
})

describe('relevanceScore uses compileKeyword for both title and description/tags', () => {
  it('scores a whole-word title match higher than a description-only match', () => {
    const titleHit = lead({ title: 'ML Engineer', description: 'Build things.' })
    const descOnlyHit = lead({ title: 'Software Engineer', description: 'Some ML exposure a plus.' })
    expect(relevanceScore(titleHit, ['ml'])).toBeGreaterThan(relevanceScore(descOnlyHit, ['ml']))
  })

  it('does not award any score for "ML" against an "HTML5" title', () => {
    const html5 = lead({ title: 'HTML5 Developer', description: 'Frontend work.' })
    expect(relevanceScore(html5, ['ml'])).toBe(0)
  })

  it('returns 0 for an empty keyword list', () => {
    expect(relevanceScore(lead({ title: 'Anything' }), [])).toBe(0)
  })
})
