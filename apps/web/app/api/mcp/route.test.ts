// POST /api/mcp — Cello as an MCP server. Real Streamable HTTP wire (this
// file drives the actual @modelcontextprotocol/sdk transport the route
// builds, not a mocked one), with only the DB/auth boundary mocked:
//   - lib/access/tokens#validateToken     (auth: no token/expired/wrong-scope)
//   - lib/harness/keys#readProfileForDemoGuards/loadApiKeys (demo refusal)
//   - lib/harness/supabase-admin#createAdminClient (fake admin, incl. auth.admin.getUserById)
//   - lib/harness/copilot-tools#dispatchTool (spy — real COPILOT_TOOLS/schemas flow through untouched)
// submitOrSendReason (lib/graph/copilot.ts) is REAL — the guarded-tool
// refusal test below proves the actual guard, not a stand-in for it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { COPILOT_TOOLS } from '@/lib/harness/copilot-tool-catalog'

interface State {
  validation: { ok: boolean; userId?: string; scopes?: string[]; reason?: string }
  profileRow: { is_demo: boolean | null; demo_expires_at: string | null } | null
  profileError: { message: string } | null
  apiKeysThrows: Error | null
}

let state: State

const validateTokenMock = vi.fn(async (..._args: unknown[]) => state.validation)
vi.mock('@/lib/access/tokens', () => ({
  validateToken: (...args: unknown[]) => validateTokenMock(...args),
}))

const readProfileForDemoGuardsMock = vi.fn(async (..._args: unknown[]) => ({ row: state.profileRow, error: state.profileError }))
const loadApiKeysMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
  if (state.apiKeysThrows) throw state.apiKeysThrows
  return { userId: 'u1' }
})
vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: (...args: unknown[]) => readProfileForDemoGuardsMock(...args),
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

const fakeAdmin = {
  auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@example.com' } }, error: null }) } },
} as unknown as import('@/lib/harness/types').AdminClient
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fakeAdmin }))

const dispatchToolMock = vi.fn(async (_ctx: unknown, tool: string, _args: Record<string, unknown>): Promise<unknown> => ({ ok: true, tool }))
vi.mock('@/lib/harness/copilot-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/harness/copilot-tools')>()
  return { ...actual, dispatchTool: (...args: unknown[]) => dispatchToolMock(...(args as [unknown, string, Record<string, unknown>])) }
})

const { POST } = await import('./route')

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer cello_pat_test',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
function toolsCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }
}

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    validation: { ok: true, userId: 'u1', scopes: ['mcp'] },
    profileRow: { is_demo: false, demo_expires_at: null },
    profileError: null,
    apiKeysThrows: null,
  }
  validateTokenMock.mockImplementation(async () => state.validation)
  readProfileForDemoGuardsMock.mockImplementation(async () => ({ row: state.profileRow, error: state.profileError }))
  loadApiKeysMock.mockImplementation(async (): Promise<unknown> => {
    if (state.apiKeysThrows) throw state.apiKeysThrows
    return { userId: 'u1' }
  })
  dispatchToolMock.mockImplementation(async (_ctx: unknown, tool: string) => ({ ok: true, tool }))
})

describe('auth', () => {
  it('refuses with no Authorization header', async () => {
    const res = await POST(req(TOOLS_LIST, { authorization: '' }))
    expect(res.status).toBe(401)
    expect(validateTokenMock).not.toHaveBeenCalled()
  })

  it('refuses an expired token', async () => {
    state.validation = { ok: false, reason: 'expired' }
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/expired/i)
  })

  it('refuses a revoked token', async () => {
    state.validation = { ok: false, reason: 'revoked' }
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/revoked/i)
  })

  it('refuses a token that is valid but lacks the mcp scope', async () => {
    state.validation = { ok: true, userId: 'u1', scopes: ['a2a'] }
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/mcp/i)
  })

  it('demo-PAT impossible: a valid, correctly-scoped token whose owner is NOW a demo profile is refused', async () => {
    // Simulates the case creation-time refusal and the DB trigger cannot
    // cover: the token was minted while the account was real, and the
    // profile became a demo afterward — validateToken alone has no opinion
    // on that, so the route's own is_demo re-check is what has to catch it.
    state.profileRow = { is_demo: true, demo_expires_at: null }
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/demo/i)
    expect(dispatchToolMock).not.toHaveBeenCalled()
  })

  it('fails closed when the profile cannot be read', async () => {
    state.profileRow = null
    state.profileError = { message: 'db down' }
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(403)
  })
})

describe('tools/list parity', () => {
  it('lists exactly the 19 first-party tool names from COPILOT_TOOLS — nothing added, nothing missing', async () => {
    const res = await POST(req(TOOLS_LIST))
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(new Set(names)).toEqual(new Set(COPILOT_TOOLS.map((t) => t.name)))
  })
})

describe('tool dispatch', () => {
  it('an ordinary read tool call reaches dispatchTool and returns its observation', async () => {
    dispatchToolMock.mockResolvedValueOnce({ jobs: [], count: 0 })
    const res = await POST(req(toolsCall('list_jobs', { query: 'engineer' })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    expect(dispatchToolMock.mock.calls[0]?.[1]).toBe('list_jobs')
    expect(body.result.isError).toBeFalsy()
    expect(body.result.content[0].text).toContain('"count":0')
  })

  it('a submit-shaped trigger_run goal is refused before dispatchTool ever runs', async () => {
    const res = await POST(req(toolsCall('trigger_run', { goal: 'submit applications to these 5 jobs' })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/explicit go-ahead|web app|human/i)
    expect(dispatchToolMock).not.toHaveBeenCalled()
  })

  it('an ordinary trigger_run goal (no submit/send language) is NOT refused', async () => {
    dispatchToolMock.mockResolvedValueOnce({ runId: 'r1', status: 'running' })
    const res = await POST(req(toolsCall('trigger_run', { goal: 'source and score fresh roles' })))
    const body = await res.json()
    expect(body.result.isError).toBeFalsy()
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
  })
})
