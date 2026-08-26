// POST /api/a2a — auth paths (same shape as app/api/mcp/route.test.ts) and
// wire-shape fidelity: THIS route only ever constructs
// LegacyJsonRpcTransportHandler (compat/v0_3), so a native-shaped body
// (PascalCase method names, ts-proto's protobuf-JSON `role` convention)
// gets METHOD_NOT_FOUND rather than a silent, corrupted execution — the
// wire-shape regression scripts/spike-a2a-roundtrip.ts proves in-process,
// pinned here against the real route. Real @a2a-js/sdk transport/request
// handler wired against the real lib/a2a/* executor and task store; only
// the DB/auth boundary and the graph door are mocked, per this repo's "no
// test touches a real database or calls a real LLM" rule:
//   - lib/access/tokens#validateToken
//   - lib/harness/keys#readProfileForDemoGuards
//   - lib/harness/supabase-admin#createAdminClient (fake admin)
//   - lib/graph/invoke#invokeGraphForUser (the one graph door — ruling 7;
//     stubbed here so this file tests the A2A wire/auth layer, not
//     harnessRunGraph itself, which has its own tests)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  validation: { ok: boolean; userId?: string; scopes?: string[]; reason?: string }
  profileRow: { is_demo: boolean | null; demo_expires_at: string | null } | null
  profileError: { message: string } | null
}

let state: State

const validateTokenMock = vi.fn(async (..._args: unknown[]) => state.validation)
vi.mock('@/lib/access/tokens', () => ({
  validateToken: (...args: unknown[]) => validateTokenMock(...args),
}))

const readProfileForDemoGuardsMock = vi.fn(async (..._args: unknown[]) => ({ row: state.profileRow, error: state.profileError }))
vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: (...args: unknown[]) => readProfileForDemoGuardsMock(...args),
}))

const invokeGraphForUserMock = vi.fn(async (..._args: unknown[]) => ({ threadId: 'thread-stub', result: {} }))
vi.mock('@/lib/graph/invoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/invoke')>()
  return { ...actual, invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args) }
})

// Minimal in-memory fake covering exactly the calls executor.ts/task-store.ts
// make: graph_threads insert; agent_runs insert + the two reads task-store's
// load() does; a2a_tasks upsert/select/update. Real inserted rows (not just
// stub ids) so a full save-then-load merge cycle (as @a2a-js/sdk's
// ResultManager triggers on every published task event) resolves correctly
// instead of throwing on an unimplemented chain.
function fakeAdmin() {
  let threadSeq = 0
  let runSeq = 0
  const agentRunsById = new Map<string, Record<string, unknown>>()
  const agentRunsByThread = new Map<string, string>()
  const a2aTaskRows = new Map<string, Record<string, unknown>>()
  return {
    from(table: string) {
      if (table === 'graph_threads') {
        return {
          insert: (_row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => ({ data: { thread_id: `thread-${++threadSeq}` }, error: null }),
            }),
          }),
        }
      }
      if (table === 'agent_runs') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const id = `run-${++runSeq}`
                const full = { id, started_at: null, result: null, error: null, ...row }
                agentRunsById.set(id, full)
                agentRunsByThread.set(row.thread_id as string, id)
                return { data: { id }, error: null }
              },
            }),
          }),
          select: (_cols: string) => ({
            eq: (col: string, value: string) => ({
              maybeSingle: async () => {
                const id = col === 'thread_id' ? agentRunsByThread.get(value) : value
                return { data: id ? (agentRunsById.get(id) ?? null) : null, error: null }
              },
            }),
          }),
        }
      }
      if (table === 'a2a_tasks') {
        return {
          upsert: async (row: Record<string, unknown>) => {
            a2aTaskRows.set(row.task_id as string, row)
            return { error: null }
          },
          select: (_cols: string) => ({
            eq: (_col: string, taskId: string) => ({
              maybeSingle: async () => ({ data: a2aTaskRows.get(taskId) ?? null, error: null }),
            }),
          }),
          update: (fields: Record<string, unknown>) => ({
            eq: async (_col: string, taskId: string) => {
              const existing = a2aTaskRows.get(taskId)
              if (existing) a2aTaskRows.set(taskId, { ...existing, ...fields })
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
  } as unknown as import('@/lib/harness/types').AdminClient
}

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fakeAdmin() }))

const { POST } = await import('./route')

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer cello_pat_test', ...headers },
    body: JSON.stringify(body),
  })
}

const classicSend = (jobIds: string[] = ['job-1']) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      messageId: 'm1',
      role: 'user',
      parts: [{ kind: 'data', data: { agent: 'matcher', jobIds } }],
    },
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    validation: { ok: true, userId: 'u1', scopes: ['a2a'] },
    profileRow: { is_demo: false, demo_expires_at: null },
    profileError: null,
  }
})

describe('auth', () => {
  it('refuses with no Authorization header', async () => {
    const res = await POST(req(classicSend(), { authorization: '' }))
    expect(res.status).toBe(401)
  })

  it('refuses an invalid token', async () => {
    state.validation = { ok: false, reason: 'unknown' }
    const res = await POST(req(classicSend()))
    expect(res.status).toBe(401)
  })

  it('refuses an expired token with a distinct message', async () => {
    state.validation = { ok: false, reason: 'expired' }
    const res = await POST(req(classicSend()))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/expired/i)
  })

  it('refuses a token missing the a2a scope', async () => {
    state.validation = { ok: true, userId: 'u1', scopes: ['mcp'] }
    const res = await POST(req(classicSend()))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/a2a.*scope/i)
  })

  it('refuses a demo profile', async () => {
    state.profileRow = { is_demo: true, demo_expires_at: null }
    const res = await POST(req(classicSend()))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/demo/i)
  })

  it('fails closed when the profile cannot be read', async () => {
    state.profileRow = null
    state.profileError = { message: 'boom' }
    const res = await POST(req(classicSend()))
    expect(res.status).toBe(403)
  })
})

describe('wire-shape fidelity (the corruption case, pinned against the real route)', () => {
  it('message/send with correctly-shaped classic JSON starts a run and reports SUBMITTED', async () => {
    const res = await POST(req(classicSend(['job-1', 'job-2'])))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(body.result.status.state).toBe('submitted')
    // The graph door was actually reached (ruling 7) with the parsed jobIds
    // riding the compiled plan, not lost anywhere in the transport hop.
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0]![0] as { input: { runId: string } }
    expect(call.input.runId).toMatch(/^run-/)
  })

  it('a genuinely malformed classic part fails LOUD (JSON-RPC -32602), never silently', async () => {
    const body = classicSend()
    body.params.message.parts = [{ kind: 'bogus' } as unknown as (typeof body.params.message.parts)[number]]
    const res = await POST(req(body))
    expect(res.status).toBe(200) // JSON-RPC errors are still HTTP 200 (error lives in the body)
    const json = await res.json()
    expect(json.error?.code).toBe(-32602)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('a native-shaped method name (this route only wires compat/v0_3) is refused, not silently corrupted', async () => {
    // This is the regression the spike proves: native's OWN transport
    // would silently drop this body's content. Routing it at the compat
    // handler this route actually wires means it is simply an unknown
    // method — loud, not corrupted.
    const res = await POST(req({ ...classicSend(), method: 'SendMessage' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.error?.code).toBe(-32601) // METHOD_NOT_FOUND
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('an unrecognized agent in the data part fails loud with no run started', async () => {
    const body = classicSend()
    body.params.message.parts = [{ kind: 'data', data: { agent: 'applier', jobId: 'x' } } as unknown as (typeof body.params.message.parts)[number]]
    const res = await POST(req(body))
    const json = await res.json()
    expect(json.result.status.state).toBe('failed')
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })
})
