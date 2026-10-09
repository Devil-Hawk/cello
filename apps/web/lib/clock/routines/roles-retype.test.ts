import { describe, expect, it } from 'vitest'
import { TAXONOMY_VERSION } from '../../jobs/role-types'
import type { RoutineContext, RoutineRow } from '../routines'
import { mapTitlesToTypes, rolesRetype } from './roles-retype'

const START = Date.parse('2026-10-08T12:00:00Z')

interface Job {
  id: string
  title: string
}
interface Person {
  id: string
  preferences: Record<string, unknown> | null
}

/** jobs and profiles in memory: a role leaves the pending list once apply_title_types has seen it, a person once their targeting has role_types. */
function fakeAdmin(jobs: Job[], people: Person[]) {
  const pending = [...jobs]
  const applied: Record<string, unknown>[] = []
  const updates: { id: string; preferences: Record<string, any> }[] = []
  const selects: string[] = []
  const admin = {
    from(table: string) {
      const filters: string[] = []
      const b: Record<string, unknown> = {
        select: () => (selects.push(table), b),
        or: (f: string) => (filters.push(f), b),
        not: () => b,
        is: () => b,
        order: () => b,
        limit: (n: number) => {
          const rows = table === 'jobs' ? pending.slice(0, n) : people.filter((p) => p.preferences?.targeting && (p.preferences.targeting as Record<string, unknown>).role_types === undefined).slice(0, n)
          return Promise.resolve({ data: rows, error: null })
        },
        update: (patch: { preferences: Record<string, any> }) => {
          const chain = {
            eq: (_c: string, id: string) => {
              updates.push({ id, preferences: patch.preferences })
              const p = people.find((x) => x.id === id)!
              p.preferences = patch.preferences
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
      }
      return b
    },
    rpc: async (name: string, args: { p_rows: { id: string }[] }) => {
      expect(name).toBe('apply_title_types')
      applied.push(...args.p_rows)
      for (const r of args.p_rows) pending.splice(pending.findIndex((j) => j.id === r.id), 1)
      return { data: args.p_rows.length, error: null }
    },
  }
  return { admin: admin as unknown as RoutineContext['admin'], applied, updates, selects }
}

function context(admin: RoutineContext['admin'], over: Partial<RoutineContext> = {}): RoutineContext {
  return { admin, routine: { id: 'r', user_id: null, command: 'roles.retype' } as RoutineRow, userId: null, state: null, now: () => START, deadlineAt: START + 200_000, ...over }
}

describe('roles.retype', () => {
  it('types every stored role by code, and an untyped one records the version it was tried under', async () => {
    const { admin, applied } = fakeAdmin([{ id: 'j1', title: 'Sr. Forward Deployed Engineer - NYC (Hybrid)' }, { id: 'j2', title: 'Zookeeper' }], [])
    const out = await rolesRetype(context(admin))
    expect(out).toEqual({ ok: true, found: { typed: 2, mapped: 0 } })
    expect(applied[0]).toMatchObject({ id: 'j1', title_norm: 'forward deployed engineer', role_type: 'forward-deployed-engineer', type_origin: 'code', type_prov: { rule: 'synonym', taxonomy_version: TAXONOMY_VERSION } })
    expect(applied[1]).toMatchObject({ id: 'j2', title_norm: 'zookeeper', role_type: null, type_origin: null, type_prov: { taxonomy_version: TAXONOMY_VERSION } })
  })

  it('maps old target titles to at most 8 types, most titles first, and marks the mapping for review', async () => {
    const people: Person[] = [
      { id: 'p1', preferences: { api_keys: { x: 1 }, targeting: { countries: ['US'], functions: ['sales'], titles: ['Backend Engineer', 'Back-End Developer', 'Data Scientist', 'AI Engineer', 'Zookeeper'] } } },
      { id: 'p2', preferences: { targeting: { countries: ['US'] } } },
      { id: 'p3', preferences: { targeting: { titles: ['Zookeeper', 'Lead'] } } },
      { id: 'p4', preferences: null },
    ]
    const { admin, updates } = fakeAdmin([], people)
    const out = await rolesRetype(context(admin))
    expect(out).toEqual({ ok: true, found: { typed: 0, mapped: 1 } })
    const p1 = updates.find((u) => u.id === 'p1')!.preferences
    expect(p1.targeting).toMatchObject({ role_types: ['backend-engineer', 'data-scientist', 'ai-engineer'], role_types_review: true, functions: ['engineering', 'data'], countries: ['US'] })
    expect(p1.api_keys).toEqual({ x: 1 })
    // no titles, or titles that map to nothing: types stay empty, no review, the old filter keeps deciding
    expect(updates.find((u) => u.id === 'p2')!.preferences.targeting).toEqual({ countries: ['US'], role_types: [] })
    expect(updates.find((u) => u.id === 'p3')!.preferences.targeting).toEqual({ titles: ['Zookeeper', 'Lead'], role_types: [] })
    expect(updates.some((u) => u.id === 'p4')).toBe(false)
  })

  it('stops before the deadline and hands on what it counted, then carries on from there', async () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `j${i}`, title: 'Software Engineer' }))
    const { admin, applied } = fakeAdmin(many, [])
    let now = START
    const first = await rolesRetype(context(admin, { now: () => (now += 40_000), deadlineAt: START + 100_000 }))
    expect(first.ok).toBe(true)
    expect(first.next).toMatchObject({ typed: expect.any(Number) })
    expect(first.found).toBeUndefined()
    expect(applied.length).toBeLessThan(450)

    const second = await rolesRetype(context(admin, { state: first.next as Record<string, unknown> }))
    expect(second.next).toBeUndefined()
    expect(second.found).toMatchObject({ typed: 450 })
  })

  it('fails with a class of failure, never a message from the database', async () => {
    const admin = { from: () => ({ select: () => ({ or: () => ({ or: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'secret detail' } }) }) }) }) }) }) }
    expect(await rolesRetype(context(admin as never))).toEqual({ ok: false, failure: 'list_roles' })
  })
})

describe('mapTitlesToTypes', () => {
  it('takes the type with the most titles first and caps at 8', () => {
    expect(mapTitlesToTypes(['Backend Engineer', 'Back-End Developer', 'AI Engineer'])).toEqual(['backend-engineer', 'ai-engineer'])
    const eleven = ['AI Engineer', 'ML Engineer', 'Data Scientist', 'Data Engineer', 'Backend Engineer', 'Frontend Engineer', 'Mobile Engineer', 'Platform Engineer', 'Security Engineer', 'Product Manager', 'Product Designer']
    expect(mapTitlesToTypes(eleven)).toHaveLength(8)
    expect(mapTitlesToTypes(['Zookeeper', 'Lead', ''])).toEqual([])
  })
})
