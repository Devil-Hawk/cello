import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeDb } from '@/lib/companies/fake-db'

const state = { user: { id: 'u1' } as { id: string } | null }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }) }))
let fake = fakeDb()
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fake.client }))

const judgeRoles = vi.fn()
const judgeStatus = vi.fn()
const nextWaiting = vi.fn()
vi.mock('@/lib/roles/judge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roles/judge')>()),
  judgeRoles: (...a: unknown[]) => judgeRoles(...a),
  judgeStatus: (...a: unknown[]) => judgeStatus(...a),
  nextWaiting: (...a: unknown[]) => nextWaiting(...a),
}))

import { POST } from './route'

const post = (headers: Record<string, string> = {}) => POST(new NextRequest('http://localhost/api/roles/judge-all', { method: 'POST', headers }))

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1' }
  fake = fakeDb({ routines: [{ id: 'r1', command: 'roles.match', user_id: null, args: { front: ['u9'] }, next_due_at: '2099-01-01T00:00:00Z' }] })
  nextWaiting.mockResolvedValue(['a', 'b', 'c'])
})

describe('POST /api/roles/judge-all', () => {
  it('refuses another site and a signed-out caller, and judges nothing', async () => {
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    state.user = null
    expect((await post()).status).toBe(401)
    expect(judgeRoles).not.toHaveBeenCalled()
  })

  it('judges up to 12 waiting roles for the caller and puts them at the front of the next roles.match slice', async () => {
    judgeRoles.mockResolvedValue({ judged: ['a', 'b', 'c'], stopped: null })
    judgeStatus.mockResolvedValue({ judgedToday: 3, waiting: 20, line: '20 more are being checked. Until then they are listed by title and date.' })
    const res = await post()
    expect(nextWaiting.mock.calls[0].slice(1)).toEqual(['u1', 12])
    expect(judgeRoles.mock.calls[0].slice(1)).toEqual(['u1', ['a', 'b', 'c']])
    expect(await res.json()).toEqual({ scored: 3, failed: 0, remaining: 20, line: '20 more are being checked. Until then they are listed by title and date.', stopped: null })
    const routine = fake.tables.routines[0] as { args: { front: string[] }; next_due_at: string }
    expect(routine.args.front).toEqual(['u1', 'u9'])
    expect(Date.parse(routine.next_due_at)).toBeLessThan(Date.now() + 1000)
  })

  it('answers 429 with the day line when nothing could be judged for want of a free call', async () => {
    judgeRoles.mockResolvedValue({ judged: [], stopped: 'day' })
    judgeStatus.mockResolvedValue({ judgedToday: 40, waiting: 80, line: null })
    const res = await post()
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'Cello judged 40 of your 120 new roles today. The rest continue tomorrow.' })
    expect((fake.tables.routines[0] as { args: { front: string[] } }).args.front).toEqual(['u9'])
  })

  it('does not queue the caller when nothing waits any more', async () => {
    judgeRoles.mockResolvedValue({ judged: ['a'], stopped: null })
    judgeStatus.mockResolvedValue({ judgedToday: 1, waiting: 0, line: null })
    await post()
    expect((fake.tables.routines[0] as { args: { front: string[] } }).args.front).toEqual(['u9'])
  })
})
