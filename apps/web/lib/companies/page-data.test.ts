import { describe, expect, it } from 'vitest'
import { fakeDb } from './fake-db'
import { companiesPage, companyPage, companyRoles } from './page-data'

// The SQL (companies_page, company_page, company_roles) is proved by the self-check at the end of
// 20261021000100_companies_contract.sql: closed hidden from everyone else but never from a follow, the type filter,
// the search. These tests prove what this file does with the rows: the contract, the header, null and never 0.

const NOW = new Date('2026-10-21T12:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

const sql = (over: Record<string, unknown> = {}) => ({
  employer_id: 'e1', name: 'Retell AI', domain: 'retellai.com', logo_url: 'https://logo/retell.png', hq: 'San Francisco', source: 'seed',
  open_count: 12, open_count_at: hoursAgo(3), last_read_at: hoursAgo(3), next_read_at: hoursAgo(-21), failed_reads: 0, cannot_read_reason: null,
  closed: false, following: false, is_dream: false, role_types: ['ai-engineer', 'other'], ...over,
})

function setup(rows: Record<string, unknown>[], seed: Record<string, Record<string, unknown>[]> = {}, o: { ready?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  const { client } = fakeDb(seed, {
    rpc: {
      companies_page: (a) => (calls.push(a), rows),
      company_page: (a) => (calls.push(a), rows),
      company_roles: (a) => (calls.push(a), rows),
      background_ready: () => o.ready ?? true,
      directory_progress: () => [{ verified: 1200, pending: 30000, failed: 40 }],
    },
  })
  return { client, calls }
}

describe('companiesPage', () => {
  it('maps a row to the contract: foundBy from the source, role types, nothing from Roles yet', async () => {
    const { client } = setup([sql(), sql({ employer_id: 'e2', name: 'Mine', source: 'person', following: true, is_dream: true, hq: null })])
    const { rows } = await companiesPage(client, 'u1', { now: NOW })
    expect(rows[0]).toEqual({
      employerId: 'e1', name: 'Retell AI', domain: 'retellai.com', logoUrl: 'https://logo/retell.png', hq: 'San Francisco', foundBy: 'cello',
      openCount: 12, openCountAt: hoursAgo(3), checked: { at: hoursAgo(3), ok: true }, nextReadAt: hoursAgo(-21), closed: false,
      keptForYou: null, topForYou: null, following: false, isDream: false, roleTypes: ['ai-engineer', 'other'],
    })
    expect(rows[1]).toMatchObject({ foundBy: 'person', following: true, isDream: true, hq: null })
  })

  it('asks for the first 50 without closed employers, and passes the filters through', async () => {
    const { client, calls } = setup([])
    await companiesPage(client, 'u1', { now: NOW })
    await companiesPage(client, 'u1', { type: 'ai-engineer', showClosed: true, limit: 20, offset: 40, now: NOW })
    expect(calls[0]).toEqual({ p_user: 'u1', p_type: null, p_with_roles: false, p_show_closed: false, p_limit: 50, p_offset: 0 })
    expect(calls[1]).toEqual({ p_user: 'u1', p_type: 'ai-engineer', p_with_roles: false, p_show_closed: true, p_limit: 20, p_offset: 40 })
  })

  it('a cannot-read employer has no count and says why; it never reads as 0 open', async () => {
    const { client } = setup([
      sql({ employer_id: 'a', open_count: 12, cannot_read_reason: 'cannot_read', failed_reads: 3 }),
      sql({ employer_id: 'b', open_count: 7, failed_reads: 1 }),
      sql({ employer_id: 'c', open_count: null, open_count_at: null, last_read_at: null, next_read_at: null }),
    ])
    const [gone, retrying, unread] = (await companiesPage(client, 'u1', { now: NOW })).rows
    expect(gone).toMatchObject({ openCount: null, openCountAt: null, closed: false, checked: { at: hoursAgo(3), ok: false, reason: 'cannot_read' } })
    // one miss: the last good count still stands with its own time, and the last read is marked as failed
    expect(retrying).toMatchObject({ openCount: 7, openCountAt: hoursAgo(3), checked: { ok: false, reason: 'cannot_read' } })
    // never read: no count and no check
    expect(unread).toMatchObject({ openCount: null, checked: null })
  })

  it('a closed board has no count and keeps the reason it left for', async () => {
    const { client } = setup([sql({ closed: true, cannot_read_reason: 'stale', next_read_at: null })])
    expect((await companiesPage(client, 'u1', { now: NOW })).rows[0]).toMatchObject({ closed: true, openCount: null, nextReadAt: null, checked: { ok: false, reason: 'stale' } })
  })

  it('the header counts what the directory and the clock hold', async () => {
    const dir = (id: string, source: string, days: number, verified = true) => ({ id, source, created_at: ago(days), verified_at: verified ? ago(days) : null })
    const { client } = setup([], {
      company_directory: [dir('a', 'seed', 2), dir('b', 'yc', 6), dir('c', 'person', 1), dir('d', 'seed', 20), dir('e', 'seed', 1, false)],
      companies: [
        { id: '1', user_id: 'u1', employer_id: 'a', watching: true },
        { id: '2', user_id: 'u1', employer_id: 'b', watching: true },
        { id: '3', user_id: 'u1', employer_id: 'c', watching: false },
        { id: '4', user_id: 'u1', employer_id: null, watching: true },
        { id: '5', user_id: 'u2', employer_id: 'a', watching: true },
      ],
      routines: [{ command: 'directory.sweep', user_id: null, next_due_at: hoursAgo(-1), enabled: true }],
      job_heartbeats: [{ job: 'directory.sweep', user_id: null, succeeded_at: hoursAgo(2), next_due_at: hoursAgo(-1), found: { boards: 40 }, failure: null }],
    })
    const { header } = await companiesPage(client, 'u1', { now: NOW })
    expect(header).toMatchObject({ foundByCelloThisWeek: 2, following: 2, backgroundOff: false, paced: false, seedProgress: { verified: 1200, pending: 30000, failed: 40 } })
    expect(header.checked).toMatchObject({ lastSucceededAt: hoursAgo(2), nextDueAt: hoursAgo(-1), missed: false, found: { boards: 40 } })
  })

  it('the header says a check is missed, background work off, and the allowance used', async () => {
    const { client } = setup([], {
      routines: [{ command: 'directory.sweep', user_id: null, next_due_at: hoursAgo(5), enabled: true }],
      job_heartbeats: [{ job: 'directory.sweep', user_id: null, succeeded_at: hoursAgo(9), next_due_at: hoursAgo(5), found: {}, failure: null }],
      clock_meter: [{ month: '2026-10-01', duration_ms: 9e12 }],
    }, { ready: false })
    const { header } = await companiesPage(client, 'u1', { now: NOW })
    expect(header).toMatchObject({ backgroundOff: true, paced: true, foundByCelloThisWeek: 0, following: 0 })
    expect(header.checked.missed).toBe(true)
    expect(header.checked.missedText).toMatch(/^Missed at \d\d:\d\d\. Cello is retrying\.$/)
  })

  it('throws, rather than showing an empty wall, when the database fails', async () => {
    const { client } = fakeDb({}, { rpc: { background_ready: () => true, directory_progress: () => [] } })
    await expect(companiesPage(client, 'u1', { now: NOW })).rejects.toThrow('could not read the companies')
  })
})

describe('companyPage', () => {
  const page = (over: Record<string, unknown> = {}) => ({
    ...sql(), careers_url: 'https://jobs.ashbyhq.com/retell', ats_provider: 'ashby', profile: null,
    by_type: [{ role_type: 'ai-engineer', open: 6 }, { role_type: null, open: 6 }],
    kept: [{ id: 'j1', title: 'Forward Deployed Engineer', role_type: 'forward-deployed-engineer', location: 'Remote', url: 'https://x/1', posted_at: ago(2), chance: 'strong' }],
    ...over,
  })

  it('gives the head, the count by type, the roles this person holds, and nothing invented for Roles or insights', async () => {
    const { client, calls } = setup([page()])
    const p = await companyPage(client, 'u1', 'e1')
    expect(calls[0]).toEqual({ p_user: 'u1', p_employer: 'e1' })
    expect(p).toMatchObject({
      employerId: 'e1', name: 'Retell AI', openCount: 12, closed: false, careersUrl: 'https://jobs.ashbyhq.com/retell', provider: 'ashby',
      byType: [{ roleType: 'ai-engineer', open: 6 }, { roleType: null, open: 6 }],
      kept: [{ id: 'j1', title: 'Forward Deployed Engineer', roleType: 'forward-deployed-engineer', chance: 'strong', postedAt: ago(2) }],
      insights: { shared: null, forYou: { topForYou: null, yourTypesCount: null, asks: null } },
    })
    expect(p).not.toHaveProperty('keptForYou')
  })

  it('a board that did not answer says so in words and has no count', async () => {
    const { client } = setup([page({ cannot_read_reason: 'cannot_read', failed_reads: 3 })])
    const p = await companyPage(client, 'u1', 'e1')
    expect(p).toMatchObject({ openCount: null, checked: { ok: false, reason: 'cannot_read', line: 'its job board did not answer' } })
  })

  it('takes the id of the person\'s follow row too, which older links carry', async () => {
    const { client, calls } = setup([page()], { companies: [{ id: 'c1', user_id: 'u1', employer_id: 'e1' }, { id: 'c2', user_id: 'u2', employer_id: 'e9' }] })
    await companyPage(client, 'u1', 'c1')
    await companyPage(client, 'u1', 'c2')
    await companyRoles(client, 'u1', 'c1', '')
    expect(calls.map((c) => c.p_employer)).toEqual(['e1', 'c2', 'e1'])
  })

  it('is null for an employer the directory does not hold', async () => {
    const { client } = setup([])
    expect(await companyPage(client, 'u1', 'nope')).toBeNull()
  })
})

describe('companyRoles', () => {
  it('trims the search and maps the rows, the person\'s own first as the SQL orders them', async () => {
    const { client, calls } = setup([
      { id: 'j1', title: 'Data Engineer', role_type: 'data-engineer', location: 'Paris', url: 'https://x/1', posted_at: ago(1), kept: true, chance: 'possible' },
      { id: 'j2', title: 'Spark Developer', role_type: null, location: null, url: 'https://x/2', posted_at: null, kept: false, chance: null },
    ])
    const hits = await companyRoles(client, 'u1', 'e1', '  spark ')
    expect(calls[0]).toEqual({ p_user: 'u1', p_employer: 'e1', p_q: 'spark' })
    expect(hits).toEqual([
      { id: 'j1', title: 'Data Engineer', roleType: 'data-engineer', location: 'Paris', url: 'https://x/1', postedAt: ago(1), kept: true, chance: 'possible' },
      { id: 'j2', title: 'Spark Developer', roleType: null, location: null, url: 'https://x/2', postedAt: null, kept: false, chance: null },
    ])
  })
})
