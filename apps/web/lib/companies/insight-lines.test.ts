import { describe, expect, it } from 'vitest'
import { insightLines, type InsightsRow } from './insight-lines'

const AT = '2026-10-21T09:00:00.000Z'
const row = (over: Partial<InsightsRow> = {}): InsightsRow => ({
  computed_at: AT, open: 14,
  by_type: [{ roleType: 'software-engineer', open: 6 }, { roleType: 'product-manager', open: 3 }, { roleType: null, open: 5 }],
  by_seniority: { senior: 2, mid: 9, junior: 3, unknown: 0 },
  locations: [{ name: 'New York, New York, USA', count: 5 }, { name: 'Boston, Massachusetts, USA', count: 3 }, { name: 'Paris, France', count: 2 }, { name: 'New York, NY', count: 1 }],
  remote_share: 0.4, posted_7d: 4, posted_30d: 11,
  pay: { stated: 9, min: 140000, max: 240000, currency: 'USD' },
  median_age_days: 18, typical_close_days: 35, closes_seen: 31,
  stack: [{ name: 'Python', count: 11 }, { name: 'Go', count: 6 }, { name: 'Spark', count: 4 }, { name: 'Kubernetes', count: 4 }, { name: 'AWS', count: 2 }],
  ...over,
})
const acme = { name: 'Acme', domain: 'acme.example', careersUrl: 'https://careers.acme.example/jobs', provider: 'greenhouse', profile: null }
const texts = (r: InsightsRow | null, e = acme) => insightLines(r, e).map((l) => l.text)

describe('insightLines', () => {
  it('words each fact as Part 1 does, every line with its source and the time', () => {
    const lines = insightLines(row(), acme)
    expect(lines.map((l) => l.text)).toEqual([
      'Hiring 14 roles: 6 software engineer, 3 product manager, 5 other. 2 senior, 9 mid, 3 junior. 4 posted this week, 11 this month. New York, Boston, Paris (40 % remote).',
      'Pay stated on 9 of 14: $140,000 to $240,000.',
      'Postings typically close in about 5 weeks (from 31 postings Cello watched close here).',
      'Median posting age 18 days.',
      'Named in postings: Python 11, Go 6, Spark 4, Kubernetes 4.',
    ])
    expect(lines.map((l) => l.source)).toEqual(['careers.acme.example', 'careers.acme.example', "Cello's own record of this board", 'careers.acme.example', 'careers.acme.example'])
    expect(lines.every((l) => l.at === AT)).toBe(true)
  })

  it('names the provider when the employer has no careers address, and gives no line for a fact it does not have', () => {
    const bare = row({
      by_type: [{ roleType: null, open: 1 }], by_seniority: { unknown: 1 }, locations: [], remote_share: null, posted_7d: 0, posted_30d: 0, open: 1,
      pay: { stated: 0, min: null, max: null, currency: null }, median_age_days: null, typical_close_days: null, closes_seen: 4, stack: [],
    })
    const lines = insightLines(bare, { ...acme, careersUrl: null })
    expect(lines).toEqual([{ text: 'Hiring 1 role.', source: 'Greenhouse board', at: AT }])
  })

  it('shows a country as US and never nests brackets in the places', () => {
    const [hiring] = insightLines(row({ locations: [{ name: 'USA', count: 2 }, { name: 'Berlin (Germany)', count: 1 }, { name: 'San Fransisco, CA, USA', count: 1 }], remote_share: null }), acme)
    expect(hiring.text.endsWith(' US, Berlin, San Fransisco.')).toBe(true)
    expect(hiring.text).not.toMatch(/\(\(|\)\)/)
  })

  it('has no hiring picture, and so no line at all, for a board with nothing open or never read', () => {
    expect(insightLines(null, acme)).toEqual([])
    expect(insightLines(row({ open: 0 }), acme)).toEqual([])
  })

  it('gives no pay line unless a yearly range exists, shows a single figure once, and names a currency that is not dollars', () => {
    expect(texts(row({ pay: { stated: 0, min: null, max: null, currency: null } })).some((t) => /^Pay/.test(t))).toBe(false)
    expect(texts(row({ pay: { stated: 1, min: 90000, max: 90000, currency: 'EUR' } }))[1]).toBe('Pay stated on 1 of 14: €90,000.')
    expect(texts(row({ pay: { stated: 12, min: 60000, max: 120000, currency: 'GBP' }, open: 40 }))[1]).toBe('Pay stated on 12 of 40: £60,000 to £120,000.')
  })

  it('says a pace in days under two weeks and in months past three, and the age of postings seen today as under a day', () => {
    expect(texts(row({ typical_close_days: 9, closes_seen: 12 }))[2]).toBe('Postings typically close in about 9 days (from 12 postings Cello watched close here).')
    expect(texts(row({ typical_close_days: 120 }))[2]).toMatch(/about 4 months/)
    expect(texts(row({ typical_close_days: null })).some((t) => /close/.test(t))).toBe(false)
    expect(texts(row({ median_age_days: 0 }))).toContain('Median posting age under a day.')
  })

  it('says an employer on the H-1B list has a record of filings, with no count, only when its whole registered domain is the listed name\'s .com', () => {
    const visa = { text: 'Has a record of H-1B filings in public U.S. Department of Labor data.', source: 'U.S. Department of Labor H-1B disclosure data, as a list in Cello', at: null }
    expect(insightLines(null, { ...acme, name: 'Stripe Payments', domain: 'stripe.com' })).toEqual([visa])
    expect(insightLines(null, { ...acme, name: 'Ramp', domain: 'ramp.com' })).toEqual([visa])
    expect(insightLines(null, { ...acme, name: 'Ramp', domain: 'careers.ramp.com' })).toEqual([visa])
    // another company with the same first label, and an employer matched on its name alone, are not on the list
    for (const domain of ['ramp.network', 'block.xyz', 'snap.org', 'meta.org', 'block.com', 'square.com', 'elastic.com']) expect(insightLines(null, { ...acme, name: 'Ramp', domain })).toEqual([])
    expect(insightLines(null, { ...acme, name: 'Meta', domain: null })).toEqual([])
    expect(insightLines(null, { ...acme, name: 'Somebody Else' })).toEqual([])
  })

  it('shows the company line from the profile, with its source and the time it was fetched, only for a match with a website', () => {
    const profile = { source: 'wikidata', fetched_at: '2026-10-19T08:00:00.000Z', website: 'https://www.acme.example/', hq: 'Paris', employees: 6000, industry: 'software', founded: 2010, ticker: 'ACME', github: 'acme' }
    expect(insightLines(null, { ...acme, profile })).toEqual([
      { text: 'Website acme.example, headquarters Paris, about 6,000 people, industry software, founded 2010, ticker ACME, GitHub acme.', source: 'Wikidata', at: '2026-10-19T08:00:00.000Z' },
    ])
    expect(insightLines(null, { ...acme, profile: { ...profile, matched: false } })).toEqual([])
    expect(insightLines(null, { ...acme, profile: { source: 'wikidata', fetched_at: AT } })).toEqual([])
    expect(insightLines(null, { ...acme, profile: { source: 'wikidata', website: 'https://acme.example', employees: 0 } })[0].text).toBe('Website acme.example.')
  })
})
