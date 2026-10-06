import { describe, expect, it, vi } from 'vitest'
import type { DueCompany, UserSummary } from '../../ingest/run'
import type { RoutineContext, RoutineRow } from '../routines'
import { rolesCheck } from './roles-check'

const START = Date.parse('2026-10-08T12:00:00Z')

const company = (id: string, over: Partial<DueCompany> & { metadata?: unknown } = {}): DueCompany & { metadata?: unknown } => ({
  id,
  user_id: 'u1',
  name: `Employer ${id}`,
  domain: `${id}.example`,
  career_url: `https://${id}.example/careers`,
  scrape_frequency: null,
  last_scraped_at: null,
  is_dream_company: false,
  metadata: null,
  ...over,
})

/** A Supabase-shaped fake with the three tables roles.check reads. */
function fakeAdmin(companies: unknown[], opts: { renderOn?: boolean } = {}) {
  return {
    from(table: string) {
      const rows: Record<string, unknown> =
        table === 'companies' ? { data: companies, error: null } : table === 'routines' ? { data: { enabled: opts.renderOn === true }, error: null } : { data: { preferences: {} }, error: null }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        or: () => b,
        order: () => b,
        range: () => Promise.resolve(rows),
        maybeSingle: () => Promise.resolve(rows),
      }
      return b
    },
  } as never
}

function context(admin: never, over: Partial<RoutineContext> = {}): RoutineContext {
  const routine = { id: 'r1', user_id: 'u1', command: 'roles.check' } as RoutineRow
  return { admin, routine, userId: 'u1', state: null, now: () => START, deadlineAt: START + 200_000, ...over }
}

function summary(reached: string[], notReached: string[] = [], over: Partial<UserSummary['patch']> = {}): UserSummary {
  const outcome = (id: string, failure: 'time' | null) => ({
    result: { companyId: id, found: 3, inserted: 1, updated: 0, closed: 0, errors: [] },
    reader: null,
    tier: null,
    skipped: false,
    reading: false,
    failure,
  })
  return {
    runId: null,
    outcomes: [...reached.map((id) => outcome(id, null)), ...notReached.map((id) => outcome(id, 'time'))] as never,
    patch: { status: 'succeeded', jobs_found: reached.length * 3, jobs_new: reached.length, ...over } as never,
  }
}

describe('roles.check', () => {
  it('reads the due employers of the person, with plain requests, before the slice deadline', async () => {
    const ingest = vi.fn(async () => summary(['a', 'b']))
    const out = await rolesCheck(context(fakeAdmin([company('a'), company('b')])), { ingest })
    expect(out.ok).toBe(true)
    expect(out.next).toBeUndefined()
    expect(out.found).toMatchObject({ employers: 2, read: 2, roles: 6, new: 2 })
    const [userId, due, deps] = ingest.mock.calls[0] as unknown as [string, DueCompany[], Record<string, unknown>]
    expect(userId).toBe('u1')
    expect(due.map((c) => c.id)).toEqual(['a', 'b'])
    expect(deps.mode).toBe('inline')
    expect(deps.model).toBeNull()
    expect(deps.deadlineAt).toBe(START + 200_000)
    expect(START + 200_000 - START).toBeLessThan(240_000)
  })

  it('stops before 240 seconds and posts what is left: employers not reached go to the next slice, those read are not read again', async () => {
    const ingest = vi.fn(async () => summary(['a', 'b'], ['c', 'd']))
    const first = await rolesCheck(context(fakeAdmin([company('a'), company('b'), company('c'), company('d')])), { ingest })
    expect(first.ok).toBe(true)
    expect(first.next).toMatchObject({ done: ['a', 'b'] })

    // The next slice starts from that state: a and b are not read again, even though the fixture still lists them as due.
    const ingest2 = vi.fn(async () => summary(['c', 'd']))
    const second = await rolesCheck(context(fakeAdmin([company('a'), company('b'), company('c'), company('d')]), { state: first.next as Record<string, unknown> }), { ingest: ingest2 })
    const due = (ingest2.mock.calls[0] as unknown as [string, DueCompany[]])[1]
    expect(due.map((c) => c.id)).toEqual(['c', 'd'])
    expect(second.next).toBeUndefined()
    expect(second.found).toMatchObject({ read: 4, roles: 12 })
  })

  it('does not read an employer that is not due yet, or has nothing to read', async () => {
    const ingest = vi.fn(async () => summary(['due']))
    const fresh = company('fresh', { last_scraped_at: new Date(START - 60 * 60_000).toISOString() })
    const nothing = company('none', { career_url: null })
    await rolesCheck(context(fakeAdmin([company('due'), fresh, nothing])), { ingest })
    expect((ingest.mock.calls[0] as unknown as [string, DueCompany[]])[1].map((c) => c.id)).toEqual(['due'])
  })

  it('leaves the sites that need a browser to the dispatched run once that is on, and reads them itself while it is off', async () => {
    const reading = company('browser', { metadata: { source_check: { checked_at: '2026-10-08T06:00:00Z', readable: false, reason: 'reading' } } })
    const off = vi.fn(async () => summary(['browser', 'a']))
    await rolesCheck(context(fakeAdmin([reading, company('a')], { renderOn: false })), { ingest: off })
    expect((off.mock.calls[0] as unknown as [string, DueCompany[]])[1].map((c) => c.id)).toEqual(['browser', 'a'])

    const on = vi.fn(async () => summary(['a']))
    await rolesCheck(context(fakeAdmin([reading, company('a')], { renderOn: true })), { ingest: on })
    expect((on.mock.calls[0] as unknown as [string, DueCompany[]])[1].map((c) => c.id)).toEqual(['a'])
  })

  it('succeeds without reading anything when nothing is due', async () => {
    const ingest = vi.fn()
    const out = await rolesCheck(context(fakeAdmin([])), { ingest })
    expect(out).toMatchObject({ ok: true, found: { employers: 0 } })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('fails when every employer failed, which is not the same as nothing new', async () => {
    const ingest = vi.fn(async () => summary(['a'], [], { status: 'failed' }))
    const out = await rolesCheck(context(fakeAdmin([company('a')])), { ingest })
    expect(out).toMatchObject({ ok: false, failure: 'every_employer_failed' })
  })

  it('has nothing to do without a person', async () => {
    expect(await rolesCheck(context(fakeAdmin([]), { userId: null }))).toEqual({ ok: false, failure: 'no_user' })
  })
})
