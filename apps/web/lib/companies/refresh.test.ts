import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobLead } from '../sources/types'
import { fakeDb } from './fake-db'
import { hasRoleSignal, refreshDueSuggestions, refreshSuggestionsForUser, type RefreshDeps } from './refresh'
import type { BoardHit } from './types'

const NOW = new Date('2026-10-05T12:00:00Z')
/** A deadline after the fixed clock the due pass is given. */
const LATER = Date.parse('2026-10-05T12:01:00Z')
const PREFS = { targeting: { titles: ['Backend Engineer'], countries: ['US'] } }

const lead = (over: Partial<JobLead> = {}): JobLead => ({
  company: 'Acme', title: 'Senior Backend Engineer', url: 'https://remotive.com/jobs/1', location: 'Remote, USA', salary: null, description: 'Build the platform.',
  source: 'remotive', externalId: 'https://remotive.com/jobs/1', companyDomain: 'acme.com', postedAt: '2026-10-03T00:00:00Z', tags: [], ...over,
})

const acme = { id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', careers_url: null, ats_provider: 'greenhouse', ats_token: 'acme', verified_at: '2026-10-01T00:00:00Z' }

function world(over: { tables?: Record<string, Record<string, unknown>[]>; leads?: JobLead[]; perSource?: Record<string, { found: number; error?: string }>; board?: BoardHit | null } = {}) {
  const { client, tables } = fakeDb(
    {
      profiles: [{ id: 'u1', resume_text: null, preferences: PREFS, is_demo: false, demo_expires_at: null }],
      companies: [], company_suggestions: [], company_suggestion_state: [], applications: [], directory_candidates: [], company_directory: [acme],
      ...over.tables,
    },
    { autoId: ['company_suggestions'] }
  )
  const readBoard = vi.fn(async () => over.board ?? null)
  const deps: RefreshDeps = {
    queryAllSources: vi.fn(async () => ({ leads: over.leads ?? [lead()], perSource: over.perSource ?? { remotive: { found: 1 } } })) as never,
    readBoard,
    now: () => NOW,
  }
  return { client, tables, deps, readBoard }
}

const hit = (title = 'Backend Engineer'): BoardHit => ({ provider: 'greenhouse', token: 'acme', boardUrl: 'https://boards.greenhouse.io/acme', openRoles: 14, jobs: [{ title, location: 'Remote, USA', url: 'https://boards.greenhouse.io/acme/jobs/1', postedAt: '2026-10-04T00:00:00Z' }] })

describe('refreshSuggestionsForUser', () => {
  it('ranks a verified employer with a matching role on its own board first, and reads only verified boards', async () => {
    const w = world({ leads: [lead(), lead({ company: 'Nobody Co', companyDomain: null, externalId: 'n1', url: 'https://remotive.com/jobs/2' })], board: hit() })
    const r = await refreshSuggestionsForUser(w.client, 'u1', w.deps)
    expect(r.status).toBe('ok')
    // a board is read for the one verified employer, never guessed for the other
    expect(w.readBoard).toHaveBeenCalledTimes(1)
    expect(w.readBoard).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', ats_provider: 'greenhouse', ats_token: 'acme' }))
    const rows = w.tables.company_suggestions
    expect(rows.map((s) => [s.name, s.tier, s.user_id])).toEqual([['Acme', 1, 'u1'], ['Nobody Co', 3, 'u1']])
    expect(rows[0]).toMatchObject({ source_label: 'Greenhouse board', status: 'open', ats: { provider: 'greenhouse', openRoles: 14, matchingRoles: 1 } })
    expect(w.tables.company_suggestion_state[0]).toMatchObject({ user_id: 'u1', status: 'ok' })
  })

  it('keeps the posting evidence when a verified board cannot be read, and never makes an employer or a company', async () => {
    const w = world({ board: null })
    await refreshSuggestionsForUser(w.client, 'u1', w.deps)
    expect(w.tables.company_suggestions[0]).toMatchObject({ name: 'Acme', tier: 3 })
    expect(w.tables.company_directory).toHaveLength(1)
    expect(w.tables.companies).toHaveLength(0)
  })

  it('removes open rows that fell out and never touches one the person acted on', async () => {
    const old = (company_key: string, status: string) => ({ id: `s-${company_key}`, user_id: 'u1', company_key, name: company_key, domain: null, tier: 3, rank: 9, reason: 'r', source_url: 'https://x.test', source_label: 'x', signals: [], ats: null, status })
    const w = world({ tables: { company_suggestions: [old('gone.com', 'open'), old('dismissed.com', 'dismissed')] }, board: hit() })
    await refreshSuggestionsForUser(w.client, 'u1', w.deps)
    const keys = w.tables.company_suggestions.map((s) => s.company_key)
    expect(keys).toContain('dismissed.com')
    expect(keys).not.toContain('gone.com')
    expect(w.tables.company_suggestions.find((s) => s.company_key === 'dismissed.com')).toMatchObject({ status: 'dismissed', rank: 9 })
  })

  it('says needs_targeting, and does not read a source, when the person has no role signal', async () => {
    const w = world({ tables: { profiles: [{ id: 'u1', resume_text: null, preferences: {}, is_demo: false, demo_expires_at: null }] } })
    expect((await refreshSuggestionsForUser(w.client, 'u1', w.deps)).status).toBe('needs_targeting')
    expect(w.deps.queryAllSources).not.toHaveBeenCalled()
  })

  it('keeps the old list and says failed when every source failed', async () => {
    const open = { id: 's1', user_id: 'u1', company_key: 'kept.com', name: 'Kept', status: 'open', tier: 3, rank: 1 }
    const w = world({ tables: { company_suggestions: [open] }, perSource: { remotive: { found: 0, error: 'down' }, jobicy: { found: 0, error: 'down' } } })
    expect((await refreshSuggestionsForUser(w.client, 'u1', w.deps)).status).toBe('failed')
    expect(w.tables.company_suggestions).toHaveLength(1)
    expect(w.tables.company_suggestion_state[0]).toMatchObject({ status: 'failed' })
  })
})

describe('refreshDueSuggestions', () => {
  const profile = (id: string, over: Record<string, unknown> = {}) => ({ id, resume_text: null, preferences: PREFS, is_demo: false, demo_expires_at: null, ...over })

  it('refreshes the lists that are due, never-built first, skipping demos and people with no role signal', async () => {
    const { client } = fakeDb({
      profiles: [profile('a'), profile('b'), profile('demo', { is_demo: true }), profile('none', { preferences: {} }), profile('fresh')],
      company_suggestion_state: [{ user_id: 'a', next_refresh_at: '2026-10-04T00:00:00Z' }, { user_id: 'fresh', next_refresh_at: '2026-10-07T00:00:00Z' }],
    })
    const seen: string[] = []
    const r = await refreshDueSuggestions(client, { deadlineAt: LATER, concurrency: 1 }, { refreshUser: async (_db, id) => (seen.push(id), { status: 'ok', stored: 1, counts: {} }), now: () => Date.parse('2026-10-05T12:00:00Z') })
    expect(seen).toEqual(['b', 'a'])
    expect(r).toEqual({ refreshed: 2, failed: 0, skipped: 0 })
  })

  it('starts no one after the deadline and counts the rest as skipped for the next slice', async () => {
    const { client } = fakeDb({ profiles: [profile('a'), profile('b')], company_suggestion_state: [] })
    let t = 0
    const r = await refreshDueSuggestions(client, { deadlineAt: 10, concurrency: 1 }, { refreshUser: async () => ({ status: 'ok', stored: 0, counts: {} }), now: () => (t += 4) })
    expect(r).toEqual({ refreshed: 1, failed: 0, skipped: 1 })
  })

  it('counts a person who throws as failed and carries on', async () => {
    const { client } = fakeDb({ profiles: [profile('a'), profile('b')], company_suggestion_state: [] })
    const r = await refreshDueSuggestions(client, { deadlineAt: LATER, concurrency: 1 }, {
      refreshUser: async (_db, id) => {
        if (id === 'a') throw new Error('database')
        return { status: 'ok', stored: 1, counts: {} }
      },
      now: () => 0,
    })
    expect(r).toMatchObject({ refreshed: 1, failed: 1 })
  })
})

describe('hasRoleSignal', () => {
  it('is true with target titles or functions, false with nothing to match roles against', () => {
    expect(hasRoleSignal({ resume_text: null, preferences: PREFS })).toBe(true)
    expect(hasRoleSignal({ resume_text: null, preferences: { targeting: { functions: ['engineering'] } } })).toBe(true)
    expect(hasRoleSignal({ resume_text: null, preferences: {} })).toBe(false)
  })
})

describe('the service-role fence', () => {
  // refresh.ts reads and writes with the service role, which skips row level security: every statement about a person
  // must carry their id, or one person's refresh could read or change another's rows.
  const src = readFileSync(path.join(process.cwd(), 'lib/companies/refresh.ts'), 'utf8')
  const PERSONAL = ['profiles', 'companies', 'company_suggestions', 'company_suggestion_state', 'applications', 'person_jobs']

  it('every query on a personal table is filtered by the person', () => {
    const statements = src.split(/\n(?=\s*(?:const|let|if|await|return)\b)/)
    const personal = statements.filter((s) => PERSONAL.some((t) => new RegExp(`from\\('${t}'\\)`).test(s)))
    expect(personal.length).toBeGreaterThanOrEqual(8)
    for (const s of personal) {
      const isDueRead = /from\('profiles'\)\s*\.select\('id, resume_text, preferences, is_demo, demo_expires_at'\)/.test(s) || /from\('company_suggestion_state'\)\s*\.select\('user_id, next_refresh_at'\)/.test(s)
      // the cron pass reads every profile and every state on purpose: it picks who is due, then refreshes each by id
      if (isDueRead) continue
      expect(s, s.slice(0, 120)).toMatch(/\.eq\('(user_id|viewer_id|id)'|onConflict: 'user_id/)
    }
  })
})
