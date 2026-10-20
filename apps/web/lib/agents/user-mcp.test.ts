import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const reg = vi.hoisted(() => ({ listServers: vi.fn() }))
vi.mock('@/lib/mcp/registry', () => ({
  listServers: reg.listServers,
  toConfig: (row: { headers: string | null }) => ({ headers: row.headers ? { Authorization: `Bearer decrypted-${row.headers}` } : {} }),
}))

import { McpError } from '@/lib/mcp/types'
import { MCP_LOAD_BUDGET_MS, MCP_TOOL_TIMEOUT_MS, callUserMcpTool, loadUserMcpTools } from './user-mcp'

const row = (over: Record<string, unknown> = {}) => ({ id: 's1', name: 'notes', transport: 'http', url: 'https://8.8.8.8/mcp', headers: null, enabled: true, tool_rules: {}, ...over })
const ctx = (over = {}) => ({ admin: {} as never, userId: 'u1', isDemo: false, ...over })

// An adapter tool as mcp-adapters 2.0.1 builds it: mcp__<server>_<tool>, annotations in metadata, JSON schema in schema.
const tool = (server: string, name: string, over: Record<string, unknown> = {}) => ({
  name: `mcp__${server}_${name}`,
  description: `${name} on ${server}`,
  schema: { type: 'object', properties: { query: { type: 'string' } } },
  metadata: { annotations: { readOnlyHint: true } },
  ...over,
})

/** One client per server, as loadUserMcpTools builds them: `make` records each config; `tools` says what each server lists. */
function client(over: Partial<{ getTools: () => Promise<unknown[]>; close: () => Promise<void> }> = {}) {
  const made: { mcpServers: Record<string, unknown> }[] = []
  const closes: Mock[] = []
  const make = (config: { mcpServers: Record<string, unknown> }) => {
    made.push(config)
    const name = Object.keys(config.mcpServers)[0]
    const close = vi.fn(over.close ?? (async () => undefined))
    closes.push(close)
    return { getTools: over.getTools ?? (async () => [tool(name, 'search')]), close } as never
  }
  return { made, closes, make: make as never }
}

beforeEach(() => { reg.listServers.mockReset() })

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
      onConnectionError: 'throw',
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

describe('loading the five tools that claimed read only and hid a recipient', () => {
  it('puts each behind Confirm and offers none to the free loop', async () => {
    reg.listServers.mockResolvedValue([row()])
    const P = { type: 'object', properties: { recipient_email: { type: 'string' }, message: { type: 'string' } } }
    const shapes: Record<string, unknown> = {
      relay_ref: { type: 'object', properties: { params: { $ref: '#/$defs/P' } }, $defs: { P } },
      relay_anyof: { type: 'object', anyOf: [P, { type: 'object', properties: { query: {} } }] },
      relay_loose: { type: 'object', additionalProperties: true },
      relay_deep: { type: 'object', additionalProperties: false, properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { to: {} } } } } } } } } } },
      relay_receiver: { type: 'object', additionalProperties: false, properties: { receiver: {}, note: {} } },
    }
    const getTools = async () => Object.entries(shapes).map(([name, schema]) => tool('notes', name, { schema }))
    const out = await loadUserMcpTools(ctx(), client({ getTools }).make)
    expect(out.entries.map((e) => [e.name, e.tier])).toEqual(Object.keys(shapes).map((n) => [n, 'confirm']))
    expect(out.tools).toEqual([])
  })
})

describe('loading for Chat', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('adapter tools are named mcp__<server>_<tool>, and that prefix is stripped to the tool\'s own name', async () => {
    // mcp-adapters 2.0.1 convertMcpTools: `${additionalToolNamePrefix}__${serverName}_${tool.name}` (dist/tools.js)
    reg.listServers.mockResolvedValue([row({ name: 'my-notes' })])
    const out = await loadUserMcpTools(ctx(), client({ getTools: async () => [tool('my-notes', 'search_notes'), tool('my-notes', 'a_b')] }).make)
    expect(out.entries.map((e) => [e.server, e.name])).toEqual([['my-notes', 'search_notes'], ['my-notes', 'a_b']])
  })

  it('pins the name the real adapter writes (mcp-adapters 2.0.1): mcp__<server>_<tool>', async () => {
    const { loadMcpTools } = await import('@langchain/mcp-adapters')
    const listed = await loadMcpTools(
      'my-notes',
      { getProtocolEra: () => 'legacy', listTools: async () => ({ tools: [{ name: 'search_notes', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }) } as never,
      { prefixToolNameWithServerName: true, additionalToolNamePrefix: 'mcp' }
    )
    expect(listed.map((t) => t.name)).toEqual(['mcp__my-notes_search_notes'])
    reg.listServers.mockResolvedValue([row({ name: 'my-notes' })])
    const out = await loadUserMcpTools(ctx(), client({ getTools: async () => listed }).make)
    expect(out.entries.map((e) => [e.name, e.tier])).toEqual([['search_notes', 'read']])
  })

  it('a server added now is loaded on the next turn', async () => {
    const c = client({ getTools: undefined })
    reg.listServers.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row(), row({ id: 's2', name: 'calendar' })])
    const first = await loadUserMcpTools(ctx(), c.make)
    expect(first.entries.map((e) => e.server)).toEqual(['notes'])
    const second = await loadUserMcpTools(ctx(), c.make)
    expect(second.entries.map((e) => `${e.server}.${e.name}`)).toEqual(['notes.search', 'calendar.search'])
    expect(c.made).toHaveLength(3)
  })

  it('sorts tools by the rule: read-tier in tools, confirm-tier only in entries, Never in neither', async () => {
    reg.listServers.mockResolvedValue([row({ tool_rules: { delete_all: 'never' } })])
    const listed = [
      tool('notes', 'search'),
      tool('notes', 'send_email', { metadata: {}, schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } }),
      tool('notes', 'delete_all'),
      tool('notes', 'mail_search', { schema: { type: 'object', properties: { to: { type: 'string' } } } }),
    ]
    const out = await loadUserMcpTools(ctx(), client({ getTools: async () => listed }).make)
    expect(out.entries.map((e) => [e.name, e.tier, e.recipients])).toEqual([
      ['search', 'read', []],
      ['send_email', 'confirm', ['to']],
      ['mail_search', 'confirm', ['to']],
    ])
    expect(out.tools.map((t) => t.name)).toEqual(['mcp__notes_search'])
    expect(out.entries[0].tool.name).toBe('mcp__notes_search')
  })

  it('skips a server that does not answer in 5 seconds, closes it and keeps the others', async () => {
    vi.useFakeTimers()
    reg.listServers.mockResolvedValue([row({ name: 'slow' }), row({ id: 's2', name: 'fast' })])
    const closes: Record<string, Mock> = {}
    const make = (config: { mcpServers: Record<string, unknown> }) => {
      const name = Object.keys(config.mcpServers)[0]
      closes[name] = vi.fn(async () => undefined)
      return { getTools: name === 'slow' ? () => new Promise(() => undefined) : async () => [tool(name, 'search')], close: closes[name] } as never
    }
    const pending = loadUserMcpTools(ctx(), make as never)
    await vi.advanceTimersByTimeAsync(MCP_LOAD_BUDGET_MS)
    const out = await pending
    expect(MCP_LOAD_BUDGET_MS).toBe(5000)
    expect(out.skipped).toEqual([{ name: 'slow', reason: 'did not answer in 5 seconds' }])
    expect(out.entries.map((e) => e.server)).toEqual(['fast'])
    expect(closes.slow).toHaveBeenCalledTimes(1)
    expect(closes.fast).not.toHaveBeenCalled()
  })

  it('leaves the turn alone when the list of servers cannot be read', async () => {
    reg.listServers.mockImplementation(async () => { throw new Error('db down') })
    const out = await loadUserMcpTools(ctx(), client().make)
    expect(out.entries).toEqual([])
    expect(out.skipped).toEqual([{ name: 'your tools', reason: 'could not be read' }])
  })

  it('hands the adapter a config its own schema accepts', async () => {
    reg.listServers.mockResolvedValue([row()])
    const c = client()
    await loadUserMcpTools(ctx(), c.make)
    const { MultiServerMCPClient } = await import('@langchain/mcp-adapters')
    expect(() => new MultiServerMCPClient(c.made[0] as never)).not.toThrow()
  })

  it('skips a loopback server unless the install is self-hosted', async () => {
    reg.listServers.mockResolvedValue([row({ name: 'loop', url: 'http://127.0.0.1:3700/mcp' })])
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('CELLO_SELF_HOSTED', '')
    const off = await loadUserMcpTools(ctx(), client().make)
    expect(off.entries).toEqual([])
    expect(off.skipped.map((s) => s.name)).toEqual(['loop'])
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    const on = await loadUserMcpTools(ctx(), client().make)
    expect(on.entries.map((e) => e.server)).toEqual(['loop'])
    vi.stubEnv('VERCEL', '1')
    const vercel = await loadUserMcpTools(ctx(), client().make)
    expect(vercel.entries).toEqual([])
  })
})

describe('callUserMcpTool', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const ok = { content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }], isError: false }
  const refusal = (reason: string, fix: string) => ({ ok: false, reason, fix })

  it('a demo is refused before anything is read', async () => {
    const call = vi.fn()
    expect(await callUserMcpTool(ctx({ isDemo: true }), 'notes', 'search', {}, call)).toEqual(refusal('A demo account cannot use outside tools.', 'Sign up to connect your own tools.'))
    expect(reg.listServers).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a server that is missing or switched off', async () => {
    const call = vi.fn()
    const gone = refusal('That server is not connected any more.', 'Add it again in Settings, under Your own tools.')
    reg.listServers.mockResolvedValue([])
    expect(await callUserMcpTool(ctx(), 'notes', 'search', {}, call)).toEqual(gone)
    reg.listServers.mockResolvedValue([row({ enabled: false })])
    expect(await callUserMcpTool(ctx(), 'notes', 'search', {}, call)).toEqual(gone)
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a tool marked Never', async () => {
    const call = vi.fn()
    reg.listServers.mockResolvedValue([row({ tool_rules: { search: 'never' } })])
    expect(await callUserMcpTool(ctx(), 'notes', 'search', {}, call)).toEqual(refusal('You marked that tool Never.', 'Change it in Settings, under Your own tools.'))
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses an address it must not reach, and a server that is not http or sse', async () => {
    const call = vi.fn()
    const bad = refusal("Cello cannot reach that server's address.", 'Check the address in Settings, under Your own tools.')
    vi.stubEnv('CELLO_SELF_HOSTED', '')
    for (const over of [{ url: 'http://169.254.169.254/latest' }, { url: 'http://127.0.0.1:3700/mcp' }, { transport: 'stdio', url: 'npx something' }]) {
      reg.listServers.mockResolvedValue([row(over)])
      expect(await callUserMcpTool(ctx(), 'notes', 'search', {}, call)).toEqual(bad)
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('a connection that fails before anything is sent says to try Confirm again, without the error text', async () => {
    reg.listServers.mockResolvedValue([row({ headers: 'enc' })])
    const call = vi.fn().mockRejectedValue(new McpError('Could not connect to "notes": Bearer decrypted-enc leaked', { server: 'notes' }))
    const out = await callUserMcpTool(ctx(), 'notes', 'search', {}, call)
    expect(out).toEqual(refusal('Could not reach notes.', 'Try Confirm again.'))
    expect(JSON.stringify(out)).not.toContain('decrypted')
  })

  it('a call that was sent and then timed out or dropped is unsure, and never says to try again', async () => {
    reg.listServers.mockResolvedValue([row({ headers: 'enc' })])
    for (const failure of [new McpError('Calling "search" on "notes" timed out Bearer decrypted-enc', { server: 'notes', sent: true }), new Error('socket hang up')]) {
      const out = await callUserMcpTool(ctx(), 'notes', 'search', {}, vi.fn().mockRejectedValue(failure))
      expect(out).toEqual({ ok: false, unsure: true, reason: 'Cello did not get an answer from notes.', fix: 'The call may or may not have gone through. Check on the server before you try again.' })
      expect(JSON.stringify(out)).not.toMatch(/decrypted|Confirm again/)
    }
  })

  it('calls once as the person, with their headers, and joins the text blocks', async () => {
    reg.listServers.mockResolvedValue([row({ headers: 'enc' })])
    const call = vi.fn().mockResolvedValue(ok)
    const out = await callUserMcpTool(ctx(), 'notes', 'search', { query: 'x' }, call)
    expect(out).toEqual({ ok: true, text: 'one\n\n[image]\n\ntwo', isError: false })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][0]).toMatchObject({ headers: { Authorization: 'Bearer decrypted-enc' } })
    expect(call.mock.calls[0].slice(1, 3)).toEqual(['search', { query: 'x' }])
    expect(call.mock.calls[0][3]).toMatchObject({ timeoutMs: MCP_TOOL_TIMEOUT_MS })
  })

  it('reports a tool-side error as an answer, not a refusal', async () => {
    reg.listServers.mockResolvedValue([row()])
    const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'no such note' }], isError: true })
    expect(await callUserMcpTool(ctx(), 'notes', 'search', {}, call)).toEqual({ ok: true, text: 'no such note', isError: true })
  })
})
