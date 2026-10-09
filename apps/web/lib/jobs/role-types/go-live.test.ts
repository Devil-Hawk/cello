import { describe, expect, it } from 'vitest'
import { setRoleTypesLive } from './go-live'

const OWNER = 'owner-1'
const env = { OWNER_USER_ID: OWNER }

function fakeDb(s2: { passed: boolean | null; ran_at: string } | null, writeError = false) {
  const upserts: Record<string, unknown>[] = []
  const db = {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: table === 'measure_runs' ? s2 : null, error: null }),
        upsert: (row: Record<string, unknown>) => (upserts.push(row), Promise.resolve({ error: writeError ? { message: 'x' } : null })),
      }
      return b
    },
  }
  return { db: db as never, upserts }
}

describe('role-types:go-live', () => {
  it('refuses anyone but the owner, and everyone when no owner is set', async () => {
    const { db, upserts } = fakeDb({ passed: true, ran_at: '2026-10-01' })
    expect((await setRoleTypesLive(db, { owner: 'someone-else', on: true, env })).ok).toBe(false)
    expect((await setRoleTypesLive(db, { owner: OWNER, on: true, env: {} })).ok).toBe(false)
    expect((await setRoleTypesLive(db, { owner: null, on: false, env })).ok).toBe(false)
    expect(upserts).toEqual([])
  })

  it('refuses without a passing S2 run on the owner\'s labels', async () => {
    const none = fakeDb(null)
    expect(await setRoleTypesLive(none.db, { owner: OWNER, on: true, env })).toMatchObject({ ok: false, message: expect.stringContaining('no run') })
    const failing = fakeDb({ passed: false, ran_at: '2026-10-01' })
    expect(await setRoleTypesLive(failing.db, { owner: OWNER, on: true, env })).toMatchObject({ ok: false, message: expect.stringContaining('0.95') })
    const unjudged = fakeDb({ passed: null, ran_at: '2026-10-01' })
    expect((await setRoleTypesLive(unjudged.db, { owner: OWNER, on: true, env })).ok).toBe(false)
    expect(none.upserts.length + failing.upserts.length + unjudged.upserts.length).toBe(0)
  })

  it('turns it on after a passing run, and turning it off needs no run', async () => {
    const pass = fakeDb({ passed: true, ran_at: '2026-10-01' })
    expect(await setRoleTypesLive(pass.db, { owner: OWNER, on: true, env })).toEqual({ ok: true, message: 'role_types_live is on.' })
    expect(pass.upserts[0]).toMatchObject({ key: 'role_types_live', on: true, set_by: OWNER })
    const off = fakeDb(null)
    expect((await setRoleTypesLive(off.db, { owner: OWNER, on: false, env })).ok).toBe(true)
    expect(off.upserts[0]).toMatchObject({ key: 'role_types_live', on: false })
  })

  it('says so when the switch could not be written', async () => {
    const { db } = fakeDb({ passed: true, ran_at: '2026-10-01' }, true)
    expect((await setRoleTypesLive(db, { owner: OWNER, on: true, env })).ok).toBe(false)
  })
})
