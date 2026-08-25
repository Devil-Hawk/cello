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

import { afterEach, describe, expect, it } from 'vitest'
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
  const original = process.env.VERCEL

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL
    else process.env.VERCEL = original
  })

  it('is true when VERCEL is unset (self-hosted / this sandbox)', () => {
    delete process.env.VERCEL
    expect(isStdioAvailable()).toBe(true)
  })

  it('is false on Vercel (VERCEL is always set there)', () => {
    process.env.VERCEL = '1'
    expect(isStdioAvailable()).toBe(false)
  })
})

describe('stdio gating enforced at connect time, not just isStdioAvailable()', () => {
  const original = process.env.VERCEL
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL
    else process.env.VERCEL = original
  })

  it('refuses a stdio server with a clear, non-throwing testMcpServer() result when "on Vercel"', async () => {
    process.env.VERCEL = '1'
    const server: McpServerConfig = {
      id: 'x',
      name: 'stdio-demo',
      transport: 'stdio',
      url: 'npx -y @modelcontextprotocol/server-everything',
      headers: {},
      enabled: true,
    }
    const result = await testMcpServer(server)
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
