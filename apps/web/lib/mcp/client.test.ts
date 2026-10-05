// Unit tests for lib/mcp/client.ts's testable-without-a-real-server surface:
// pure command-line parsing, the stdio self-hosted gate, and the
// timeout/failure-isolation contract against a connection that is guaranteed
// to fail fast (nothing listens on 127.0.0.1:1 — a reserved/unassigned port —
// so this is deterministic and needs no network access, unlike a real
// integration test against a live MCP server).
//
// A genuine LIVE connection (real @modelcontextprotocol/server-everything
// reference server over stdio, via this exact module) was also exercised
// manually during development — see the MCP-builder task report for that
// transcript. That's evidence, not a repo artifact: it spawns a subprocess
// over npx, which would make CI flaky/slow, so it isn't checked in as a test.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callMcpTool, isStdioAvailable, listMcpTools, splitCommandLine, testMcpServer } from './client'
import { McpError, type McpServerConfig } from './types'

describe('splitCommandLine', () => {
  it('splits plain space-separated args', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-everything')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-everything',
    ])
  })

  it('honors double and single quoted segments as one arg', () => {
    expect(splitCommandLine('node server.js --name "my server" --flag')).toEqual([
      'node',
      'server.js',
      '--name',
      'my server',
      '--flag',
    ])
    expect(splitCommandLine("cmd --path 'a b/c'")).toEqual(['cmd', '--path', 'a b/c'])
  })

  it('returns [] for an empty string', () => {
    expect(splitCommandLine('')).toEqual([])
    expect(splitCommandLine('   ')).toEqual([])
  })
})

describe('isStdioAvailable', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is false by default: no flag means no stdio, even off Vercel', () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('CELLO_SELF_HOSTED', '')
    expect(isStdioAvailable()).toBe(false)
  })

  it('is false for anything but the exact opt-in value', () => {
    vi.stubEnv('VERCEL', '')
    for (const v of ['0', 'true', 'yes', ' 1', '1 ']) {
      vi.stubEnv('CELLO_SELF_HOSTED', v)
      expect(isStdioAvailable()).toBe(false)
    }
  })

  it('is true when explicitly self-hosted and not on Vercel', () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    expect(isStdioAvailable()).toBe(true)
  })

  it('is false on Vercel even with the flag set (VERCEL is a hard veto)', () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    expect(isStdioAvailable()).toBe(false)
  })

  it('is the same answer as the provider gate, so they cannot drift', async () => {
    const { isSelfHosted } = await import('@/lib/harness/providers')
    for (const [vercel, flag] of [['', ''], ['', '1'], ['1', '1'], ['1', '']]) {
      vi.stubEnv('VERCEL', vercel)
      vi.stubEnv('CELLO_SELF_HOSTED', flag)
      expect(isSelfHosted()).toBe(isStdioAvailable())
    }
  })
})

describe('stdio gating enforced at connect time, not just isStdioAvailable()', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const stdioServer: McpServerConfig = {
    id: 'x',
    name: 'stdio-demo',
    transport: 'stdio',
    url: 'npx -y @modelcontextprotocol/server-everything',
    headers: {},
    enabled: true,
  }

  it('refuses a stdio server with a clear, non-throwing testMcpServer() result when "on Vercel"', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    const result = await testMcpServer(stdioServer)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/self-hosted/i)
  })

  it('refuses a stdio server off Vercel when CELLO_SELF_HOSTED is not set', async () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('CELLO_SELF_HOSTED', '')
    const result = await testMcpServer(stdioServer)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/self-hosted/i)
  })
})

describe('failure isolation — an unreachable server never throws through testMcpServer', () => {
  it('connecting to nothing (127.0.0.1:1) resolves {ok:false}, does not hang, does not throw', async () => {
    const server: McpServerConfig = {
      id: 'dead',
      name: 'dead-demo',
      transport: 'http',
      url: 'http://127.0.0.1:1/does-not-exist',
      headers: {},
      enabled: true,
    }
    const result = await testMcpServer(server, { timeoutMs: 3_000 })
    expect(result.ok).toBe(false)
  }, 10_000)

  it('listMcpTools/callMcpTool against the same dead server reject with McpError, not an arbitrary error', async () => {
    const server: McpServerConfig = {
      id: 'dead2',
      name: 'dead-demo-2',
      transport: 'http',
      url: 'http://127.0.0.1:1/does-not-exist',
      headers: {},
      enabled: true,
    }
    await expect(listMcpTools(server, { timeoutMs: 3_000 })).rejects.toBeInstanceOf(McpError)
    await expect(callMcpTool(server, 'whatever', {}, { timeoutMs: 3_000 })).rejects.toBeInstanceOf(McpError)
  }, 10_000)
})

describe('input validation', () => {
  it('rejects http/sse transports missing a url', async () => {
    const server: McpServerConfig = { id: 'x', name: 'no-url', transport: 'http', url: null, headers: {}, enabled: true }
    await expect(listMcpTools(server)).rejects.toBeInstanceOf(McpError)
  })

  it('rejects an invalid url', async () => {
    const server: McpServerConfig = { id: 'x', name: 'bad-url', transport: 'http', url: 'not a url', headers: {}, enabled: true }
    await expect(listMcpTools(server)).rejects.toBeInstanceOf(McpError)
  })
})
