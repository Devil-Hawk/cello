// /api/taste and /api/taste/[id]: read and change with the persons own session. Row rules do the
// owner check, so these tests stand in for them with a client that only sees the signed in persons rows.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, db: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    // A client as a person would have it: only their own rows are visible or changeable.
    const db = state.db as FakeAdmin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const own = (table: string) => (db.from(table) as any).eq('user_id', state.user?.id ?? '')
    return {
      auth: { getUser: async () => ({ data: { user: state.user } }) },
      from: (table: string) => ({
        select: (cols: string) => own(table).select(cols),
        update: (patch: Record<string, unknown>) => own(table).update(patch),
        delete: () => own(table).delete(),
      }),
    }
  },
}))

import { GET } from './route'
import { DELETE, PATCH } from './[id]/route'

let db: FakeAdmin
beforeEach(() => {
  state.user = { id: 'u1' }
  db = makeFakeAdmin({
    taste_statements: [
      { id: 's1', user_id: 'u1', statement: 'Prefers small teams that ship weekly.', evidence: [{ quote: 'too slow' }], source: 'proposed', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 's2', user_id: 'u2', statement: 'Not mine.', evidence: [], source: 'proposed', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' },
    ],
  })
  state.db = db
})

const req = (body?: unknown) => new NextRequest('http://localhost/api/taste/s1', { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })

describe('GET /api/taste', () => {
  it('shows only the persons own statements, with the quotes they came from', async () => {
    const body = await (await GET()).json()
    expect(body.statements.map((s: { id: string }) => s.id)).toEqual(['s1'])
    expect(body.statements[0].evidence).toEqual([{ quote: 'too slow' }])
  })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('PATCH and DELETE /api/taste/[id]', () => {
  it('rewords one of their own statements', async () => {
    const res = await PATCH(req({ statement: 'Prefers small teams.' }), { params: { id: 's1' } })
    expect((await res.json()).statement).toMatchObject({ id: 's1', statement: 'Prefers small teams.' })
    expect(db.tables.taste_statements[0].statement).toBe('Prefers small teams.')
  })

  it('refuses an empty or too long statement', async () => {
    expect((await PATCH(req({ statement: '   ' }), { params: { id: 's1' } })).status).toBe(400)
    expect((await PATCH(req({ statement: 'x'.repeat(201) }), { params: { id: 's1' } })).status).toBe(400)
    expect(db.tables.taste_statements[0].statement).toBe('Prefers small teams that ship weekly.')
  })

  it("someone else's statement answers as not found and is left alone", async () => {
    expect((await PATCH(req({ statement: 'Mine now.' }), { params: { id: 's2' } })).status).toBe(404)
    expect((await DELETE(req(), { params: { id: 's2' } })).status).toBe(404)
    expect(db.tables.taste_statements.map((s) => s.statement)).toContain('Not mine.')
  })

  it('deletes their own statement', async () => {
    expect(await (await DELETE(req(), { params: { id: 's1' } })).json()).toEqual({ deleted: true })
    expect(db.tables.taste_statements.map((s) => s.id)).toEqual(['s2'])
  })
})
