// Made-up employers for the Companies fixtures and their tests. No company here is real and nothing reads a
// database. The page's data is built in one place, so a fixture page and a test show the same rows.

import { employerId, fixtureTypeOptions } from '@/components/roles/fixtures'
import type { CompaniesData } from '@/app/(app)/companies/read'
import type { CompanyData, LiveData, LiveItem, PreviewData } from '@/app/(app)/companies/[id]/read'
import { fixtureRoles } from '@/components/roles/fixtures'
import { LIVE_PAGE } from './company-logic'
import { PAGE_SIZE, TABS, type CompaniesQuery, type CompanyItem, type Details, type Tab } from './logic'

export { fixtureTypeOptions }

/** The nth fixture employer: the first has roles for the person in two types, the second cannot be read. */
export function fixtureItem(n: number, over: Partial<CompanyItem> = {}): CompanyItem {
  const name = `Fixture Employer ${String(n + 1).padStart(3, '0')}`
  const id = employerId(n)
  return {
    id,
    companyId: n % 3 === 0 ? `20000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}` : null,
    name,
    domain: `employer-${n + 1}.example`,
    logoUrl: null,
    careersUrl: `https://employer-${n + 1}.example/careers`,
    open: n === 0 ? 636 : 40 + n,
    lastReadAt: new Date(Date.UTC(2026, 9, 5, 9) - n * 3_600_000).toISOString(),
    cannotRead: null,
    following: n % 3 === 0,
    pinned: n === 0,
    forYou: n === 0 ? 3 : n % 4 === 0 ? 0 : 1 + (n % 3),
    by: n === 0 ? [{ label: 'AI Engineer', n: 2 }, { label: 'Forward Deployed Engineer', n: 1 }] : [{ label: 'AI Engineer', n: 1 }],
    filings: false,
    key: [1, 0, 0, name.toLowerCase(), id],
    ...over,
  }
}

export const fixtureCheck = { lastAt: '2026-10-05T09:00:00.000Z', nextAt: '2026-10-05T18:00:00.000Z', missed: null }

export const FIXTURE_NOW = Date.UTC(2026, 9, 5, 12)

export const fixtureDetails: Details = {
  total: 3,
  roles: [
    { id: '10000000-0000-4000-8000-000000000001', title: 'AI Engineer', type: 'AI Engineer', postedAt: '2026-10-04T09:00:00.000Z' },
    { id: '10000000-0000-4000-8000-000000000002', title: 'Forward Deployed Engineer', type: 'Forward Deployed Engineer', postedAt: '2026-10-02T09:00:00.000Z' },
    { id: '10000000-0000-4000-8000-000000000003', title: 'Senior Machine Learning Engineer, Ranking and Retrieval for Regulated Industries', type: 'AI Engineer', postedAt: '2026-09-28T09:00:00.000Z' },
  ],
}

export interface FixtureOptions {
  /** How many rows exist on the tab (the page shows 50 and a Next when there are more). */
  n: number
  query: CompaniesQuery
  sponsor?: boolean
  cannot?: boolean
  types?: boolean
  loading?: boolean
  failed?: boolean
}

export function fixtureData(o: FixtureOptions): CompaniesData {
  const shown = Math.min(o.n, PAGE_SIZE)
  const items = Array.from({ length: shown }, (_, i) => fixtureItem(i, { filings: Boolean(o.sponsor) && i % 2 === 0, ...(o.cannot && i === 1 ? { cannotRead: 'no_board', forYou: null, by: [] } : {}) }))
  const tab: Tab = TABS.includes(o.query.tab) ? o.query.tab : 'hiring'
  // A tab's key is what SQL gives for it: All is (name, id), the others the five-part key.
  const rowsOnTab = items.map((i) => ({ ...(tab === 'following' ? { ...i, following: true } : i), key: tab === 'all' ? [i.name.toLowerCase(), i.id] : i.key }))
  return {
    items: o.failed ? [] : rowsOnTab,
    next: o.n > PAGE_SIZE && rowsOnTab.length > 0 ? rowsOnTab[rowsOnTab.length - 1].key : null,
    counts: { hiring: tab === 'hiring' ? o.n : 213, following: tab === 'following' ? o.n : 12, pinned: 1, all: 38406 },
    loading: o.loading ? { verified: 1200, pending: 3000 } : { verified: 38406, pending: 0 },
    check: fixtureCheck,
    needsSponsorship: Boolean(o.sponsor),
    hasTypes: o.types !== false,
    typeOptions: fixtureTypeOptions,
    suggestions: [],
    details: o.query.focus ? fixtureDetails : null,
    failed: Boolean(o.failed),
  }
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

/** One employer's page: a followed directory employer with three roles kept for the person. */
export function fixtureCompany(over: Partial<CompanyData> = {}): CompanyData {
  const kept = fixtureRoles(3, 1).map((r) => ({ ...r, company: 'Fixture Employer 001', companyId: employerId(0) }))
  return {
    id: employerId(0),
    state: 'directory',
    employerId: employerId(0),
    name: 'Fixture Employer 001',
    domain: 'employer-1.example',
    logoUrl: null,
    careersUrl: 'https://employer-1.example/careers',
    companyId: '20000000-0000-4000-8000-000000000001',
    following: true,
    pinned: false,
    open: 636,
    forYou: 12,
    cannotRead: null,
    tier: 'board',
    lastReadAt: '2026-10-05T09:00:00.000Z',
    check: fixtureCheck,
    kept,
    field: { n90: 14, n30: 5, byType: [{ id: 'ml-engineer', label: 'ML Engineer', n: 9 }, { id: 'ai-engineer', label: 'AI Engineer', n: 3 }], medians: [{ label: 'AI Engineer', days: 21 }], pay: 22, fill: 'Cello can fill Fixture Employer 001\'s form.' },
    facts: [{ text: 'Open roles by type: ML Engineer 9, AI Engineer 3.', source: 'Read of Fixture Employer 001\'s job board on Oct 5, 2026' }],
    history: [{ at: '2026-09-20T09:00:00.000Z', text: 'You applied to Senior Data Engineer. Status: applied.' }],
    notes: null,
    appliedAt: null,
    remove: { applications: 2, conversations: 1, people: 3, notes: false },
    needsSponsorship: false,
    typeOptions: fixtureTypeOptions,
    ...over,
  }
}

/** A live read of n roles, page `page`: the first 12 are the person's own, the rest carry their reasons, and the counted line adds up to n. */
export function fixtureLive(n: number, page = 0, over: Partial<LiveData> = {}): LiveData {
  const kept = Math.min(12, n)
  const others = n - kept
  const type = Math.floor(others * 0.61)
  const untyped = Math.floor(others * 0.03)
  const place = Math.floor(others * 0.24)
  const counts = { type, untyped, place, level: others - type - untyped - place }
  const pages = Math.max(1, Math.ceil(n / LIVE_PAGE))
  const at = Math.min(Math.max(0, page), pages - 1)
  const items: LiveItem[] = Array.from({ length: Math.max(0, Math.min(n, (at + 1) * LIVE_PAGE) - at * LIVE_PAGE) }, (_, j) => {
    const i = at * LIVE_PAGE + j
    return {
      key: `posting-${i + 1}`,
      title: ['AI Engineer', 'Forward Deployed Engineer', 'Product Manager', 'Account Executive', 'Staff Software Engineer, Applied AI and Developer Experience for Regulated Industries'][i % 5],
      location: i % 3 === 0 ? 'Remote, US' : 'Paris',
      postedAt: new Date(Date.UTC(2026, 9, 5) - i * 3_600_000).toISOString(),
      type: i % 2 === 0 ? 'AI Engineer' : null,
      level: 'Senior',
      reason: i < kept ? null : i % 4 === 0 ? 'Outside the places you chose' : i % 4 === 1 ? 'Other role type: Product Manager' : i % 4 === 2 ? 'Role type unknown' : 'Not your level',
      jobId: i < kept ? `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` : null,
    }
  })
  return { items, kept, total: n, matched: n, pages, page: at, counts, window: false, failure: null, rendered: false, limited: false, keptBefore: [], ...over }
}

export const fixturePreview: PreviewData = {
  employerId: employerId(0),
  company: { name: 'Fixture Employer 001', domain: 'employer-1.example', logoUrl: null },
  key: 'posting-14',
  title: 'Staff Machine Learning Engineer, Ranking',
  url: 'https://employer-1.example/jobs/14',
  level: 'Staff',
  type: 'ML Engineer',
  typeId: 'ml-engineer',
  location: 'Remote, US',
  postedAt: '2026-10-03T09:00:00.000Z',
  pay: '$210,000 to $260,000 a year',
  description: '## About the role\n\nYou will build the ranking systems behind search.\n\n## Requirements\n\n- Python services in production\n- Experience with large-scale retrieval\n- Kubernetes cluster operations',
  partial: false,
  tier: 'board',
  fit: {
    items: [
      { requirementId: 'r1', requirement: 'Python services in production', verdict: 'strength', evidence: [{ source: 'resume', ref: 'r', quote: 'I ran Python services in production for six years.' }], origin: 'code' },
      { requirementId: 'r2', requirement: 'Experience with large-scale retrieval', verdict: 'unknown', evidence: [], origin: 'code', notFound: true },
      { requirementId: 'r3', requirement: 'Kubernetes cluster operations', verdict: 'unknown', evidence: [], origin: 'code', notFound: true },
    ],
    strip: { strengths: 1, gaps: 0, unknown: 2 },
    needsModel: true,
    readAt: null,
  },
  kinds: { r1: 'must', r2: 'must', r3: 'nice' },
}
