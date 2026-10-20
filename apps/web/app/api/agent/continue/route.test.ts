// POST /api/agent/continue: the clock's one signed door.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { continueBody, signContinue } from '@/lib/clock/sign'

const runRoutineMock = vi.fn()
const resumeMock = vi.fn()
const advanceMock = vi.fn()

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ fake: 'admin' }) }))
vi.mock('@/lib/clock/routines/index', () => ({ HANDLERS: { 'roles.check': () => undefined } }))
vi.mock('@/lib/clock/routines', () => ({ runRoutine: (...args: unknown[]) => runRoutineMock(...args) }))

vi.mock('@/lib/chat/run', () => ({ resumeChatTurn: (...args: unknown[]) => resumeMock(...args) }))
vi.mock('@/lib/advance', () => ({ advanceOne: (...args: unknown[]) => advanceMock(...args) }))

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
  resumeMock.mockReset().mockResolvedValue(true)
  advanceMock.mockReset().mockResolvedValue(undefined)
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

  it('resumes a stale chat turn and ignores other threads', async () => {
    const stale = continueBody({ reason: 'stale', thread_id: 'chat-1', turn_id: 'turn-1' })
    expect((await POST(post(stale, signContinue(stale, SECRET)))).status).toBe(202)
    expect(resumeMock).toHaveBeenCalledTimes(1)
    expect(resumeMock).toHaveBeenCalledWith({ fake: 'admin' }, 'chat-1', 'turn-1')

    resumeMock.mockClear()
    for (const payload of [{ reason: 'due', thread_id: 'chat-1' }, { reason: 'stale' }, { reason: 'due', scheduled_task_id: 's1' }] as const) {
      const body = continueBody(payload)
      expect((await POST(post(body, signContinue(body, SECRET)))).status).toBe(202)
    }
    expect(resumeMock).not.toHaveBeenCalled()
    expect(runRoutineMock).not.toHaveBeenCalled()
  })

  it('carries a chat slice on with its turn and slice count', async () => {
    const body = continueBody({ reason: 'slice', thread_id: 'chat-1', turn_id: 'turn-1', slice: { n: 2 } })
    expect((await POST(post(body, signContinue(body, SECRET)))).status).toBe(202)
    expect(resumeMock).toHaveBeenCalledWith({ fake: 'admin' }, 'chat-1', 'turn-1', 2)
    expect(runRoutineMock).not.toHaveBeenCalled()

    resumeMock.mockClear()
    const noCount = continueBody({ reason: 'slice', thread_id: 'chat-1', turn_id: 'turn-1', slice: {} })
    await POST(post(noCount, signContinue(noCount, SECRET)))
    expect(resumeMock).toHaveBeenCalledWith({ fake: 'admin' }, 'chat-1', 'turn-1', 0)
  })

  it('a routine slice still goes to the routine, and a slice with nothing to carry on does nothing', async () => {
    const both = continueBody({ reason: 'slice', routine_id: 'r1', thread_id: 'chat-1', slice: { n: 1 } })
    await POST(post(both, signContinue(both, SECRET)))
    expect(runRoutineMock).toHaveBeenCalledTimes(1)
    expect(resumeMock).not.toHaveBeenCalled()

    const bare = continueBody({ reason: 'slice' })
    expect((await POST(post(bare, signContinue(bare, SECRET)))).status).toBe(202)
    expect(resumeMock).not.toHaveBeenCalled()
    expect(runRoutineMock).toHaveBeenCalledTimes(1)
  })

  it('moves one application a step on advance', async () => {
    const body = continueBody({ reason: 'advance', application_id: 'a1' })
    await POST(post(body, signContinue(body, SECRET)))
    expect(advanceMock).toHaveBeenCalledWith({ fake: 'admin' }, 'a1')
  })

  it('does not fail the request when the routine throws', async () => {
    runRoutineMock.mockRejectedValue(new Error('database down'))
    const body = continueBody({ reason: 'routine', routine_id: 'r1' })
    expect((await POST(post(body, signContinue(body, SECRET)))).status).toBe(202)
  })
})
