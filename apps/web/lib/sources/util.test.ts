import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compileKeyword, employerDomainFromUrl, relevanceScore } from './util'
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

// ---------------------------------------------------------------------------
// Regression: an adapter host missing from NON_EMPLOYER_HOSTS silently poisons
// the companies table.
//
// employerDomainFromUrl() decides whether a URL yields an EMPLOYER's domain.
// When an aggregator host is absent it returns that host, and ingestLeads
// stores it as the company's own domain. MEASURED consequence in the live
// table: 190 of 436 companies carry an aggregator domain — "Capital One" with
// themuse.com, "ManTech" with jobicy.com. Those companies can never have their
// ATS detected (detection probes the aggregator), dedupe collapses across
// unrelated employers, and email inference would synthesize addresses at the
// aggregator's domain.
//
// The cause was a hand-maintained list drifting behind a growing adapter
// registry: five adapters shipped after it was last updated. This test reads
// the adapter sources themselves, so the next adapter cannot reintroduce it.
// ---------------------------------------------------------------------------
describe('every source adapter host is treated as a non-employer host', () => {
  const ADAPTER_FILES = [
    'themuse', 'arbeitnow', 'remoteok', 'hackernews', 'ycombinator', 'echojobs',
    'weworkremotely', 'remotive', 'jobicy', 'himalayas', 'workingnomads',
  ]

  it('finds the adapter files (guards against a silently empty scan)', () => {
    expect(ADAPTER_FILES.length).toBeGreaterThan(10)
  })

  it.each(ADAPTER_FILES)('%s: no host it fetches is ever returned as an employer domain', (name) => {
    const src = readFileSync(path.resolve(process.cwd(), `lib/sources/${name}.ts`), 'utf8')

    // Hosts the adapter names in its own allowlist / URLs.
    const hosts = new Set<string>()
    for (const m of src.matchAll(/['"`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"`]/g)) {
      const h = m[1].toLowerCase()
      if (/\.(com|app|io|co|dev|net|org|gg)$/.test(h) && !h.endsWith('.ts')) hosts.add(h)
    }

    const leaked: string[] = []
    for (const h of hosts) {
      // Only judge hosts this adapter actually fetches from, not employer
      // examples that might appear in a comment.
      if (!src.includes(`//${h}`) && !src.includes(`://${h}`) && !src.includes(`'${h}'`)) continue
      if (employerDomainFromUrl(`https://${h}/jobs/some-role`) !== null) leaked.push(h)
    }

    expect(
      leaked,
      `${name}.ts fetches from ${leaked.join(', ')}, but employerDomainFromUrl() returns ` +
        `${leaked.length === 1 ? 'it' : 'them'} as an employer domain. Add to SOURCE_FETCH_HOSTS ` +
        `in lib/sources/util.ts, or every company ingested from this source gets the ` +
        `aggregator's domain stored as its own.`
    ).toEqual([])
  })

  it('rejects the aggregators found poisoning the live table', () => {
    for (const host of [
      'themuse.com', 'jobicy.com', 'himalayas.app', 'arbeitnow.com', 'remoteok.com',
      'weworkremotely.com', 'remotive.com', 'workingnomads.com', 'echojobs.io',
    ]) {
      expect(employerDomainFromUrl(`https://${host}/jobs/x`), host).toBeNull()
      expect(employerDomainFromUrl(`https://www.${host}/jobs/x`), `www.${host}`).toBeNull()
    }
  })

  it('still returns a real employer domain', () => {
    expect(employerDomainFromUrl('https://careers.stripe.com/jobs/123')).toBe('careers.stripe.com')
    expect(employerDomainFromUrl('https://www.loom.com/careers')).toBe('loom.com')
  })
})
