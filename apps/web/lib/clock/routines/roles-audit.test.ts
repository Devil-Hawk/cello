import { describe, expect, it } from 'vitest'
import { EMPTY_TARGETING } from '../../targeting'
import { fakeDb } from '../../companies/fake-db'
import type { RoutineContext, RoutineRow } from '../routines'
import { HANDLERS } from './index'
import { AUDIT_CAP, auditPerson, rolesAudit } from './roles-audit'

const START = Date.parse('2026-10-22T04:30:00Z')
const day = 86_400_000

const job = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  description: 'Build things.',
  location: null,
  salary_range: null,
  job_function: 'engineering',
  seniority: 'senior',
  country: 'US',
  language: 'en',
  is_remote: null,
  posted_at: new Date(Date.now() - 2 * day).toISOString(),
  employer_id: 'e1',
  company_id: null,
  title_norm: null,
  role_type: null,
  employer: { name: 'Acme' },
  ...over,
})
const held = (user: string, id: string, jobs: ReturnType<typeof job>, over: Record<string, unknown> = {}) => ({ user_id: user, job_id: id, saved_at: null, hidden_reason: null, targets_version: 1, jobs, ...over })

const context = (admin: unknown, over: Partial<RoutineContext> = {}): RoutineContext => ({
  admin: admin as never,
  routine: { id: 'r1', user_id: null, command: 'roles.audit' } as RoutineRow,
  userId: null,
  state: null,
  now: () => START,
  deadlineAt: START + 200_000,
  ...over,
})

const seed = () => ({
  profiles: [
    { id: 'a', is_demo: false, demo_expires_at: null, preferences: { targeting: { countries: ['us'] } }, targets_version: 2 },
    { id: 'b', is_demo: false, demo_expires_at: null, preferences: {}, targets_version: 0 },
    { id: 'd', is_demo: true, demo_expires_at: '2020-01-01T00:00:00Z', preferences: { targeting: { countries: ['us'] } }, targets_version: 1 },
  ],
  person_roles: [
    held('a', 'j1', job('Platform Engineer')),
    held('a', 'j2', job('Staff Engineer', { country: 'DE' })),
    held('a', 'j3', job('Backend Engineer', { posted_at: '2026-01-01T00:00:00.000Z' })),
    held('a', 'j4', job('Infra Engineer', { country: 'DE' }), { saved_at: '2026-10-01T00:00:00Z' }),
    held('a', 'j5', job('SRE', { country: 'DE' })),
    held('a', 'j6', job('Data Engineer', { country: 'DE' }), { hidden_reason: 'not_for_me' }),
    held('b', 'j7', job('Engineer', { country: 'DE' })),
  ],
  applications: [{ user_id: 'a', job_id: 'j5' }],
  person_jobs: [],
  judge_audit: [],
})

describe('roles.audit', () => {
  it('is a routine the clock can run', () => {
    expect(HANDLERS['roles.audit']).toBe(rolesAudit)
  })

  it('writes one row per person with targets: the shown roles looked at, how many are outside, and why', async () => {
    const { client, tables } = fakeDb(seed())
    const out = await rolesAudit(context(client))
    expect(out).toEqual({ ok: true, found: { people: 1, rows: 3, outside: 2 } })
    // j4 is saved, j5 is applied to, j6 is set aside: the person's own, not audited. b has no targets, d is a demo.
    expect(tables.judge_audit).toEqual([{ user_id: 'a', rows: 3, outside: 2, by_reason: { place: 1, age: 1 } }])
  })

  it('stops before the deadline and hands on where it was, and the next slice carries on without repeating', async () => {
    const { client, tables } = fakeDb(seed())
    // the clock moves one millisecond per look: person a is audited, b has nothing to audit, and d is past the deadline
    let ticks = 0
    const first = await rolesAudit(context(client, { now: () => START + ticks++, deadlineAt: START + 3 }))
    expect(first).toEqual({ ok: true, next: { after: 'b', people: 1, rows: 3, outside: 2 } })
    expect(tables.judge_audit).toHaveLength(1)
    const second = await rolesAudit(context(client, { state: first.next as Record<string, unknown> }))
    expect(second).toEqual({ ok: true, found: { people: 1, rows: 3, outside: 2 } })
    expect(tables.judge_audit).toHaveLength(1)
  })

  describe('the numbers it promises', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => held('a', `j${String(i).padStart(5, '0')}`, job('Platform Engineer')))
    const targets = { targeting: { ...EMPTY_TARGETING, countries: ['US'] }, titles: [] }
    const reads = (queries: { table: string; op: string }[]) => queries.filter((q) => q.table === 'person_roles' && q.op === 'select').length

    it('reads pages of 100', async () => {
      const { client, queries } = fakeDb({ person_roles: many(250), applications: [], person_jobs: [] })
      expect((await auditPerson(client as never, 'a', targets)).rows).toBe(250)
      expect(reads(queries)).toBe(3)
    })

    it('stops at the cap it is given, exactly, even in the middle of a page', async () => {
      const { client } = fakeDb({ person_roles: many(250), applications: [], person_jobs: [] })
      expect((await auditPerson(client as never, 'a', targets, 150)).rows).toBe(150)
    })

    it('stops a person at 2000 roles', async () => {
      expect(AUDIT_CAP).toBe(2000)
      const { client } = fakeDb({ person_roles: many(2100), applications: [], person_jobs: [] })
      expect((await auditPerson(client as never, 'a', targets)).rows).toBe(2000)
    })
  })
})
