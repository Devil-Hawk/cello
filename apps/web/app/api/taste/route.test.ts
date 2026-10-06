// /api/taste: read with the persons own session. Row rules do the owner check, so this test stands
// in for them with a client that only sees the signed in persons rows.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, db: null as unknown, failure: false }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    // A client as a person would have it: only their own rows are visible.
    const db = state.db as FakeAdmin
    return {
      auth: { getUser: async () => ({ data: { user: state.user } }) },
      from: (table: string) => ({
        select: (cols: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state.failure ? { order: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }) } : (db.from(table) as any).eq('user_id', state.user?.id ?? '').select(cols),
      }),
    }
  },
}))

import { GET } from './route'

let db: FakeAdmin
const reaction = (over: Record<string, unknown>) => ({ id: crypto.randomUUID(), user_id: 'u1', reaction: 'interested', reason: null, job_title: 'Engineer', company_name: 'Acme', created_at: '2026-10-01T00:00:00Z', ...over })

beforeEach(() => {
  state.user = { id: 'u1' }
  state.failure = false
  db = makeFakeAdmin({ role_reactions: [] })
  state.db = db
})

describe('GET /api/taste', () => {
  it('shows only the persons own reactions, newest first, and no more than twenty', async () => {
    db.tables.role_reactions = [
      ...Array.from({ length: 22 }, (_, i) => reaction({ job_title: `Role ${i}`, created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` })),
      reaction({ user_id: 'u2', job_title: 'Not mine' }),
    ]
    const body = await (await GET()).json()
    expect(body.reactions).toHaveLength(20)
    expect(body.reactions[0].job_title).toBe('Role 21')
    expect(JSON.stringify(body)).not.toContain('Not mine')
  })

  it('carries the reason and the role as it was when they reacted', async () => {
    db.tables.role_reactions = [reaction({ reaction: 'not_for_me', reason: 'pay', job_title: 'Staff Engineer', company_name: 'Globex' })]
    const body = await (await GET()).json()
    expect(body.reactions[0]).toMatchObject({ reaction: 'not_for_me', reason: 'pay', job_title: 'Staff Engineer', company_name: 'Globex' })
    expect(body).not.toHaveProperty('statements')
  })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await GET()).status).toBe(401)
  })

  it('says it could not load rather than showing nothing', async () => {
    state.failure = true
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'Could not load your taste' })
  })
})
