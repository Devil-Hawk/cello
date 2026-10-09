import { beforeEach, describe, expect, it, vi } from 'vitest'

const reg = vi.hoisted(() => ({ listServers: vi.fn() }))
vi.mock('@/lib/mcp/registry', () => ({
  listServers: reg.listServers,
  toConfig: (row: { headers: string | null }) => ({ headers: row.headers ? { Authorization: `Bearer decrypted-${row.headers}` } : {} }),
}))

import { MCP_TOOL_TIMEOUT_MS, loadUserMcpTools } from './user-mcp'

const row = (over: Record<string, unknown> = {}) => ({ id: 's1', name: 'notes', transport: 'http', url: 'https://8.8.8.8/mcp', headers: null, enabled: true, ...over })
const ctx = (over = {}) => ({ admin: {} as never, userId: 'u1', isDemo: false, ...over })

function client(over: Partial<{ getTools: () => Promise<unknown[]>; close: () => Promise<void> }> = {}) {
  const made: unknown[] = []
  const c = { getTools: over.getTools ?? (async () => [{ name: 'mcp__notes__search' }]), close: over.close ?? (async () => undefined) }
  return { made, make: (config: unknown) => (made.push(config), c as never) }
}

beforeEach(() => reg.listServers.mockReset())

describe('loadUserMcpTools', () => {
  it('a demo never loads any, and nothing is even read', async () => {
    const c = client()
    const out = await loadUserMcpTools(ctx({ isDemo: true }), c.make)
    expect(out.tools).toEqual([])
    expect(reg.listServers).not.toHaveBeenCalled()
    expect(c.made).toHaveLength(0)
  })

  it('connects an http server with its decrypted headers, a timeout, a prefix, and a skip for any that is down', async () => {
    reg.listServers.mockResolvedValue([row({ headers: 'enc' })])
    const c = client()
    const out = await loadUserMcpTools(ctx(), c.make)
    expect(out.tools).toHaveLength(1)
    expect(c.made[0]).toMatchObject({
      mcpServers: { notes: { transport: 'http', url: 'https://8.8.8.8/mcp', headers: { Authorization: 'Bearer decrypted-enc' } } },
      onConnectionError: 'ignore',
      defaultToolTimeout: MCP_TOOL_TIMEOUT_MS,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: 'mcp',
    })
  })

  it('leaves out a disabled server, a stdio server and an address it must not reach, and says why', async () => {
    reg.listServers.mockResolvedValue([
      row({ name: 'off', enabled: false }),
      row({ name: 'local', transport: 'stdio', url: 'npx something' }),
      row({ name: 'internal', url: 'http://10.0.0.5/mcp' }),
      row({ name: 'metadata', url: 'http://169.254.169.254/latest' }),
      row({ name: 'loop', url: 'http://127.0.0.1:3000/mcp' }),
      row({ name: 'fine', url: 'https://8.8.4.4/mcp' }),
    ])
    const c = client()
    const out = await loadUserMcpTools(ctx(), c.make)
    expect(Object.keys((c.made[0] as { mcpServers: object }).mcpServers)).toEqual(['fine'])
    expect(out.skipped.map((s) => s.name).sort()).toEqual(['internal', 'local', 'loop', 'metadata'])
    expect(out.skipped.find((s) => s.name === 'local')?.reason).toMatch(/only http and sse/)
  })

  it('opens no connection when no server passes the checks', async () => {
    reg.listServers.mockResolvedValue([row({ url: 'http://192.168.1.10/mcp' })])
    const c = client()
    const out = await loadUserMcpTools(ctx(), c.make)
    expect(c.made).toHaveLength(0)
    expect(out.tools).toEqual([])
  })

  it('a client that fails to list tools costs the turn nothing and is closed', async () => {
    reg.listServers.mockResolvedValue([row()])
    const close = vi.fn(async () => undefined)
    const c = client({ getTools: async () => Promise.reject(new Error('connection refused')), close })
    const out = await loadUserMcpTools(ctx(), c.make)
    expect(out.tools).toEqual([])
    expect(out.skipped[0].reason).toMatch(/refused/)
    expect(close).toHaveBeenCalled()
  })

  it('close shuts the client', async () => {
    reg.listServers.mockResolvedValue([row()])
    const close = vi.fn(async () => undefined)
    const out = await loadUserMcpTools(ctx(), client({ close }).make)
    await out.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
