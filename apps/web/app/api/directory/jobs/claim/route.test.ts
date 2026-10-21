import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signContinue } from '@/lib/clock/sign'
import { fakeDb } from '@/lib/companies/fake-db'

const SECRET = 'k'.repeat(32)
let queue: Record<string, unknown>[] = []
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => fakeDb({}, { rpc: { claim_render_job: () => (queue.length ? [queue.shift()] : []) } }).client,
}))

import { POST } from './route'

const exp = () => Math.floor(Date.now() / 1000) + 60
function call(body: Record<string, unknown> = { exp: exp() }, sign: (raw: string) => string | null = (raw) => signContinue(raw, SECRET)) {
  const raw = JSON.stringify(body)
  const signature = sign(raw)
  return POST(new NextRequest('http://localhost/api/directory/jobs/claim', { method: 'POST', body: raw, headers: signature ? { 'x-cello-signature': signature } : {} }))
}

beforeEach(() => {
  process.env.AGENT_CONTINUE_SECRET = SECRET
  queue = []
})

describe('POST /api/directory/jobs/claim', () => {
  it('refuses a request with no signature or a wrong one', async () => {
    queue = [{ id: 'j1', kind: 'careers_page', url: 'https://a.example/c', query: null }]
    expect((await call(undefined, () => null)).status).toBe(401)
    expect((await call(undefined, () => 'ab'.repeat(32))).status).toBe(401)
    expect(queue).toHaveLength(1) // nothing was claimed
  })

  it('refuses an expiry in the past', async () => {
    expect((await call({ exp: Math.floor(Date.now() / 1000) - 5 })).status).toBe(401)
  })

  it('answers 204 when nothing waits, then the row, then 204 again', async () => {
    expect((await call()).status).toBe(204)
    queue = [{ id: 'j1', kind: 'careers_page', url: 'https://a.example/c', query: null, state: 'claimed', attempts: 1, claimed_at: 'x' }]
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'j1', kind: 'careers_page', url: 'https://a.example/c', query: null })
    expect((await call()).status).toBe(204)
  })
})
