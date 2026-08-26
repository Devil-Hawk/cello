// POST /api/harness/run now drives the whole run through the ONE graph call
// site (lib/graph/invoke.ts#invokeGraphForUser) instead of the bespoke
// executor. This file pins the three shapes a caller can see: a terminal
// RunOutcome, an honest `paused: true` with no invented `run` field on a
// deadline interrupt, and a failed setup (invokeGraphForUser itself throwing)
// still marking the row 'failed' instead of leaving it 'running' forever.
//
// invokeGraphForUser and markRunPausedOnInterrupt are mocked — this route's
// job is orchestrating agent_runs + reading their result, not re-proving
// invoke.ts's own thread-ownership/resume semantics (those are invoke.test.ts
// and invoke.langgraph.test.ts's job) or harnessRunGraph's own wave-scheduler
// behavior (runs.test.ts's job).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null

const invokeGraphForUserMock = vi.fn()
const markRunPausedOnInterruptMock = vi.fn()

let inserted: Record<string, unknown>[]
let updates: Array<{ patch: Record<string, unknown>; id: unknown }>
let seq: number

function makeAdmin() {
  return {
    from(table: string) {
      if (table !== 'agent_runs') throw new Error(`route.test.ts: unexpected table "${table}"`)
      return {
        insert(row: Record<string, unknown>) {
          return {
            select: () => ({
              single: async () => {
                seq += 1
                const id = `run-${seq}`
                inserted.push({ ...row, id })
                return { data: { id }, error: null }
              },
            }),
          }
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: async (_col: string, val: unknown) => {
              updates.push({ patch, id: val })
              return { data: null, error: null }
            },
          }
        },
      }
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => makeAdmin() }))
vi.mock('@/lib/graph/invoke', () => ({
  invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args),
}))
vi.mock('@/lib/graph/runs', () => ({
  harnessRunGraph: { __fake: 'harnessRunGraph' },
  markRunPausedOnInterrupt: (...args: unknown[]) => markRunPausedOnInterruptMock(...args),
}))

import { POST } from './route'

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/harness/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const OUTCOME = {
  runId: 'run-1',
  status: 'completed',
  spentTokens: 500,
  budgetTokens: 200_000,
  steps: [],
  outputs: {},
  summary: { completed: 1, failed: 0, skipped: 0 },
  replanEvents: [],
}

beforeEach(() => {
  user = { id: 'user-1' }
  inserted = []
  updates = []
  seq = 0
  invokeGraphForUserMock.mockReset()
  markRunPausedOnInterruptMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/harness/run', () => {
  it('rejects an unauthenticated caller before creating a run', async () => {
    user = null
    const response = await POST(postRequest({ goal: 'find me a job' }))
    expect(response.status).toBe(401)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(inserted).toEqual([])
  })

  it('creates the agent_runs row, then drives it through invokeGraphForUser on a fresh thread', async () => {
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-1', result: OUTCOME })
    markRunPausedOnInterruptMock.mockResolvedValue(false)

    const response = await POST(postRequest({ goal: 'find me a job' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, runId: 'run-1', chain: null, run: OUTCOME })

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ user_id: 'user-1', goal: 'find me a job', status: 'queued' })

    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0][0]
    expect(call.userId).toBe('user-1')
    expect(call.surface).toBe('run')
    expect(call.input).toEqual({ runId: 'run-1' })
    expect(call.threadId).toBeUndefined() // fresh thread — never passes one in

    expect(markRunPausedOnInterruptMock).toHaveBeenCalledWith(expect.anything(), 'run-1', OUTCOME)
    // No failure path taken — the row's status is whatever harnessRunGraph
    // itself wrote (this route never overwrites it on the success path).
    expect(updates).toEqual([])
  })

  it('reports paused:true with no invented `run` field on a deadline interrupt', async () => {
    const interruptResult = { __interrupt__: [{ value: { kind: 'deadline' } }] }
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-1', result: interruptResult })
    markRunPausedOnInterruptMock.mockResolvedValue(true)

    const response = await POST(postRequest({ goal: 'find me a job' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, runId: 'run-1', chain: null, paused: true })
    expect(body.run).toBeUndefined()

    expect(markRunPausedOnInterruptMock).toHaveBeenCalledWith(expect.anything(), 'run-1', interruptResult)
    expect(updates).toEqual([])
  })

  it('marks the run failed (not left running) when invokeGraphForUser itself throws', async () => {
    invokeGraphForUserMock.mockRejectedValue(new Error('thread ownership refused'))

    const response = await POST(postRequest({ goal: 'find me a job' }))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ ok: false, runId: 'run-1', chain: null, error: 'thread ownership refused' })

    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('run-1')
    expect(updates[0].patch).toMatchObject({ status: 'failed', error: 'thread ownership refused' })
    expect(updates[0].patch.finished_at).toBeTruthy()
  })

  it('still refuses a request with both goal and chain, before touching the graph at all', async () => {
    const response = await POST(postRequest({ goal: 'find me a job', chain: 'apply-to-role', params: {} }))
    expect(response.status).toBe(400)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(inserted).toEqual([])
  })
})
