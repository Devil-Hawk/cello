// Made-up employers for the Companies fixtures and their tests. No company here is real and nothing reads a
// database. The page's data is built in one place, so a fixture page and a test show the same rows.

import { employerId, fixtureTypeOptions } from '@/components/roles/fixtures'
import type { CompaniesData } from '@/app/(app)/companies/read'
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
