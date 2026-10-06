import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ liveRoles: vi.fn(), previewPosting: vi.fn(), admin: { current: null as unknown } }))

vi.mock('@/lib/clock/status', () => ({ checksStatus: async () => ({ rolesCheck: null }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => mocks.admin.current }))
vi.mock('@/lib/companies/live-roles', async (orig) => ({ ...(await orig<typeof import('@/lib/companies/live-roles')>()), liveRoles: mocks.liveRoles }))
vi.mock('@/lib/companies/preview', () => ({ previewPosting: mocks.previewPosting }))
vi.mock('@/lib/fit/material', () => ({ loadMaterial: async () => ({ sources: [{ source: 'resume', ref: 'r1', text: 'I ran Python services in production for six years.', updatedAt: '' }], baseResume: null }) }))
vi.mock('@/lib/ingest/reader/targets', async (orig) => ({ ...(await orig<typeof import('@/lib/ingest/reader/targets')>()), loadTargets: async () => ({ targeting: {}, titles: [], version: 0 }) }))

import { decodeKey, encodeKey } from '@/components/companies/company-logic'
import { fieldFrom, readCompany, readLive, readPreview, resolveCompany, type OwnRow } from './read'

const EMP = '00000000-0000-4000-8000-0000000000e1'
const OWN = '00000000-0000-4000-8000-0000000000c1'
const MAIL = '00000000-0000-4000-8000-0000000000c2'

const employer = (over: Record<string, unknown> = {}) => ({
  id: EMP,
  name: 'Stripe',
  name_norm: 'stripe',
  domain: 'stripe.com',
  logo_url: null,
  open_count: 636,
  open_count_at: null,
  ats_provider: 'greenhouse',
  ats_token: 'stripe',
  careers_url: 'https://stripe.com/jobs',
  verified_by: 'careers_link',
  verified_at: '2026-10-01T00:00:00Z',
  source: 'person',
  last_read_at: '2026-10-05T09:00:00Z',
  next_read_at: null,
  read_tier: 'board',
  cannot_read_reason: null,
  failed_reads: 0,
  ...over,
})

const own = (over: Partial<OwnRow> = {}): OwnRow => ({ id: OWN, name: 'Stripe', domain: 'stripe.com', logo_url: null, career_url: null, employer_id: EMP, watching: true, is_dream_company: false, notes: null, metadata: {}, created_at: '2026-09-01T00:00:00Z', ...over })

/** A database that answers by table and by what was asked with eq, records every write and every rpc, and answers rpcs from a map. */
function fakeDb(resolve: (table: string, eq: Record<string, unknown>) => unknown = () => null, rpcs: Record<string, unknown> = {}) {
  const writes: string[] = []
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  const chain = (table: string): unknown => {
    const eq: Record<string, unknown> = {}
    const p: unknown = new Proxy(function () {}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (res: (v: unknown) => unknown) => res({ data: resolve(table, eq), error: null, count: 0 })
        if (['insert', 'update', 'upsert', 'delete'].includes(prop)) return () => (writes.push(`${table}.${prop}`), p)
        if (prop === 'eq') return (c: string, v: unknown) => ((eq[c] = v), p)
        return () => p
      },
    })
    return p
  }
  return {
    writes,
    rpcCalls,
    db: {
      from: chain,
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        rpcCalls.push({ name, args })
        return { data: rpcs[name] ?? null, error: null }
      },
    } as never,
  }
}

beforeEach(() => {
  mocks.liveRoles.mockReset()
  mocks.previewPosting.mockReset()
  mocks.admin.current = fakeDb((t) => (t === 'company_directory' ? employer() : null), { take_command_slot: true }).db
})

describe('resolveCompany: which page an address opens', () => {
  it('opens a directory employer the person has no companies row for', async () => {
    const admin = fakeDb((t) => (t === 'company_directory' ? employer() : null)).db
    const r = await resolveCompany(fakeDb(() => null).db, admin, 'u1', EMP)
    expect(r).toMatchObject({ kind: 'directory', own: null })
  })

  it('opens a directory employer with the person\'s own row beside it', async () => {
    const admin = fakeDb((t) => (t === 'company_directory' ? employer() : null)).db
    const r = await resolveCompany(fakeDb((t) => (t === 'companies' ? own() : null)).db, admin, 'u1', EMP)
    expect(r).toMatchObject({ kind: 'directory', own: { id: OWN } })
  })

  it('sends a person\'s own id that has an employer to the directory id', async () => {
    const admin = fakeDb((t, eq) => (t === 'company_directory' && eq.id === EMP ? employer() : null)).db
    const r = await resolveCompany(fakeDb((t) => (t === 'companies' ? own() : null)).db, admin, 'u1', OWN)
    expect(r).toEqual({ kind: 'redirect', to: `/companies/${EMP}` })
  })

  it('opens a row known only from email by its own id', async () => {
    const admin = fakeDb(() => null).db
    const r = await resolveCompany(fakeDb((t) => (t === 'companies' ? own({ id: MAIL, employer_id: null, watching: false }) : null)).db, admin, 'u1', MAIL)
    expect(r).toMatchObject({ kind: 'email', own: { id: MAIL } })
  })

  it('does not open what is not there, or an address that is not an id', async () => {
    const admin = fakeDb(() => null).db
    expect(await resolveCompany(fakeDb(() => null).db, admin, 'u1', EMP)).toEqual({ kind: 'missing' })
    expect(await resolveCompany(fakeDb(() => null).db, admin, 'u1', 'not-an-id')).toEqual({ kind: 'missing' })
  })
})

describe('hiring in the field', () => {
  const row = (role_type: string | null, over: Record<string, unknown> = {}) => ({ role_type, open_count: 3, opened_30d: 1, opened_90d: 2, closed_count: 0, median_lifetime_days: null, stated_pay: null, read_at: null, ...over })

  it('counts only the person\'s own types, with the split by type', () => {
    const f = fieldFrom([row('ai-engineer', { open_count: 3 }), row('ml-engineer', { open_count: 9 }), row('solutions-engineer', { open_count: 50 })], ['ai-engineer', 'ml-engineer'], null)!
    expect(f.n90).toBe(4)
    expect(f.n30).toBe(2)
    expect(f.byType.map((t) => `${t.label} ${t.n}`)).toEqual(['ML Engineer 9', 'AI Engineer 3'])
  })

  it('gives a median posting life only from at least five closed roles', () => {
    const few = fieldFrom([row('ai-engineer', { closed_count: 4, median_lifetime_days: 20 })], ['ai-engineer'], null)!
    expect(few.medians).toEqual([])
    const enough = fieldFrom([row('ai-engineer', { closed_count: 5, median_lifetime_days: 20.4 })], ['ai-engineer'], null)!
    expect(enough.medians).toEqual([{ label: 'AI Engineer', days: 20 }])
  })

  it('is nothing when the employer has nothing to say, so the group stays hidden', () => {
    expect(fieldFrom([], ['ai-engineer'], null)).toBeNull()
    expect(fieldFrom([row('solutions-engineer')], ['ai-engineer'], null)).toBeNull()
    expect(fieldFrom([], [], 'Cello can fill Stripe\'s form.')).not.toBeNull()
  })
})

describe('readCompany', () => {
  it('reads the first screen from stored rows and writes nothing', async () => {
    const { db, writes, rpcCalls } = fakeDb((t) => (t === 'profiles' ? { preferences: {} } : []), { role_counts: [{ key: EMP, n: 12 }] })
    const data = await readCompany(db, 'u1', { kind: 'directory', employer: employer() as never, own: null })
    expect(data).toMatchObject({ id: EMP, state: 'directory', name: 'Stripe', open: 636, forYou: 12, following: false, companyId: null, remove: null })
    expect(writes).toEqual([])
    expect(rpcCalls.map((c) => c.name)).toEqual(['role_counts'])
  })

  it('names what a removal will touch from counts read first, for the person\'s own row', async () => {
    const { db } = fakeDb((t) => (t === 'profiles' ? { preferences: {} } : t === 'companies' ? null : []))
    const data = await readCompany(db, 'u1', { kind: 'directory', employer: employer() as never, own: own({ notes: 'Met Dana' }) })
    expect(data.companyId).toBe(OWN)
    expect(data.following).toBe(true)
    expect(data.remove).toMatchObject({ applications: 0, conversations: 0, people: 0, notes: true })
  })

  it('never lists the roles of a pinned or unfollowed row as a count it did not read', async () => {
    const { db } = fakeDb((t) => (t === 'profiles' ? { preferences: {} } : []), { role_counts: [] })
    const data = await readCompany(db, 'u1', { kind: 'directory', employer: employer({ cannot_read_reason: 'no_board', open_count: null }) as never, own: null })
    expect(data.cannotRead).toBe('no_board')
    expect(data.open).toBeNull()
  })
})

const row = (key: string, over: Record<string, unknown> = {}) => ({ key, title: `Role ${key}`, url: `https://stripe.com/jobs/${key}`, location: 'Remote', postedAt: null, role_type: 'ai-engineer', level: 'senior', reason: null, jobId: null, ...over })
const read = (over: Record<string, unknown> = {}) => ({ rows: [], matched: 0, kept: 0, counts: {}, total: 0, page: 0, pages: 1, tier: 'board', window: false, failure: null, ...over })
const q = (over = {}) => ({ q: null, all: true, type: null, place: null, page: 0, ...over })

describe('readLive: the whole list, read now and not stored', () => {
  it('lists the employer\'s roles with the reasons and the whole read\'s totals, and writes nothing', async () => {
    mocks.liveRoles.mockResolvedValue(read({ rows: [row('a'), row('b', { reason: 'type', role_type: 'solutions-engineer' })], matched: 2, kept: 1, total: 2, counts: { type: 1 } }))
    const { db, writes } = fakeDb()
    const live = await readLive(db, 'u1', employer() as never, null, q() as never)
    expect(live.items.map((i) => i.key)).toEqual(['a', 'b'])
    expect(live.items[1].reason).toBe('Other role type: Solutions Engineer')
    expect(live.items[0].reason).toBeNull()
    expect({ kept: live.kept, total: live.total, counts: live.counts }).toEqual({ kept: 1, total: 2, counts: { type: 1 } })
    expect(writes).toEqual([])
  })

  it('hands the words, the type and the place to the read, so they narrow the whole list before it is paged', async () => {
    mocks.liveRoles.mockResolvedValue(read())
    await readLive(fakeDb().db, 'u1', employer() as never, null, q({ q: 'forward deployed', type: 'ai-engineer', place: 'Paris', page: 2 }) as never)
    expect(mocks.liveRoles.mock.calls[0][0]).toMatchObject({ page: 2, match: { words: 'forward deployed', type: 'ai-engineer', place: 'Paris' } })
  })

  it('reads the employer as the verified board it is tied to, with or without a row of the person\'s own', async () => {
    mocks.liveRoles.mockResolvedValue(read())
    await readLive(fakeDb().db, 'u1', employer() as never, null, q() as never)
    expect(mocks.liveRoles.mock.calls[0][0].company).toMatchObject({ id: EMP, employer_id: EMP, metadata: { ats: { provider: 'greenhouse', token: 'stripe' } } })
    await readLive(fakeDb().db, 'u1', employer() as never, own(), q() as never)
    expect(mocks.liveRoles.mock.calls[1][0].company).toMatchObject({ id: OWN, employer_id: EMP })
  })

  it('does not read a site it cannot read: it answers with the roles kept before', async () => {
    const { db } = fakeDb((t) => (t === 'person_roles' ? [] : null))
    const live = await readLive(db, 'u1', employer({ cannot_read_reason: 'no_board' }) as never, null, q({ q: 'forward' }) as never)
    expect(mocks.liveRoles).not.toHaveBeenCalled()
    expect(live).toMatchObject({ items: [], keptBefore: [], rendered: false, limited: false })
  })

  it('says a site read only in the background cannot be listed, and makes no live read', async () => {
    const live = await readLive(fakeDb().db, 'u1', employer({ read_tier: 'rendered' }) as never, null, q() as never)
    expect(live.rendered).toBe(true)
    expect(mocks.liveRoles).not.toHaveBeenCalled()
  })

  it('refuses a page past 30 in ten minutes and reads nothing', async () => {
    mocks.admin.current = fakeDb(() => null, { take_command_slot: false }).db
    const live = await readLive(fakeDb().db, 'u1', employer() as never, null, q() as never)
    expect(live.limited).toBe(true)
    expect(mocks.liveRoles).not.toHaveBeenCalled()
  })

  it('shows a read that listed nothing with its reason and falls back to what was kept before', async () => {
    mocks.liveRoles.mockResolvedValue(read({ failure: 'unreachable', tier: null }))
    const live = await readLive(fakeDb((t) => (t === 'person_roles' ? [] : null)).db, 'u1', employer() as never, null, q() as never)
    expect(live).toMatchObject({ total: 0, failure: 'unreachable', items: [] })
  })
})

describe('readPreview: one posting, read now and not stored', () => {
  const requirements = { version: 1, source: 'deterministic', skills_resolved: true, must_have: ['Python services in production', 'Kubernetes cluster operations'], nice_to_have: [], years_experience: { min: null, max: null }, seniority: null, location: { mode: null, places: [] }, visa: { sponsorship: 'not_stated', evidence: null }, salary: null }
  const preview = { title: 'Staff Engineer', location: 'Remote', salary_range: '$200,000', description_md: '## About\n\nWhole posting.', description_state: 'full', description_source: 'detail', apply_url: null, description_md5: 'x', requirements }

  it('opens the record of a role the person already holds there', async () => {
    const { db } = fakeDb((t) => (t === 'person_jobs' ? { id: 'job-9' } : null))
    expect(await readPreview(db, 'u1', employer() as never, null, 'k1')).toEqual({ kind: 'held', id: 'job-9' })
    expect(mocks.liveRoles).not.toHaveBeenCalled()
  })

  it('finds the posting in its own live read by the employer\'s key, and takes the link from that row alone', async () => {
    mocks.liveRoles.mockResolvedValue(read({ rows: [row('k1')], matched: 1, total: 1 }))
    mocks.previewPosting.mockResolvedValue(preview)
    const { db, writes } = fakeDb()
    const r = await readPreview(db, 'u1', employer() as never, null, 'k1')
    expect(mocks.liveRoles.mock.calls[0][0].match).toEqual({ key: 'k1' })
    expect(mocks.previewPosting).toHaveBeenCalledWith({ url: 'https://stripe.com/jobs/k1', title: 'Role k1' })
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.data).toMatchObject({ employerId: EMP, key: 'k1', title: 'Staff Engineer', pay: '$200,000', level: 'Senior' })
    // Code reads each requirement against the person's own words: one found, one not.
    expect(r.data.fit.items.map((i) => i.verdict)).toEqual(['strength', 'unknown'])
    expect(r.data.fit.items[0].origin).toBe('code')
    expect(writes).toEqual([])
  })

  it('is not found for a key that is not in the live read, and never fetches anything for it', async () => {
    mocks.liveRoles.mockResolvedValue(read())
    expect(await readPreview(fakeDb().db, 'u1', employer() as never, null, 'https://evil.example/jobs/1')).toEqual({ kind: 'missing' })
    expect(mocks.previewPosting).not.toHaveBeenCalled()
  })

  it('says a posting that was listed and is not any more is closed', async () => {
    mocks.liveRoles.mockResolvedValue(read({ rows: [row('k1')], matched: 1, total: 1 }))
    mocks.previewPosting.mockResolvedValue(null)
    expect(await readPreview(fakeDb().db, 'u1', employer() as never, null, 'k1')).toEqual({ kind: 'closed', company: { name: 'Stripe' } })
  })

  it('refuses past 30 previews in ten minutes', async () => {
    mocks.admin.current = fakeDb(() => null, { take_command_slot: false }).db
    expect(await readPreview(fakeDb().db, 'u1', employer() as never, null, 'k1')).toEqual({ kind: 'limited' })
  })
})

describe('the posting key in an address', () => {
  it('survives any key an employer uses, including a link, and decodes only what it made', () => {
    for (const key of ['abc123', 'https://boards.greenhouse.io/stripe/jobs/4000?gh_jid=4000&x=%20y', 'ünïcode/ключ']) {
      const enc = encodeKey(key)
      expect(enc).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeKey(enc)).toBe(key)
    }
    expect(decodeKey('has space')).toBeNull()
    expect(decodeKey('%2F%2F')).toBeNull()
    expect(decodeKey('')).toBeNull()
  })
})
