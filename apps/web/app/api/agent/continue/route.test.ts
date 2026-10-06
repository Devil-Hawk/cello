// POST /api/agent/continue: the clock's one signed door.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { continueBody, signContinue } from '@/lib/clock/sign'

const runRoutineMock = vi.fn()

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ fake: 'admin' }) }))
vi.mock('@/lib/clock/routines/index', () => ({ HANDLERS: { 'roles.check': () => undefined } }))
vi.mock('@/lib/clock/routines', () => ({ runRoutine: (...args: unknown[]) => runRoutineMock(...args) }))

import { POST } from './route'

const SECRET = 's'.repeat(32)

function post(body: string, signature?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature) headers['x-cello-signature'] = signature
  return new NextRequest('http://localhost/api/agent/continue', { method: 'POST', headers, body })
}

beforeEach(() => {
  process.env.AGENT_CONTINUE_SECRET = SECRET
  runRoutineMock.mockReset().mockResolvedValue({ ran: true, done: true, ok: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/agent/continue', () => {
  it('runs a due routine and answers 202', async () => {
    const body = continueBody({ reason: 'routine', routine_id: 'r1' })
    const res = await POST(post(body, signContinue(body, SECRET)))
    expect(res.status).toBe(202)
    expect(runRoutineMock).toHaveBeenCalledTimes(1)
    expect(runRoutineMock.mock.calls[0][1]).toBe('r1')
    expect(runRoutineMock.mock.calls[0][2]).toBeNull()
  })

  it('passes a slice on to the routine', async () => {
    const slice = { elapsed_ms: 1200, state: { done: ['c1'] } }
    const body = continueBody({ reason: 'routine', routine_id: 'r1', slice })
    await POST(post(body, signContinue(body, SECRET)))
    expect(runRoutineMock.mock.calls[0][2]).toEqual(slice)
  })

  it('refuses a missing or a wrong signature with 401 and runs nothing', async () => {
    const body = continueBody({ reason: 'routine', routine_id: 'r1' })
    expect((await POST(post(body))).status).toBe(401)
    expect((await POST(post(body, signContinue(body, 'x'.repeat(32))))).status).toBe(401)
    expect((await POST(post(body.replace('r1', 'r2'), signContinue(body, SECRET)))).status).toBe(401)
    expect(runRoutineMock).not.toHaveBeenCalled()
  })

  it('refuses an old signed body replayed after five minutes, and an exp too far ahead', async () => {
    const old = continueBody({ reason: 'routine', routine_id: 'r1' }, Date.now() - 6 * 60_000)
    expect((await POST(post(old, signContinue(old, SECRET)))).status).toBe(401)
    const far = JSON.stringify({ reason: 'routine', routine_id: 'r1', exp: Math.floor(Date.now() / 1000) + 3600 })
    expect((await POST(post(far, signContinue(far, SECRET)))).status).toBe(401)
    expect(runRoutineMock).not.toHaveBeenCalled()
  })

  it('says not configured (503) when the secret is not set on this deployment', async () => {
    delete process.env.AGENT_CONTINUE_SECRET
    const body = continueBody({ reason: 'routine', routine_id: 'r1' })
    expect((await POST(post(body, 'ab'))).status).toBe(503)
    expect(runRoutineMock).not.toHaveBeenCalled()
  })

  it('answers the engine reasons and does nothing until the engine is here', async () => {
    const body = continueBody({ reason: 'stale', thread_id: 't1' })
    expect((await POST(post(body, signContinue(body, SECRET)))).status).toBe(202)
    expect(runRoutineMock).not.toHaveBeenCalled()
  })

  it('does not fail the request when the routine throws', async () => {
    runRoutineMock.mockRejectedValue(new Error('database down'))
    const body = continueBody({ reason: 'routine', routine_id: 'r1' })
    expect((await POST(post(body, signContinue(body, SECRET)))).status).toBe(202)
  })
})
