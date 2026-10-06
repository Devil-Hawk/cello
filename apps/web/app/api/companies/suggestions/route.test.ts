// GET and POST /api/companies/suggestions, and POST /api/companies/suggestions/[id].

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeDb } from '@/lib/companies/fake-db'

let user: { id: string } | null
let db: ReturnType<typeof fakeDb>
let admin: ReturnType<typeof fakeDb>

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...(db.client as object), auth: { getUser: async () => ({ data: { user }, error: null }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin.client }))

const refreshMock = vi.fn()
vi.mock('@/lib/companies/refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/companies/refresh')>()),
  refreshSuggestionsForUser: (...args: unknown[]) => refreshMock(...args),
}))

import { GET, POST } from './route'
import { POST as ACT } from './[id]/route'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const PREFS = { targeting: { titles: ['Backend Engineer'], countries: ['US'] } }

function sRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: ME, company_key: `${id.slice(0, 4)}.com`, name: `Co ${id.slice(0, 2)}`, domain: `${id.slice(0, 4)}.com`, logo_url: null, tier: 3, rank: 1,
    reason: 'Has an open "Backend Engineer" posting on Remotive.', source_url: 'https://remotive.com/jobs/1', source_label: 'Remotive posting',
    signals: [], ats: null, status: 'open', company_id: null, dismiss_reason: null, acted_at: null, computed_at: '2026-10-05T13:07:00Z', ...over,
  }
}

function setup(over: { profile?: Record<string, unknown>; state?: Record<string, unknown>[]; suggestions?: Record<string, unknown>[]; directory?: Record<string, unknown>[] } = {}) {
  db = fakeDb(
    {
      profiles: [{ id: ME, resume_text: null, preferences: PREFS, is_demo: false, demo_expires_at: null, ...over.profile }],
      company_suggestion_state: over.state ?? [],
      company_suggestions: over.suggestions ?? [],
      companies: [],
    },
    { unique: { companies: [['user_id', 'name_key'], ['user_id', 'domain']] }, autoId: ['companies'] }
  )
  // Writes go through the admin client; both clients see the same tables so the route's reads see its writes.
  const directory = fakeDb({ company_directory: over.directory ?? [] }, { autoId: [] })
  admin = fakeDb({}, { autoId: [] })
  ;(admin.client as unknown as { from: (t: string) => unknown }).from = (table: string) =>
    ((table === 'company_directory' ? directory.client : db.client) as unknown as { from: (t: string) => unknown }).from(table)
  // companies_follow acts on the same companies rows
  ;(admin.client as unknown as { rpc: unknown }).rpc = (db.client as unknown as { rpc: unknown }).rpc
}

const json = (body: unknown) => new NextRequest('http://localhost/api/companies/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const act = (id: string, body: unknown) => ACT(new NextRequest(`http://localhost/api/companies/suggestions/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id } })

beforeEach(() => {
  user = { id: ME }
  refreshMock.mockReset().mockResolvedValue({ status: 'ok', stored: 12, counts: {} })
  setup()
})

describe('GET /api/companies/suggestions', () => {
  it('401 without a user', async () => {
    user = null
    expect((await GET()).status).toBe(401)
  })

  it('needs_targeting when the person has no role signal, not_built before the first refresh, ready after', async () => {
    setup({ profile: { preferences: {} } })
    expect((await (await GET()).json()).status).toBe('needs_targeting')

    setup()
    const built = await (await GET()).json()
    expect(built).toEqual({ status: 'not_built', refresh: { state: null, computedAt: null, nextRefreshAt: null }, suggestions: [] })

    setup({
      state: [{ user_id: ME, status: 'ok', computed_at: '2026-10-05T13:07:00Z', next_refresh_at: '2026-10-06T09:07:00Z' }],
      suggestions: [sRow(S2, { rank: 2 }), sRow(S1, { rank: 1 }), sRow(S_OTHER, { user_id: OTHER }), sRow('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { status: 'dismissed', rank: 3 })],
    })
    const ready = await (await GET()).json()
    expect(ready.status).toBe('ready')
    expect(ready.refresh).toEqual({ state: 'ok', computedAt: '2026-10-05T13:07:00Z', nextRefreshAt: '2026-10-06T09:07:00Z' })
    expect(ready.suggestions.map((s: { id: string }) => s.id)).toEqual([S1, S2])
    expect(ready.suggestions[0]).toMatchObject({ tier: 3, rank: 1, sourceLabel: 'Remotive posting', sourceUrl: 'https://remotive.com/jobs/1', status: 'open' })
    expect(refreshMock).not.toHaveBeenCalled() // a page load never computes
  })

  it('shows the last good list with a failed refresh state', async () => {
    setup({ state: [{ user_id: ME, status: 'failed', computed_at: '2026-10-04T13:07:00Z', next_refresh_at: '2026-10-06T09:07:00Z' }], suggestions: [sRow(S1)] })
    const body = await (await GET()).json()
    expect(body.status).toBe('ready')
    expect(body.refresh.state).toBe('failed')
    expect(body.suggestions).toHaveLength(1)
  })

  it('tells a demo workspace there is nothing to show', async () => {
    setup({ profile: { is_demo: true } })
    expect((await (await GET()).json()).status).toBe('not_built')
  })
})

describe('POST /api/companies/suggestions (refresh)', () => {
  it('401, and 400 unless the body is {refresh:true}', async () => {
    user = null
    expect((await POST(json({ refresh: true }))).status).toBe(401)
    user = { id: ME }
    expect((await POST(json({}))).status).toBe(400)
    expect((await POST(json({ refresh: false }))).status).toBe(400)
  })

  it('403 for a demo', async () => {
    setup({ profile: { is_demo: true } })
    expect((await POST(json({ refresh: true }))).status).toBe(403)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('429 when it was computed under an hour ago, with the time', async () => {
    const recent = new Date(Date.now() - 20 * 60_000).toISOString()
    setup({ state: [{ user_id: ME, status: 'ok', computed_at: recent, next_refresh_at: recent }] })
    const res = await POST(json({ refresh: true }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'recently_refreshed', computedAt: recent })
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('202 and builds the list for this person when it was computed more than an hour ago, or never', async () => {
    const res = await POST(json({ refresh: true }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'ok', stored: 12 })
    expect(refreshMock.mock.calls[0][1]).toBe(ME)

    const old = new Date(Date.now() - 3 * 3600_000).toISOString()
    setup({ state: [{ user_id: ME, status: 'ok', computed_at: old, next_refresh_at: old }] })
    expect((await POST(json({ refresh: true }))).status).toBe(202)
  })
})

describe('POST /api/companies/suggestions/[id]', () => {
  it('401 without a user, 404 for a malformed id, 400 for a bad action or reason', async () => {
    user = null
    expect((await act(S1, { action: 'dismiss' })).status).toBe(401)
    user = { id: ME }
    expect((await act('not-a-uuid', { action: 'dismiss' })).status).toBe(404)
    setup({ suggestions: [sRow(S1)] })
    expect((await act(S1, { action: 'explode' })).status).toBe(400)
    expect((await act(S1, { action: 'dismiss', reason: 'because' })).status).toBe(400)
  })

  it("404 for another person's suggestion and for one that does not exist, changing nothing", async () => {
    setup({ suggestions: [sRow(S_OTHER, { user_id: OTHER })] })
    expect((await act(S_OTHER, { action: 'dismiss' })).status).toBe(404)
    expect((await act(S1, { action: 'dismiss' })).status).toBe(404)
    expect(db.tables.company_suggestions[0].status).toBe('open')
  })

  it('dismiss stores the reason and the time, and keeps the tier, rank and evidence', async () => {
    setup({ suggestions: [sRow(S1, { tier: 2, rank: 4, signals: [{ kind: 'posting', url: 'https://x.test', label: 'x' }] })] })
    const res = await act(S1, { action: 'dismiss', reason: 'location' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'dismissed' })
    expect(db.tables.company_suggestions[0]).toMatchObject({ status: 'dismissed', dismiss_reason: 'location', tier: 2, rank: 4, signals: [{ kind: 'posting' }] })
    expect(typeof db.tables.company_suggestions[0].acted_at).toBe('string')
  })

  it('dismiss without a reason is allowed', async () => {
    setup({ suggestions: [sRow(S1)] })
    expect((await act(S1, { action: 'dismiss' })).status).toBe(200)
    expect(db.tables.company_suggestions[0]).toMatchObject({ status: 'dismissed', dismiss_reason: null })
  })

  it('undo brings a dismissed suggestion back, and refuses one that is not dismissed', async () => {
    setup({ suggestions: [sRow(S1, { status: 'dismissed', dismiss_reason: 'other', acted_at: '2026-10-05T14:00:00Z' }), sRow(S2)] })
    expect((await act(S1, { action: 'undo' })).status).toBe(200)
    expect(db.tables.company_suggestions[0]).toMatchObject({ status: 'open', dismiss_reason: null, acted_at: null })
    const res = await act(S2, { action: 'undo' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_dismissed' })
  })

  it('add follows a verified employer through companies.add, then records the company on the row', async () => {
    setup({
      suggestions: [sRow(S1, { company_key: 'acme.com', name: 'Acme', domain: 'acme.com' })],
      directory: [{ id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', logo_url: null, careers_url: 'https://jobs.lever.co/acme', ats_provider: 'lever', ats_token: 'acme', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 7 }],
    })
    const res = await act(S1, { action: 'add', dream: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('added')
    expect(body.company).toMatchObject({ outcome: 'added', name: 'Acme', openRoles: 7 })
    expect(db.tables.companies).toHaveLength(1)
    expect(db.tables.companies[0]).toMatchObject({ user_id: ME, domain: 'acme.com', career_url: 'https://jobs.lever.co/acme', is_dream_company: true, employer_id: 'e1', metadata: { ats: { provider: 'lever', token: 'acme' } } })
    expect(db.tables.company_suggestions[0]).toMatchObject({ status: 'added', company_id: db.tables.companies[0].id })
  })

  it('adding twice never duplicates', async () => {
    setup({
      suggestions: [sRow(S1, { company_key: 'acme.com', name: 'Acme', domain: 'acme.com' })],
      directory: [{ id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', logo_url: null, careers_url: '', ats_provider: 'lever', ats_token: 'acme', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 7 }],
    })
    expect((await (await act(S1, { action: 'add' })).json()).company.outcome).toBe('added')
    expect((await (await act(S1, { action: 'add' })).json()).company.outcome).toBe('already_watching')
    expect(db.tables.companies).toHaveLength(1)
  })

  it('a company that is not a verified employer and has no website is not added, and says why', async () => {
    setup({ suggestions: [sRow(S1, { company_key: 'name:solo', name: 'Solo Co', domain: null })] })
    const body = await (await act(S1, { action: 'add' })).json()
    expect(body).toMatchObject({ status: 'open', notAdded: { reason: 'no_board' } })
    expect(db.tables.companies).toHaveLength(0)
    expect(db.tables.company_suggestions[0].status).toBe('open')
  })
})
