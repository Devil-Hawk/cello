import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clock/status', () => ({ checksStatus: async () => ({ rolesCheck: { lastSucceededAt: '2026-10-05T09:00:00.000Z', nextDueAt: '2026-10-05T18:00:00.000Z', missed: false, missedText: null } }) }))
vi.mock('@/lib/companies/suggestions-store', () => ({ readSuggestions: async () => ({ status: 'ready', suggestions: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` })) }) }))
const search = vi.fn()
vi.mock('@/lib/companies/directory', () => ({ searchCompanies: (...a: unknown[]) => search(...a) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

import { DEFAULT_QUERY, PAGE_SIZE, type CompaniesQuery } from '@/components/companies/logic'
import { findCompanies, readCompanies, toItem } from './read'

interface Call {
  rpc: string
  args: Record<string, unknown>
}

/** A database that records every rpc, answers the ones given and returns one row of profile data. */
function fakeDb(rpcs: Record<string, unknown>, tables: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const chain = (table: string): unknown => {
    const result = { data: tables[table] ?? null, error: null, count: 0 }
    const p: unknown = new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (res: (v: unknown) => unknown) => res(result) : () => p),
    })
    return p
  }
  return {
    calls,
    db: {
      from: chain,
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ rpc: name, args })
        const out = rpcs[name]
        return out instanceof Error ? { data: null, error: { message: out.message } } : { data: out ?? null, error: null }
      },
    } as never,
  }
}

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  company_id: null,
  name: `Employer ${n}`,
  domain: null,
  logo_url: null,
  careers_url: null,
  open_count: 40,
  last_read_at: null,
  cannot_read_reason: null,
  following: false,
  pinned: false,
  for_you: 2,
  by_type: { 'ai-engineer': 2 },
  k: [1, 0, 0, `employer ${n}`, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`],
  ...over,
})

const q = (over: Partial<CompaniesQuery> = {}): CompaniesQuery => ({ ...DEFAULT_QUERY, ...over })
const page = (calls: Call[]) => calls.find((c) => c.rpc === 'companies_page')!.args

describe('readCompanies', () => {
  const profile = { profiles: { preferences: { constraints: { needsSponsorship: true }, targeting: { role_types: ['ai-engineer'] } }, resume_text: null } }

  it('asks for one row more than a page, so the page knows there is a next', async () => {
    const { db, calls } = fakeDb({ companies_page: Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row(i + 1)), companies_tab_counts: [{ hiring: 213, following: 12, pinned: 1 }] }, profile)
    const data = await readCompanies(db, 'u1', q())
    expect(page(calls).p_limit).toBe(PAGE_SIZE + 1)
    expect(data.items).toHaveLength(PAGE_SIZE)
    expect(data.next).toEqual(data.items[PAGE_SIZE - 1].key)
    expect(data.counts).toMatchObject({ hiring: 213, following: 12, pinned: 1 })
  })

  it('has no next page when SQL returned a page or less', async () => {
    const { db } = fakeDb({ companies_page: Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1)) }, profile)
    const data = await readCompanies(db, 'u1', q())
    expect(data.items).toHaveLength(PAGE_SIZE)
    expect(data.next).toBeNull()
  })

  it('sends the page key back as it came, and the tab and filters as the address gave them', async () => {
    const after = [1, 0, 0, 'employer 7', '00000000-0000-4000-8000-000000000007']
    const { db, calls } = fakeDb({ companies_page: [] }, profile)
    await readCompanies(db, 'u1', q({ tab: 'following', after, type: 'ai-engineer', cannot: true, pinned: true }))
    expect(page(calls)).toMatchObject({ p_tab: 'following', p_after: after, p_role_type: 'ai-engineer', p_cannot_read: true, p_pinned: true })
  })

  it('sends the curated names only to a person who needs sponsorship and asked for the filter', async () => {
    const asked = fakeDb({ companies_page: [] }, profile)
    await readCompanies(asked.db, 'u1', q({ h1b: true }))
    expect(Array.isArray(page(asked.calls).p_names) && (page(asked.calls).p_names as string[]).length).toBeGreaterThan(10)
    const notAsked = fakeDb({ companies_page: [] }, profile)
    await readCompanies(notAsked.db, 'u1', q())
    expect(page(notAsked.calls).p_names).toBeNull()
    const noNeed = fakeDb({ companies_page: [] }, { profiles: { preferences: {}, resume_text: null } })
    await readCompanies(noNeed.db, 'u1', q({ h1b: true }))
    expect(page(noNeed.calls).p_names).toBeNull()
  })

  it('reports a failed page as failed, never as an empty list', async () => {
    const { db } = fakeDb({ companies_page: new Error('boom') }, profile)
    const data = await readCompanies(db, 'u1', q())
    expect(data.failed).toBe(true)
    expect(data.items).toEqual([])
  })

  it('takes the All count and the loading line from the sweep heartbeat, never from a count of rows', async () => {
    const { db } = fakeDb({ companies_page: [] }, { ...profile, job_heartbeats: { found: { verified_total: 38406, pending_total: 120 } } })
    const data = await readCompanies(db, 'u1', q({ tab: 'all' }))
    expect(data.counts.all).toBe(38406)
    expect(data.loading).toEqual({ verified: 38406, pending: 120 })
    const none = await readCompanies(fakeDb({ companies_page: [] }, profile).db, 'u1', q())
    expect(none.counts.all).toBeNull()
  })

  it('shows at most five suggestions, only on Following', async () => {
    const { db } = fakeDb({ companies_page: [] }, profile)
    expect((await readCompanies(db, 'u1', q({ tab: 'following' }))).suggestions).toHaveLength(5)
    expect((await readCompanies(db, 'u1', q({ tab: 'hiring' }))).suggestions).toHaveLength(0)
  })

  it('says whether the person has chosen role types', async () => {
    const some = await readCompanies(fakeDb({ companies_page: [] }, profile).db, 'u1', q())
    expect(some.hasTypes).toBe(true)
    const none = await readCompanies(fakeDb({ companies_page: [] }, { profiles: { preferences: {}, resume_text: null } }).db, 'u1', q())
    expect(none.hasTypes).toBe(false)
  })
})

describe('a row', () => {
  it('splits the roles by the type names a person knows, most first, and drops a type it cannot name', () => {
    const item = toItem(row(1, { by_type: { 'ml-engineer': 1, 'ai-engineer': 3, 'no-such-type': 9 } }) as never, false)
    expect(item.by.map((b) => b.n)).toEqual([3, 1])
    expect(item.by.map((b) => b.label)).not.toContain('no-such-type')
  })

  it('never carries a count for a site that cannot be read', () => {
    expect(toItem(row(1, { cannot_read_reason: 'no_board', for_you: 0 }) as never, false).forYou).toBeNull()
  })

  it('marks past filings only for a person who needs sponsorship, from the public list', () => {
    expect(toItem(row(1, { name: 'Google' }) as never, true).filings).toBe(true)
    expect(toItem(row(1, { name: 'Google' }) as never, false).filings).toBe(false)
    expect(toItem(row(1, { name: 'Totally Unknown Co' }) as never, true).filings).toBe(false)
  })
})

describe('findCompanies', () => {
  it("adds the person's count and whether they follow it to a verified hit, and neither to a candidate", async () => {
    search.mockResolvedValue({
      employers: [{ id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', logo_url: null, open_count: 6, last_read_at: null, careers_url: null, cannot_read_reason: null }],
      notChecked: [{ id: 'c1', name: 'Retello', domain: 'retello.example' }],
    })
    const { db } = fakeDb({ role_counts: [{ key: 'e1', n: 3 }] }, { companies: [{ id: 'own1', employer_id: 'e1', watching: true, is_dream_company: false }], profiles: { preferences: {} } })
    const found = await findCompanies(db, 'u1', 'retell')
    expect(found.employers[0]).toMatchObject({ id: 'e1', forYou: 3, following: true, companyId: 'own1', pinned: false })
    expect(found.notChecked).toEqual([{ id: 'c1', name: 'Retello', domain: 'retello.example' }])
    expect(found.notChecked[0]).not.toHaveProperty('forYou')
  })

  it('shows no count for a hit whose site cannot be read', async () => {
    search.mockResolvedValue({ employers: [{ id: 'e1', name: 'Apple', name_norm: 'apple', domain: null, logo_url: null, open_count: null, last_read_at: null, careers_url: null, cannot_read_reason: 'cannot_read' }], notChecked: [] })
    const { db } = fakeDb({ role_counts: [] }, { companies: [], profiles: { preferences: {} } })
    expect((await findCompanies(db, 'u1', 'apple')).employers[0].forYou).toBeNull()
  })
})
