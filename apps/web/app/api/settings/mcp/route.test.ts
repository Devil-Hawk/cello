import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny in-memory stand-in for the two tables the route reads, shaped like the supabase-js chain the registry uses.
const db = vi.hoisted(() => ({
  servers: [] as Record<string, unknown>[],
  profiles: [] as Record<string, unknown>[],
  user: { id: 'u1' } as { id: string } | null,
}))
const client = vi.hoisted(() => ({ listMcpTools: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: db.user } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const rows = () => (table === 'user_mcp_servers' ? db.servers : db.profiles)
      let patch: Record<string, unknown> | null = null
      const filters: [string, unknown][] = []
      const matched = () => rows().filter((r) => filters.every(([k, v]) => r[k] === v))
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => {
          const hit = matched()[0]
          if (hit && patch) Object.assign(hit, patch)
          return { data: hit ?? null, error: null }
        },
        single: async () => {
          const hit = matched()[0]
          if (hit && patch) Object.assign(hit, patch)
          return hit ? { data: hit, error: null } : { data: null, error: { message: 'no row' } }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matched(), error: null }),
      }
      return q
    },
  }),
}))
vi.mock('@/lib/mcp/client', () => ({
  isStdioAvailable: () => false,
  DEFAULT_MCP_TIMEOUT_MS: 10_000,
  listMcpTools: client.listMcpTools,
  testMcpServer: vi.fn(),
}))

import { GET, PATCH } from './route'

const server = (over: Record<string, unknown> = {}) => ({
  id: 's1', user_id: 'u1', name: 'notes', transport: 'http', url: 'https://8.8.8.8/mcp', headers: null,
  enabled: true, tool_rules: {}, last_connected_at: null, last_error: null, created_at: '2026-11-28T00:00:00Z', ...over,
})
const tools = [
  { name: 'search', description: 'Find notes', inputSchema: { type: 'object', properties: { query: {} } }, readOnlyHint: true },
  { name: 'send_email', description: 'x'.repeat(400), inputSchema: { type: 'object', properties: { to: {}, body: {} } }, readOnlyHint: false },
  { name: 'wipe', description: 'Delete all', inputSchema: { type: 'object', properties: {} }, readOnlyHint: true },
]
const get = (qs: string) => GET(new Request(`http://x/api/settings/mcp?${qs}`) as never)
const patch = (qs: string, body: unknown) => PATCH(new Request(`http://x/api/settings/mcp?${qs}`, { method: 'PATCH', body: JSON.stringify(body) }) as never)

beforeEach(() => {
  db.user = { id: 'u1' }
  db.servers = [server({ tool_rules: { wipe: 'never' } }), server({ id: 'other', user_id: 'u2', name: 'theirs' })]
  db.profiles = [{ id: 'u1', is_demo: false, demo_expires_at: null }]
  client.listMcpTools.mockReset().mockResolvedValue(tools)
})

describe('/api/settings/mcp', () => {
  it('turns a signed-out caller away', async () => {
    db.user = null
    expect((await get('tools=s1')).status).toBe(401)
    expect((await patch('id=s1', { tool: 'search', never: true })).status).toBe(401)
  })

  it('lists each tool with its tier, the rule applied, and the description cut', async () => {
    const res = await get('tools=s1')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.tools.map((t: { name: string; tier: string; never: boolean }) => [t.name, t.tier, t.never])).toEqual([
      ['search', 'read', false],
      ['send_email', 'confirm', false],
      ['wipe', 'never', true],
    ])
    expect(body.tools[1].description).toHaveLength(300)
    expect(client.listMcpTools).toHaveBeenCalledWith(expect.objectContaining({ name: 'notes' }), { timeoutMs: 5000 })
  })

  it('shows a demo every tool as Never', async () => {
    db.profiles = [{ id: 'u1', is_demo: true, demo_expires_at: '2026-12-01T00:00:00Z' }]
    const body = await (await get('tools=s1')).json()
    expect(body.tools.map((t: { tier: string }) => t.tier)).toEqual(['never', 'never', 'never'])
  })

  it('says in plain words when it cannot connect', async () => {
    client.listMcpTools.mockRejectedValue(new Error('connect ECONNREFUSED 8.8.8.8 Authorization: Bearer abc'))
    const res = await get('tools=s1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not reach notes. Check the address and try again.' })
  })

  it('does not find another person\'s server', async () => {
    const res = await get('tools=other')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'That server was not found.' })
    expect(client.listMcpTools).not.toHaveBeenCalled()
    expect((await patch('id=other', { tool: 'search', never: true })).status).toBe(404)
    expect(db.servers[1].tool_rules).toEqual({})
  })

  it('round-trips the Never mark: set, listed, cleared', async () => {
    const set = await patch('id=s1', { tool: 'search', never: true })
    expect(set.status).toBe(200)
    expect((await set.json()).server.toolRules).toEqual({ wipe: 'never', search: 'never' })
    const listed = await (await get('tools=s1')).json()
    expect(listed.tools[0]).toMatchObject({ name: 'search', tier: 'never', never: true })
    const cleared = await (await patch('id=s1', { tool: 'search', never: false })).json()
    expect(cleared.server.toolRules).toEqual({ wipe: 'never' })
  })

  it('checks the mark before saving it, and still takes the old fields', async () => {
    expect((await patch('id=s1', { tool: '', never: true })).status).toBe(400)
    expect((await patch('id=s1', { tool: 'x'.repeat(81), never: true })).status).toBe(400)
    expect((await patch('id=s1', { tool: 'search' })).status).toBe(400)
    const res = await patch('id=s1', { enabled: false })
    expect(res.status).toBe(200)
    expect((await res.json()).server).toMatchObject({ name: 'notes', enabled: false })
  })

  it('lists servers with toolRules and no headers', async () => {
    const body = await (await GET(new Request('http://x/api/settings/mcp') as never)).json()
    expect(body.servers).toHaveLength(1)
    expect(body.servers[0]).toMatchObject({ name: 'notes', toolRules: { wipe: 'never' }, hasHeaders: false })
    expect(body.servers[0]).not.toHaveProperty('headers')
  })
})
