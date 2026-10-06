import { describe, expect, it } from 'vitest'
import { EMPTY_TARGETING } from '../targeting'
import type { JobLead } from '../sources/types'
import type { BoardHit, YcRow } from './types'
import type { LocationPrefs } from './location'
import { buildSuggestions, leadCompanies, roleMatcher, type SuggestionInputs } from './suggestions'

const NOW = new Date('2026-10-05T12:00:00Z')
const US: LocationPrefs = { countries: ['US'], remoteOnly: false, remoteAllowed: true, cities: [] }

function inputs(over: Partial<SuggestionInputs> = {}): SuggestionInputs {
  return {
    targets: ['Backend Engineer'],
    targeting: { ...EMPTY_TARGETING, countries: ['US'] },
    keywords: [],
    prefs: US,
    watched: [],
    excludedNames: [],
    actedKeys: [],
    liked: [],
    ...over,
  }
}

function lead(over: Partial<JobLead>): JobLead {
  return {
    company: 'Acme',
    title: 'Senior Backend Engineer',
    url: 'https://remotive.com/jobs/1',
    location: 'Remote, USA',
    salary: null,
    description: '',
    source: 'remotive',
    externalId: 'https://remotive.com/jobs/1',
    companyDomain: 'acme.com',
    postedAt: '2026-10-03T00:00:00Z',
    tags: [],
    ...over,
  }
}

function dir(over: Partial<YcRow>): YcRow {
  return {
    name: 'X', name_key: 'x', domain: 'x.com', source: 'yc', profile_url: 'https://www.ycombinator.com/companies/x',
    tags: [], regions: ['United States of America'], locations: 'San Francisco, CA, USA', ...over,
  }
}

function board(over: Partial<BoardHit> & { titles?: string[] }): BoardHit {
  const jobs = (over.titles ?? ['Backend Engineer']).map((title, i) => ({
    title, location: 'Remote, USA', url: `https://boards.greenhouse.io/x/jobs/${i}`, postedAt: '2026-10-04T00:00:00Z',
  }))
  return { provider: 'greenhouse', token: 'x', boardUrl: 'https://boards.greenhouse.io/x', openRoles: 14, jobs, ...over }
}

// 100 YC rows so tag frequencies mean something: "fintech" 10%, "payments" 2%, "b2b" 40% (generic).
function ycDirectory(extra: YcRow[] = []): YcRow[] {
  const rows: YcRow[] = []
  for (let i = 0; i < 100; i++) {
    const tags: string[] = []
    if (i < 40) tags.push('B2B')
    if (i < 10) tags.push('Fintech')
    if (i < 2) tags.push('Payments')
    rows.push(dir({ name: `Filler ${i}`, name_key: `filler ${i}`, domain: `filler${i}.com`, tags, profile_url: null }))
  }
  return [...rows, ...extra]
}

const run = (i: SuggestionInputs, leads: JobLead[], d: YcRow[] = [], boards = new Map<string, BoardHit>()) => buildSuggestions(i, leads, d, boards, NOW)

describe('roleMatcher', () => {
  it('uses target titles first, then functions, then resume keywords on the title, else null', () => {
    const byTitle = roleMatcher(inputs())!
    expect(byTitle({ title: 'Staff Backend Engineer' })).toMatchObject({ matched: true, label: 'Backend Engineer' })
    expect(byTitle({ title: 'Account Executive' }).matched).toBe(false)

    const byFn = roleMatcher(inputs({ targets: [], targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } }))!
    expect(byFn({ title: 'Senior Software Engineer' }).matched).toBe(true)
    expect(byFn({ title: 'Sales Director' }).matched).toBe(false)

    const byKw = roleMatcher(inputs({ targets: [], keywords: ['kubernetes', 'go'] }))!
    expect(byKw({ title: 'Kubernetes Platform Lead' })).toMatchObject({ matched: true, label: 'kubernetes' })
    expect(byKw({ title: 'Chicago Office Manager' }).matched).toBe(false) // "go" is not inside "Chicago"

    expect(roleMatcher(inputs({ targets: [], keywords: [] }))).toBeNull()
  })

  it('needs every core word of a target in the title: a Design Engineer is not a Backend Engineer', () => {
    const m = roleMatcher(inputs({ targets: ['Backend Engineer', 'Platform Engineer', 'Software Engineer Infrastructure'] }))!
    const yes = ['Senior Backend Engineer', 'Backend Developer', 'Staff Platform Engineer', 'Senior Backend Engineer, Payments', 'Software Engineer, Infrastructure', 'Sr. Backend Engineering']
    const no = ['Senior Mobile Engineer, Kotlin and Cross-Platform', 'Android Engineer, Terminal OS Platform', 'Forward Deployed Engineer - Physical AI Cloud Platform', 'Design Engineer', 'Support Engineer (AMER)', 'Analytics Engineer, Data', 'Finance Engineer', 'Customer Solution Engineer', 'Senior Sales Engineer', 'Platform Engineering Manager', 'Director of Backend Engineering', 'CPU Pre-Silicon Engineering Program Manager', 'Senior Software Engineer', 'Senior Product Designer']
    for (const t of yes) expect(m({ title: t }).matched, t).toBe(true)
    for (const t of no) expect(m({ title: t }).matched, t).toBe(false)
  })

  it('lets a person who targets a manager role match manager titles', () => {
    const m = roleMatcher(inputs({ targets: ['Engineering Manager'] }))!
    expect(m({ title: 'Senior Engineering Manager, Platform' }).matched).toBe(true)
    expect(m({ title: 'Senior Software Engineer' }).matched).toBe(false)
  })

  it('gives null, not a guess, when the person has no role signal', () => {
    expect(run(inputs({ targets: [] }), [lead({})])).toBeNull()
  })
})

describe('leadCompanies', () => {
  it('lists every company the aggregators show hiring that is not ruled out, once each, with its identity key', () => {
    const out = leadCompanies(
      inputs({ watched: [{ name: 'Stripe', domain: 'stripe.com' }], excludedNames: ['evil'] }),
      [
        lead({ company: 'Acme', companyDomain: 'acme.com' }),
        lead({ company: 'Acme', companyDomain: 'acme.com', externalId: 'x2' }),
        lead({ company: 'Marketing Wizards', title: 'Head of Growth', companyDomain: null, externalId: 'x3' }),
        lead({ company: 'Stripe', companyDomain: 'stripe.com', externalId: 'x4' }),
        lead({ company: 'Evil Corp', companyDomain: 'evil.com', externalId: 'x5' }),
        lead({ company: 'Yc Co', source: 'ycombinator', externalId: 'x6' }),
      ],
      []
    )
    expect(out).toEqual([
      { key: 'acme.com', name: 'Acme', domain: 'acme.com' },
      { key: 'name:marketing wizards', name: 'Marketing Wizards', domain: null },
    ])
  })

  it('lets a company with no matching posting reach tier 1 through its own board', () => {
    const hit = board({ titles: ['Backend Engineer'] })
    const out = run(inputs(), [lead({ company: 'Quiet Co', companyDomain: 'quiet.com', title: 'Office Manager' })], [], new Map([['quiet.com', hit]]))!
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'Quiet Co', tier: 1, ats: { matchingRoles: 1 } })
  })
})

describe('tiers', () => {
  it('orders T1 (live board) over T2 (two postings) over T3 (one posting) over T4 (similar to a liked company)', () => {
    const d = ycDirectory([
      dir({ name: 'Tiny Pay', name_key: 'tiny pay', domain: 'tiny.com', tags: ['Fintech', 'Payments'], profile_url: 'https://www.ycombinator.com/companies/tiny-pay' }),
      dir({ name: 'BoardCo', name_key: 'boardco', domain: 'boardco.com', tags: [], profile_url: null }),
    ])
    const leads = [
      lead({ company: 'Two Posts', companyDomain: 'twoposts.com', url: 'https://remotive.com/a', externalId: 'a' }),
      lead({ company: 'Two Posts', companyDomain: 'twoposts.com', url: 'https://jobicy.com/b', externalId: 'b', source: 'jobicy', title: 'Backend Engineer' }),
      lead({ company: 'One Post', companyDomain: 'onepost.com', url: 'https://remotive.com/c', externalId: 'c' }),
      lead({ company: 'BoardCo', companyDomain: 'boardco.com', url: 'https://remotive.com/d', externalId: 'd' }),
    ]
    const boards = new Map([['boardco.com', board({ titles: ['Backend Engineer', 'Designer'] })]])
    const out = run(inputs({ liked: [{ name: 'Stripe', domain: 'stripe.com', tags: ['fintech', 'payments'] }] }), leads, d, boards)!
    expect(out.map((s) => [s.name, s.tier])).toEqual([['BoardCo', 1], ['Two Posts', 2], ['One Post', 3], ['Tiny Pay', 4]])
    expect(out.map((s) => s.rank)).toEqual([1, 2, 3, 4])
  })

  it('breaks ties in a tier by matching count, then newest posting', () => {
    const leads = [
      lead({ company: 'Older', companyDomain: 'older.com', postedAt: '2026-09-20T00:00:00Z', externalId: 'o' }),
      lead({ company: 'Newer', companyDomain: 'newer.com', postedAt: '2026-10-04T00:00:00Z', externalId: 'n' }),
      lead({ company: 'Most', companyDomain: 'most.com', externalId: 'm1', postedAt: '2026-09-01T00:00:00Z' }),
      lead({ company: 'Most', companyDomain: 'most.com', externalId: 'm2', url: 'https://jobicy.com/m2', source: 'jobicy' }),
    ]
    expect(run(inputs(), leads)!.map((s) => s.name)).toEqual(['Most', 'Newer', 'Older'])
  })

  it('does not count a stale posting as hiring now', () => {
    expect(run(inputs(), [lead({ postedAt: '2026-06-01T00:00:00Z' })])).toEqual([])
  })
})

describe('exclusions', () => {
  const leads = [
    lead({ company: 'Stripe', companyDomain: 'stripe.com', externalId: '1' }),
    lead({ company: 'Plaid Inc.', companyDomain: null, externalId: '2' }),
    lead({ company: 'Evil Corp', companyDomain: 'evil.com', externalId: '3' }),
    lead({ company: 'Hidden Co', companyDomain: 'hidden.com', externalId: '4' }),
    lead({ company: 'Good Co', companyDomain: 'good.com', externalId: '5' }),
  ]

  it('drops watched companies by domain and by name, disliked names, and companies already acted on', () => {
    const out = run(
      inputs({
        watched: [{ name: 'Stripe Payments', domain: 'www.stripe.com' }, { name: 'Plaid', domain: null }],
        excludedNames: ['evil'],
        actedKeys: ['hidden.com'],
      }),
      leads
    )!
    expect(out.map((s) => s.name)).toEqual(['Good Co'])
  })

  it('never suggests a disliked company through any signal (board or similarity)', () => {
    const d = ycDirectory([dir({ name: 'Evil Corp', name_key: 'evil corp', domain: 'evil.com', tags: ['Fintech', 'Payments'] })])
    const out = run(
      inputs({ excludedNames: ['evil'], liked: [{ name: 'Stripe', domain: null, tags: ['fintech', 'payments'] }] }),
      [lead({ company: 'Evil Corp', companyDomain: 'evil.com' })],
      d,
      new Map([['evil.com', board({})]])
    )!
    expect(out).toEqual([])
  })
})

describe('location is strict', () => {
  it('ignores a matching posting that is outside the person\'s countries or has no readable location', () => {
    const out = run(
      inputs(),
      [
        lead({ company: 'Berlin Co', companyDomain: 'berlin.com', location: 'Berlin, Germany', externalId: '1' }),
        lead({ company: 'Europe Co', companyDomain: 'europe.com', location: 'Remote - Europe', externalId: '2' }),
        lead({ company: 'Unknown Co', companyDomain: 'unknown.com', location: null, externalId: '3' }),
        lead({ company: 'NYC Co', companyDomain: 'nyc.com', location: 'New York, NY', externalId: '4' }),
      ]
    )!
    expect(out.map((s) => s.name)).toEqual(['NYC Co'])
  })

  it('counts only board roles that sit in scope', () => {
    const hit = board({ titles: ['Backend Engineer'] })
    hit.jobs[0].location = 'London, UK'
    const d = [dir({ name: 'BoardCo', name_key: 'boardco', domain: 'boardco.com' })]
    const out = run(inputs(), [lead({ company: 'BoardCo', companyDomain: 'boardco.com' })], d, new Map([['boardco.com', hit]]))!
    expect(out[0].tier).toBe(3) // the board's only matching role is in London, so only the posting counts
    expect(out[0].ats).toMatchObject({ provider: 'greenhouse', openRoles: 14, matchingRoles: 0 })
  })

  it('applies the location rule to a similar YC company too', () => {
    const d = ycDirectory([
      dir({ name: 'UK Pay', name_key: 'uk pay', domain: 'uk.com', tags: ['Fintech', 'Payments'], locations: 'London, England, United Kingdom', regions: ['United Kingdom'] }),
    ])
    const out = run(inputs({ liked: [{ name: 'Stripe', domain: null, tags: ['fintech', 'payments'] }] }), [], d)!
    expect(out).toEqual([])
  })
})

describe('every suggestion is sourced', () => {
  const d = ycDirectory([
    dir({ name: 'Tiny Pay', name_key: 'tiny pay', domain: 'tiny.com', tags: ['Fintech', 'Payments'], profile_url: 'https://www.ycombinator.com/companies/tiny-pay' }),
  ])
  const leads = [
    lead({ company: 'HN Co', companyDomain: 'hn.com', source: 'hackernews', url: 'https://hn.com/apply', externalId: 'https://news.ycombinator.com/item?id=4242', title: 'Backend Engineer', location: 'Remote (US)' }),
    lead({ company: 'Posted Co', companyDomain: 'posted.com' }),
  ]
  const out = run(inputs({ liked: [{ name: 'Stripe', domain: null, tags: ['fintech', 'payments'] }] }), leads, d, new Map([['boardco.com', board({})]]))!

  it('has an http(s) source URL and a label on every row, and at most 160 characters with no em dash in the reason', () => {
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const s of out) {
      expect(s.sourceUrl).toMatch(/^https?:\/\//)
      expect(s.sourceLabel.length).toBeGreaterThan(0)
      expect(s.sourceLabel.length).toBeLessThanOrEqual(60)
      expect(s.reason.length).toBeLessThanOrEqual(160)
      expect(s.reason).not.toContain('\u2014')
      expect(s.signals.length).toBeGreaterThan(0)
    }
  })

  it('uses the HN thread comment, not the apply link', () => {
    const hn = out.find((s) => s.name === 'HN Co')!
    expect(hn.sourceUrl).toBe('https://news.ycombinator.com/item?id=4242')
    expect(hn.sourceLabel).toBe('HN Who is hiring')
    expect(hn.signals[0]).toMatchObject({ kind: 'thread', url: 'https://news.ycombinator.com/item?id=4242' })
  })

  it('labels an aggregator posting with its source name', () => {
    const posted = out.find((s) => s.name === 'Posted Co')!
    expect(posted.sourceLabel).toBe('Remotive posting')
    expect(posted.reason).toContain('Remotive')
  })

  it('names the provider and the counts for a board', () => {
    const d2 = [dir({ name: 'BoardCo', name_key: 'boardco', domain: 'boardco.com' })]
    const hit = board({ titles: ['Backend Engineer', 'Staff Backend Engineer', 'Designer'] })
    const [s] = run(inputs(), [lead({ company: 'BoardCo', companyDomain: 'boardco.com' })], d2, new Map([['boardco.com', hit]]))!
    expect(s).toMatchObject({ tier: 1, sourceUrl: 'https://boards.greenhouse.io/x', sourceLabel: 'Greenhouse board' })
    expect(s.reason).toContain('Greenhouse')
    expect(s.reason).toContain('2 open roles')
    expect(s.ats).toEqual({ provider: 'greenhouse', openRoles: 14, matchingRoles: 2 })
  })

  it('names the liked company and the shared tags for a similar company, linking its YC profile', () => {
    const tiny = out.find((s) => s.name === 'Tiny Pay')!
    expect(tiny).toMatchObject({ tier: 4, sourceLabel: 'YC profile', sourceUrl: 'https://www.ycombinator.com/companies/tiny-pay' })
    expect(tiny.reason).toContain('Stripe')
    expect(tiny.reason).toMatch(/payments/i)
    expect(tiny.signals[0]).toMatchObject({ kind: 'similar', liked: 'Stripe' })
  })

  it('does not suggest a company that shares only a generic tag with a liked one', () => {
    const generic = ycDirectory([dir({ name: 'Generic Co', name_key: 'generic co', domain: 'gen.com', tags: ['B2B'] })])
    expect(run(inputs({ liked: [{ name: 'Stripe', domain: null, tags: ['b2b'] }] }), [], generic)).toEqual([])
  })

  it('caps the list at 30', () => {
    const many = Array.from({ length: 45 }, (_, i) => lead({ company: `Co ${i}`, companyDomain: `co${i}.com`, externalId: `e${i}` }))
    expect(run(inputs(), many)!).toHaveLength(30)
  })
})
