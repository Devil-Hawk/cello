// GET /api/outreach: the list now carries each draft's stored quality verdicts,
// looked up once and only for the drafts still awaiting a decision.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const rows = [
  { id: 'a', status: 'pending_review', updated_at: '2026-10-01T00:00:00Z' },
  { id: 'b', status: 'sent', updated_at: '2026-10-01T00:00:00Z' },
  { id: 'c', status: 'failed', updated_at: '2026-10-01T00:00:00Z' },
]

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
// The extra lookups the card needs (sender name, company, history, parent body) all resolve empty here.
const emptyChain: Record<string, unknown> = {}
for (const m of ['select', 'eq', 'in']) emptyChain[m] = () => emptyChain
emptyChain.maybeSingle = async () => ({ data: { full_name: 'Alex Candidate' } })
emptyChain.then = (resolve: (v: unknown) => void) => resolve({ data: [] })
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: () => emptyChain }) }))
vi.mock('@/lib/outreach/store', () => ({ listOutreach: async () => rows }))

const readStoredVerdictsMock = vi.fn(async (_admin: unknown, _user: string, _rows: { id: string }[]) =>
  new Map([['a', [{ judge: 'groundedness', verdict: 'pass', score: 0.9, rationale: 'grounded' }]]])
)
vi.mock('@/lib/outreach/verdicts', () => ({ readStoredVerdicts: (...a: Parameters<typeof readStoredVerdictsMock>) => readStoredVerdictsMock(...a) }))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/outreach', () => {
  it('attaches stored verdicts to each message, an empty list where there are none', async () => {
    const body = await (await GET(new NextRequest('http://localhost/api/outreach'))).json()

    expect(body.messages.find((m: { id: string }) => m.id === 'a').verdicts).toEqual([
      { judge: 'groundedness', verdict: 'pass', score: 0.9, rationale: 'grounded' },
    ])
    expect(body.messages.find((m: { id: string }) => m.id === 'b').verdicts).toEqual([])
  })

  it('adds the sign-off name the card checks the text against', async () => {
    const body = await (await GET(new NextRequest('http://localhost/api/outreach'))).json()
    expect(body.messages[0].sender_name).toBe('Alex Candidate')
  })

  it('only looks verdicts up for drafts awaiting a decision', async () => {
    await GET(new NextRequest('http://localhost/api/outreach'))
    expect(readStoredVerdictsMock.mock.calls[0][2].map((m) => m.id)).toEqual(['a'])
  })
})
