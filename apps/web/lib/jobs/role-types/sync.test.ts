import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffRoleTypes, roleTypeRows, syncRoleTypes } from './sync'
import { ROLE_TYPES, TAXONOMY_VERSION } from './taxonomy'

function fakeDb(existing: { id: string }[] = []) {
  const calls: { op: string; table: string; arg: unknown; opts?: unknown }[] = []
  const db = {
    from(table: string) {
      const b: Record<string, unknown> = {
        upsert: (rows: unknown, opts: unknown) => (calls.push({ op: 'upsert', table, arg: rows, opts }), Promise.resolve({ error: null })),
        select: () => b,
        is: () => Promise.resolve({ data: existing, error: null }),
        update: (patch: unknown) => (calls.push({ op: 'update', table, arg: patch }), b),
        in: (col: string, ids: unknown) => (calls.push({ op: 'in', table, arg: { col, ids } }), Promise.resolve({ error: null })),
      }
      return b
    },
  }
  return { db: db as never, calls }
}

describe('role-types:sync', () => {
  it('writes one row per type of the module, and the table then equals the module', async () => {
    const { db, calls } = fakeDb(ROLE_TYPES.map((r) => ({ id: r.id })))
    const out = await syncRoleTypes(db)
    expect(out).toEqual({ written: ROLE_TYPES.length, retired: [] })
    const rows = calls.find((c) => c.op === 'upsert')!.arg as { id: string; taxonomy_version: number }[]
    expect(rows.map((r) => r.id)).toEqual(ROLE_TYPES.map((r) => r.id))
    expect(rows.every((r) => r.taxonomy_version === TAXONOMY_VERSION)).toBe(true)
    expect(diffRoleTypes(rows as never)).toEqual([])
  })

  it('retires a type the module no longer has, and never deletes it', async () => {
    const { db, calls } = fakeDb([...ROLE_TYPES.map((r) => ({ id: r.id })), { id: 'legacy-type' }])
    const out = await syncRoleTypes(db)
    expect(out.retired).toEqual(['legacy-type'])
    expect(calls.find((c) => c.op === 'in')!.arg).toEqual({ col: 'id', ids: ['legacy-type'] })
    expect(calls.some((c) => c.op === 'update' && (c.arg as { retired_at?: string }).retired_at)).toBe(true)
  })

  it('names the ids where the table and the module differ', () => {
    const table = roleTypeRows().map((r) => ({ ...r }))
    expect(diffRoleTypes(table as never)).toEqual([])
    table[0].label = 'Something Else'
    table.pop()
    const extra = [...table, { id: 'old-one', label: 'Old', family: 'engineering', related: [], taxonomy_version: 1 }]
    expect(diffRoleTypes(extra as never)).toEqual([ROLE_TYPES[0].id, ROLE_TYPES[ROLE_TYPES.length - 1].id, 'old-one'].sort())
    // a retired extra is not a difference
    expect(diffRoleTypes([...table.slice(1), { ...table[0], label: ROLE_TYPES[0].label }, { id: 'old-one', label: 'Old', family: 'x', related: [], taxonomy_version: 1, retired_at: '2026-01-01' }, { ...roleTypeRows().pop()! }] as never)).toEqual([])
  })

  it('is what the migration seeds: the table starts equal to the module (a change of one needs the other)', () => {
    // vitest runs with cwd = apps/web
    const sql = readFileSync(path.resolve(process.cwd(), '..', '..', 'supabase', 'migrations', '20261008057000_role_types.sql'), 'utf8')
    const seeded = [...sql.matchAll(/^\s+\('([a-z0-9-]+)', '([^']+)', '([a-z]+)', '\{([^}]*)\}', (\d+)\)/gm)].map((m) => ({
      id: m[1],
      label: m[2],
      family: m[3],
      related: m[4] ? m[4].split(',') : [],
      taxonomy_version: Number(m[5]),
      retired_at: null,
      replaced_by: null,
    }))
    expect(seeded).toEqual(roleTypeRows())
  })

  it('has unique ids, a family on every type, and related ids that exist', () => {
    const ids = ROLE_TYPES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of ROLE_TYPES) {
      expect(r.family).toBeTruthy()
      for (const rel of r.related) expect(ids, `${r.id} -> ${rel}`).toContain(rel)
    }
  })
})
