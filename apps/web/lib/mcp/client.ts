// MCP (Model Context Protocol) client — connect to a USER-CONFIGURED third-party
// server, list its tools, and call one. Built on the official
// @modelcontextprotocol/sdk; this file never hand-rolls the wire protocol.
//
// FAILURE ISOLATION IS THE POINT: every exported function here is
// timeout-bounded and never leaves a connection open. A misbehaving or dead
// MCP server must degrade the copilot to its built-in tools, not hang or crash
// a turn — see lib/mcp/registry.ts (which calls these and swallows failures
// per-server) and lib/harness/copilot-tools.ts (which does the same at
// dispatch time). Nothing in this file throws anything but McpError, so
// callers can pattern-match on a single type.
//
// STDIO IS SELF-HOSTED ONLY. It spawns a child process, which a Vercel
// serverless function cannot do reliably (no persistent process control, and
// most serverless runtimes forbid child_process outright). isStdioAvailable()
// is the single source of truth for the gate — lib/mcp/registry.ts and
// components/settings/mcp-tab.tsx both defer to it so the UI and the runtime
// check agree.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpError, type McpServerConfig, type McpToolDescriptor } from './types'
import { assertSsrfSafe } from '@/lib/security/untrusted'

const CLIENT_NAME = 'cello-copilot'
const CLIENT_VERSION = '1.0.0'

/** Default per-operation budget (connect, list, or one tool call). Callers
 *  (registry prompt-block building, copilot-tools dispatch) pass their own
 *  tighter budget when they need to stay inside a larger request deadline. */
export const DEFAULT_MCP_TIMEOUT_MS = 10_000

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** True when running on Vercel (or anywhere `VERCEL` is set, which Vercel's
 *  build/runtime always sets) — the one place stdio's child_process.spawn
 *  cannot be relied on. Self-hosted deployments (bare Node, Docker, etc.)
 *  don't set this and stdio works normally there. */
export function isStdioAvailable(): boolean {
  return !process.env.VERCEL
}

/**
 * Split a shell-like command line into argv, honoring simple single/double
 * quoting (no full shell semantics — pipes, `&&`, env expansion, etc. are
 * deliberately not supported; this is "npx -y @scope/server --flag value",
 * not a shell). Good enough for the stdio config field, which is always
 * user-authored and self-hosted-only.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

function buildTransport(server: McpServerConfig): Transport {
  const headers = Object.keys(server.headers).length > 0 ? server.headers : undefined

  if (server.transport === 'http') {
    if (!server.url) throw new McpError('HTTP transport requires a url', { server: server.name })
    let url: URL
    try {
      url = new URL(server.url)
    } catch {
      throw new McpError(`Invalid url "${server.url}"`, { server: server.name })
    }
    return new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined })
  }

  if (server.transport === 'sse') {
    if (!server.url) throw new McpError('SSE transport requires a url', { server: server.name })
    let url: URL
    try {
      url = new URL(server.url)
    } catch {
      throw new McpError(`Invalid url "${server.url}"`, { server: server.name })
    }
    return new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined })
  }

  // stdio
  if (!isStdioAvailable()) {
    throw new McpError(
      'stdio MCP servers only work in a self-hosted deployment (no subprocesses on serverless). ' +
        'Use an http or sse server here, or run this instance yourself.',
      { server: server.name }
    )
  }
  if (!server.url) throw new McpError('stdio transport requires a command', { server: server.name })
  const [command, ...args] = splitCommandLine(server.url)
  if (!command) throw new McpError('stdio transport requires a non-empty command', { server: server.name })
  return new StdioClientTransport({
    command,
    args,
    env: headers, // stdio servers take config via env, not HTTP headers
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface McpConnection {
  client: Client
  close: () => Promise<void>
}

/** Connect to a server and complete the MCP initialize handshake. ALWAYS
 *  paired with connection.close() by every exported function below — never
 *  exported directly, so a caller can't forget to close it. */
async function connect(server: McpServerConfig, timeoutMs: number, signal?: AbortSignal): Promise<McpConnection> {
  // SSRF guard, here because `connect` is the single chokepoint every exported
  // function routes through — listMcpTools, callMcpTool and testMcpServer all
  // land here, so one check covers all three and none can be added later that
  // forgets it. It cannot live in buildTransport, which is synchronous while
  // this needs DNS resolution.
  //
  // An MCP server URL is supplied by the user and fetched by our server, which
  // is the textbook SSRF shape: "http://169.254.169.254/..." would make Cello
  // fetch the cloud metadata endpoint and hand the response back through the
  // copilot. Blocks loopback, link-local, RFC1918 and non-http(s) schemes,
  // including the decimal/octal/hex and userinfo obfuscations — see
  // lib/security/untrusted.ts.
  //
  // stdio has no URL to check (its `url` field carries a command line) and is
  // already gated behind isStdioAvailable() for self-hosted deployments only.
  if (server.transport === 'http' || server.transport === 'sse') {
    if (server.url) {
      try {
        await assertSsrfSafe(server.url)
      } catch (e) {
        throw new McpError(errMsg(e), { server: server.name })
      }
    }
  }

  let transport: Transport
  try {
    transport = buildTransport(server)
  } catch (e) {
    throw e instanceof McpError ? e : new McpError(errMsg(e), { server: server.name })
  }

  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} })

  try {
    await withTimeout(
      client.connect(transport, { timeout: timeoutMs, signal }),
      timeoutMs,
      `Connecting to MCP server "${server.name}"`
    )
  } catch (e) {
    await transport.close?.().catch(() => {})
    throw e instanceof McpError ? e : new McpError(`Could not connect to "${server.name}": ${errMsg(e)}`, { server: server.name })
  }

  return {
    client,
    close: async () => {
      try {
        await client.close()
      } catch {
        // best-effort — the connection is being torn down regardless
      }
    },
  }
}

/** List the tools a server currently advertises. Never throws anything but
 *  McpError; always closes the connection, success or failure. */
export async function listMcpTools(
  server: McpServerConfig,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<McpToolDescriptor[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
  const conn = await connect(server, timeoutMs, opts.signal)
  try {
    const res = await withTimeout(
      conn.client.listTools(undefined, { timeout: timeoutMs, signal: opts.signal }),
      timeoutMs,
      `Listing tools on "${server.name}"`
    )
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      destructiveHint: Boolean(t.annotations?.destructiveHint),
      readOnlyHint: Boolean(t.annotations?.readOnlyHint),
    }))
  } catch (e) {
    throw e instanceof McpError ? e : new McpError(`Could not list tools on "${server.name}": ${errMsg(e)}`, { server: server.name })
  } finally {
    await conn.close()
  }
}

export interface McpCallOutcome {
  isError: boolean
  /** The tool result's content blocks (text/image/resource), passed through
   *  as-is — this is UNTRUSTED third-party output. See the SAFETY note at the
   *  top of lib/mcp/types.ts: callers must present this as data, never as
   *  instructions. */
  content: unknown
}

/** Call one tool on a server. Never throws anything but McpError (a
 *  tool-reported failure comes back as `{isError: true, content}`, not a
 *  throw — same "errors are observations" convention as the built-in
 *  dispatchTool). Always closes the connection. */
export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<McpCallOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
  const conn = await connect(server, timeoutMs, opts.signal)
  try {
    const res = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs, signal: opts.signal }),
      timeoutMs,
      `Calling "${toolName}" on "${server.name}"`
    )
    return { isError: Boolean(res.isError), content: res.content ?? res }
  } catch (e) {
    throw e instanceof McpError ? e : new McpError(`Tool call "${toolName}" on "${server.name}" failed: ${errMsg(e)}`, { server: server.name })
  } finally {
    await conn.close()
  }
}

/** Connect + list tools, reporting outcome rather than throwing — this is
 *  what the settings "Test" button and the registry's health check call. */
export async function testMcpServer(
  server: McpServerConfig,
  opts: { timeoutMs?: number } = {}
): Promise<{ ok: true; toolCount: number; toolNames: string[] } | { ok: false; error: string }> {
  try {
    const tools = await listMcpTools(server, opts)
    return { ok: true, toolCount: tools.length, toolNames: tools.map((t) => t.name).slice(0, 25) }
  } catch (e) {
    return { ok: false, error: e instanceof McpError ? e.message : errMsg(e) }
  }
}
