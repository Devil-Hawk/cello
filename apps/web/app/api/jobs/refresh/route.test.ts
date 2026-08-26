// POST /api/jobs/refresh now drives the whole run through the ONE graph call
// site (lib/graph/invoke.ts#invokeGraphForUser) instead of a client-driven
// cursor loop. This file pins the shapes a caller can see: a fresh request
// resolving the company list and minting a thread, a threadId request
// resuming it, a deadline-interrupt round reporting honest zeros with
// done:false, and a completed round reporting the graph's real totals with
// done:true. invokeGraphForUser and getRefreshDeadlineInterrupt are mocked —
// this route's job is orchestrating the request/response shape, not
// re-proving invoke.ts's own thread-ownership/resume semantics (invoke.test.ts
// and invoke.langgraph.test.ts's job) or refreshJobsGraph's own wave-scheduler
// behavior (refresh.test.ts's job).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null

const invokeGraphForUserMock = vi.fn()
const getRefreshDeadlineInterruptMock = vi.fn()

interface FakeCompanyRow {
  id: string
  user_id: string
  name: string
  domain: string | null
  career_url: string | null
  metadata?: unknown
}

let companyRows: FakeCompanyRow[]
let companiesError: string | null

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from(table: string) {
      if (table !== 'companies') throw new Error(`route.test.ts: unexpected table "${table}"`)
      const filters: { col: string; val: unknown }[] = []
      const builder = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push({ col, val })
          return builder
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (companiesError) return resolve({ data: null, error: { message: companiesError } })
          const rows = companyRows.filter((r) =>
            filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val)
          )
          return resolve({ data: rows, error: null })
        },
      }
      return builder
    },
  }
}

// vi.mock's factory is hoisted above the module's own top-level statements,
// so anything it closes over must be wrapped in vi.hoisted (class
// declarations are NOT hoisted-with-initialization the way function
// declarations are — a bare top-level `class` here would TDZ-throw the same
// way invoke.langgraph.test.ts's checkpointerHolder comment warns about).
const { FakeThreadOwnershipError, FakeDemoThreadExpiredError } = vi.hoisted(() => {
  class FakeThreadOwnershipError extends Error {
    constructor(threadId: string) {
      super(`Thread ${threadId} does not belong to the requesting user.`)
      this.name = 'ThreadOwnershipError'
    }
  }
  class FakeDemoThreadExpiredError extends Error {
    constructor(threadId: string) {
      super(`Thread ${threadId} has expired.`)
      this.name = 'DemoThreadExpiredError'
    }
  }
  return { FakeThreadOwnershipError, FakeDemoThreadExpiredError }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabase(),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ __fake: 'admin' }) }))
vi.mock('@/lib/graph/invoke', () => ({
  invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args),
  ThreadOwnershipError: FakeThreadOwnershipError,
  DemoThreadExpiredError: FakeDemoThreadExpiredError,
}))
vi.mock('@/lib/graph/refresh', () => ({
  refreshJobsGraph: { __fake: 'refreshJobsGraph' },
  getRefreshDeadlineInterrupt: (...args: unknown[]) => getRefreshDeadlineInterruptMock(...args),
}))

import { POST } from './route'

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/jobs/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const OUTCOME = {
  results: [
    { companyId: 'c1', companyName: 'Acme', provider: 'greenhouse', found: 3, inserted: 2, errors: [] },
  ],
  totals: { found: 3, inserted: 2, companiesWithAts: 1 },
  total: 1,
  processed: 1,
}

beforeEach(() => {
  user = { id: 'user-1' }
  companyRows = [
    { id: 'c1', user_id: 'user-1', name: 'Acme', domain: 'acme.com', career_url: null },
    { id: 'c2', user_id: 'user-1', name: 'Beta', domain: 'beta.com', career_url: null },
  ]
  companiesError = null
  invokeGraphForUserMock.mockReset()
  getRefreshDeadlineInterruptMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/jobs/refresh', () => {
  it('rejects an unauthenticated caller before touching the graph', async () => {
    user = null
    const response = await POST(postRequest({}))
    expect(response.status).toBe(401)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('no threadId: resolves the caller\'s companies, mints a fresh thread, and returns done:true with the real totals', async () => {
    getRefreshDeadlineInterruptMock.mockReturnValue(null)
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-1', result: OUTCOME })

    const response = await POST(postRequest({}))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      ok: true,
      threadId: 'thread-1',
      results: OUTCOME.results,
      totals: OUTCOME.totals,
      cursor: null,
      total: 2, // the route's own company count, not the (mocked) outcome's
      done: true,
    })

    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0][0]
    expect(call.userId).toBe('user-1')
    expect(call.surface).toBe('refresh')
    expect(call.threadId).toBeUndefined() // fresh thread — never passes one in
    expect(call.input).toEqual({
      companyIds: ['c1', 'c2'],
      perCompanyOptions: {
        c1: { name: 'Acme', domain: 'acme.com', career_url: null, metadata: undefined },
        c2: { name: 'Beta', domain: 'beta.com', career_url: null, metadata: undefined },
      },
    })
    // RULING 9: the RLS-scoped client rides config, not an admin downgrade.
    expect(call.extraConfigurable).toHaveProperty('dbClient')
    expect(call.admin).toEqual({ __fake: 'admin' })
  })

  it('a companyId with no matching row 404s before ever calling the graph', async () => {
    const response = await POST(postRequest({ companyId: 'nope' }))
    expect(response.status).toBe(404)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('a companies query error 500s before ever calling the graph', async () => {
    companiesError = 'db exploded'
    const response = await POST(postRequest({}))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('db exploded')
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('with threadId: resumes the same thread, passes no fresh input, and still rides the RLS client', async () => {
    getRefreshDeadlineInterruptMock.mockReturnValue(null)
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-1', result: OUTCOME })

    const response = await POST(postRequest({ threadId: 'thread-1' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.done).toBe(true)
    expect(body.threadId).toBe('thread-1')

    const call = invokeGraphForUserMock.mock.calls[0][0]
    expect(call.threadId).toBe('thread-1')
    expect(call.input).toBeUndefined()
    expect(call.extraConfigurable).toHaveProperty('dbClient')
  })

  it('a deadline interrupt reports honest zeros, cursor:processed, and done:false — never an invented outcome', async () => {
    const interruptResult = { __interrupt__: [{ value: { kind: 'deadline', processed: 1, total: 2 } }] }
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-1', result: interruptResult })
    getRefreshDeadlineInterruptMock.mockReturnValue({ kind: 'deadline', processed: 1, total: 2 })

    const response = await POST(postRequest({}))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      ok: true,
      threadId: 'thread-1',
      results: [],
      totals: { found: 0, inserted: 0, companiesWithAts: 0 },
      cursor: 1,
      total: 2,
      done: false,
    })
  })

  it('an unknown/foreign threadId 404s, not a generic 500 — same shape whether missing or not owned', async () => {
    invokeGraphForUserMock.mockRejectedValue(new FakeThreadOwnershipError('thread-x'))
    const response = await POST(postRequest({ threadId: 'thread-x' }))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('Thread not found')
  })

  it('an expired demo thread 410s honestly instead of masquerading as not-found', async () => {
    invokeGraphForUserMock.mockRejectedValue(new FakeDemoThreadExpiredError('thread-x'))
    const response = await POST(postRequest({ threadId: 'thread-x' }))
    expect(response.status).toBe(410)
    const body = await response.json()
    expect(body.error).toBe('This refresh session has expired')
  })

  it('any other invokeGraphForUser throw 500s with its message', async () => {
    invokeGraphForUserMock.mockRejectedValue(new Error('checkpointer connection refused'))
    const response = await POST(postRequest({}))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('checkpointer connection refused')
  })
})
