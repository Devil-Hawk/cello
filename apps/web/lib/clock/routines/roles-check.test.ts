import { describe, expect, it, vi } from 'vitest'
import type { DueCompany, UserSummary } from '../../ingest/run'
import type { RoutineContext, RoutineRow } from '../routines'
import { rejudgeHeldRoles, rolesCheck } from './roles-check'
import { EMPTY_TARGETING } from '../../targeting'

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

interface DirectoryRow {
  id: string
  title: string
  job_function?: string | null
  seniority?: string | null
  country?: string | null
  language?: string | null
  is_remote?: boolean | null
  posted_at?: string | null
  employer_name?: string | null
}

/** A Supabase-shaped fake with the tables roles.check reads, and the two directory functions. */
function fakeAdmin(
  companies: unknown[],
  opts: { renderOn?: boolean; preferences?: unknown; targetsVersion?: number; heldVersion?: number; directory?: DirectoryRow[]; lastOk?: string } = {}
) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = []
  const admin = {
    from(table: string) {
      const rows: Record<string, unknown> =
        table === 'companies'
          ? { data: companies, error: null }
          : table === 'routines'
            ? { data: { enabled: opts.renderOn === true }, error: null }
            : table === 'person_roles'
              ? { data: opts.heldVersion === undefined ? null : { targets_version: opts.heldVersion }, error: null }
              : table === 'job_heartbeats'
                ? { data: opts.lastOk ? { succeeded_at: opts.lastOk } : null, error: null }
                : { data: { preferences: opts.preferences ?? {}, targets_version: opts.targetsVersion ?? 0 }, error: null }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        lt: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        range: () => Promise.resolve(rows),
        maybeSingle: () => Promise.resolve(rows),
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      return { data: name === 'directory_roles_for' ? (opts.directory ?? []) : 1, error: null }
    },
  }
  return Object.assign(admin, { rpcs }) as unknown as RoutineContext['admin'] & { rpcs: typeof rpcs }
}

function context(admin: RoutineContext['admin'], over: Partial<RoutineContext> = {}): RoutineContext {
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

  describe('the directory match', () => {
    const TARGETS = { targeting: { functions: ['engineering'], countries: ['US'] } }
    const dir = (id: string, title: string, over: Partial<DirectoryRow> = {}): DirectoryRow => ({
      id,
      title,
      job_function: 'engineering',
      country: 'US',
      employer_name: 'Overlap Co',
      posted_at: new Date(START - 86_400_000).toISOString(),
      ...over,
    })

    it('gives a new person the stored roles that fit their targets, in one immediate check, and leaves the rest', async () => {
      const admin = fakeAdmin([], {
        preferences: TARGETS,
        targetsVersion: 1,
        directory: [dir('j1', 'Platform Engineer'), dir('j2', 'Account Executive', { job_function: 'sales' }), dir('j3', 'Staff Engineer', { country: 'DE' }), dir('j4', 'Data Platform Engineer', { country: null })],
      })
      const out = await rolesCheck(context(admin), { ingest: vi.fn() })
      expect(out.ok).toBe(true)
      expect(out.found).toMatchObject({ matched: 2, offered: 4 })
      const call = admin.rpcs.find((r) => r.name === 'add_person_roles')
      // j1 fits; j4 has no country, so nothing disagrees but it is hidden; sales and Germany are left out
      expect(call?.args).toMatchObject({ p_user: 'u1', p_job_ids: ['j1', 'j4'], p_hidden: ['j4'], p_targets_version: 1 })
      // never held before: every stored role was looked at
      expect(admin.rpcs.find((r) => r.name === 'directory_roles_for')?.args).toMatchObject({ p_user: 'u1', p_since: null })
    })

    it('after the first pass looks only at roles stored since the last successful check', async () => {
      const admin = fakeAdmin([], { preferences: TARGETS, targetsVersion: 1, heldVersion: 1, lastOk: '2026-10-08T06:00:00Z', directory: [] })
      await rolesCheck(context(admin), { ingest: vi.fn() })
      expect(admin.rpcs.find((r) => r.name === 'directory_roles_for')?.args.p_since).toBe('2026-10-08T05:00:00.000Z')
    })

    it('looks at everything again when the targets changed since the roles were kept', async () => {
      const admin = fakeAdmin([], { preferences: TARGETS, targetsVersion: 3, heldVersion: 2, lastOk: '2026-10-08T06:00:00Z', directory: [] })
      await rolesCheck(context(admin), { ingest: vi.fn() })
      expect(admin.rpcs.find((r) => r.name === 'directory_roles_for')?.args.p_since).toBeNull()
    })

    it('matches nothing for a person with no targets, and gives nothing', async () => {
      const admin = fakeAdmin([], { preferences: {}, directory: [dir('j1', 'Platform Engineer')] })
      const out = await rolesCheck(context(admin), { ingest: vi.fn() })
      expect(admin.rpcs).toEqual([])
      expect(out.found).toMatchObject({ matched: 0 })
    })

    it('does not fail the check when the match cannot run, and says so', async () => {
      const admin = fakeAdmin([], { preferences: TARGETS, directory: [] })
      ;(admin as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { code: '42883' } })
      const out = await rolesCheck(context(admin), { ingest: vi.fn() })
      expect(out.ok).toBe(true)
      expect(out.found).toMatchObject({ match_failed: true })
    })
  })

  it('has nothing to do without a person', async () => {
    expect(await rolesCheck(context(fakeAdmin([]), { userId: null }))).toEqual({ ok: false, failure: 'no_user' })
  })
})

describe('after a change of targets', () => {
  const job = (title: string, over: Record<string, unknown> = {}) => ({
    title,
    job_function: 'engineering',
    seniority: null,
    country: 'US',
    language: null,
    is_remote: null,
    posted_at: new Date(START - 86_400_000).toISOString(),
    employer_id: 'emp-1',
    company_id: 'co-1',
    companies: { name: 'Overlap Co' },
    ...over,
  })
  interface Held { job_id: string; saved_at: string | null; hidden_reason: string | null; targets_version: number; jobs: ReturnType<typeof job> }

  /** The person_roles, applications and set_person_counts the re-judge touches, in memory. */
  function store(held: Held[], appliedTo: string[] = []) {
    const rpcs: { name: string; args: Record<string, any> }[] = []
    const admin = {
      from(table: string) {
        const filters: ((r: any) => boolean)[] = []
        let op: 'select' | 'delete' | 'update' = 'select'
        let patch: Record<string, unknown> = {}
        const b: any = {
          select: () => b,
          delete: () => ((op = 'delete'), b),
          update: (p: Record<string, unknown>) => ((op = 'update'), (patch = p), b),
          eq: (c: string, v: unknown) => (filters.push((r) => c === 'user_id' || r[c] === v), b),
          in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
          lt: (c: string, v: number) => (filters.push((r) => r[c] < v), b),
          order: () => b,
          limit: () => b,
          then(resolve: (v: unknown) => void) {
            if (table === 'applications') return resolve({ data: appliedTo.map((job_id) => ({ job_id })), error: null })
            const hit = held.filter((r) => filters.every((f) => f(r)))
            if (op === 'delete') for (const r of hit) held.splice(held.indexOf(r), 1)
            if (op === 'update') for (const r of hit) Object.assign(r, patch)
            resolve({ data: op === 'select' ? hit.slice(0, 100) : null, error: null })
          },
        }
        return b
      },
      rpc: async (name: string, args: Record<string, any>) => (rpcs.push({ name, args }), { data: 1, error: null }),
    }
    return { admin: admin as unknown as RoutineContext['admin'], rpcs, held }
  }

  const targets = (over: Record<string, unknown> = {}) => ({
    targeting: { ...EMPTY_TARGETING, countries: ['US'], ...over },
    titles: [],
    version: 2,
  })
  const row = (id: string, over: Partial<Held> = {}): Held => ({ job_id: id, saved_at: null, hidden_reason: null, targets_version: 1, jobs: job(id), ...over })

  it('removes and counts a held role now outside, and keeps a saved one, an applied one and one the person set aside', async () => {
    const { admin, rpcs, held } = store(
      [
        row('gone', { jobs: job('Engineer', { country: 'DE' }) }),
        row('saved', { jobs: job('Engineer', { country: 'DE' }), saved_at: '2026-10-01T00:00:00Z' }),
        row('applied', { jobs: job('Engineer', { country: 'DE' }) }),
        row('aside', { jobs: job('Engineer', { country: 'DE' }), hidden_reason: 'not_for_me' }),
        row('inside'),
      ],
      ['applied']
    )
    const out = await rejudgeHeldRoles(admin, 'u1', targets(), () => START, START + 200_000)
    expect(out).toEqual({ checked: 5, removed: 1 })
    expect(held.map((r) => r.job_id).sort()).toEqual(['applied', 'aside', 'inside', 'saved'])
    expect(held.every((r) => r.targets_version === 2)).toBe(true)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].args.p_rows).toEqual([{ employer_id: 'emp-1', company_id: null, kind: 'outside_targets', reason: 'place', n: 1 }])
  })

  it('drops an excluded-company role the sweep stored with no company, named by its employer', async () => {
    const { admin, held } = store([
      row('owned', { jobs: job('Engineer') }),
      row('swept', { jobs: { ...job('Engineer'), company_id: null, companies: null, employer: { name: 'Overlap Co' } } as never }),
      row('other', { jobs: { ...job('Engineer'), company_id: null, companies: null, employer: { name: 'Fine Inc' } } as never }),
    ])
    const out = await rejudgeHeldRoles(admin, 'u1', targets({ excludedCompanies: ['overlap'] }), () => START, START + 200_000)
    expect(out).toEqual({ checked: 3, removed: 2 })
    expect(held.map((r) => r.job_id)).toEqual(['other'])
  })

  it('leaves roles already under the current version alone, and does nothing for a person with no saved targets', async () => {
    const { admin, held } = store([row('a', { targets_version: 2, jobs: job('Engineer', { country: 'DE' }) })])
    expect(await rejudgeHeldRoles(admin, 'u1', targets(), () => START, START + 200_000)).toEqual({ checked: 0, removed: 0 })
    expect(held).toHaveLength(1)
    expect(await rejudgeHeldRoles(admin, 'u1', { ...targets(), version: 0 }, () => START, START + 200_000)).toEqual({ checked: 0, removed: 0 })
  })

  it('does not drop a role when the person has stated nothing, and moves it to the new version', async () => {
    const { admin, held } = store([row('a', { jobs: job('Engineer', { country: 'DE' }) })])
    const none = { targeting: EMPTY_TARGETING, titles: [], version: 2 }
    expect(await rejudgeHeldRoles(admin, 'u1', none, () => START, START + 200_000)).toEqual({ checked: 1, removed: 0 })
    expect(held).toMatchObject([{ job_id: 'a', targets_version: 2 }])
  })
})

