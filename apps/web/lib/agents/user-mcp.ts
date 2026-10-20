// The person's own MCP servers, as tools for Chat and the orchestrator.
//
// A server is something the person configured (a notes app, a calendar), so it is
// third-party: its tool names, descriptions and results are all text someone else
// controls. Before any connection is made, each server's address passes checkMcpAddress
// (http or https, no private, link-local or metadata address, DNS resolved and checked;
// loopback only on a self-hosted install). Headers are decrypted only here, in memory,
// for the connection, and never logged. A server that is down, slow or refused is skipped,
// never fatal. Every tool is named mcp__<server>_<tool> by the adapter, so it can never
// collide with a Cello tool, and every result reaches the model quoted as data
// (CelloUntrusted). A demo never loads any.
//
// Each tool is sorted by lib/agents/mcp-rule.ts: read-tier tools may run freely, confirm-tier
// tools only after the person's Confirm (callUserMcpTool below), Never-tier tools are left out.

import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { listServers, toConfig } from '@/lib/mcp/registry'
import { callMcpTool, checkMcpAddress } from '@/lib/mcp/client'
import type { McpServerRow } from '@/lib/mcp/types'
import { classifyMcpTool, recipientKeys, type McpTier } from './mcp-rule'
import type { AgentContext } from './context'

/** One tool call to a server may take this long. */
export const MCP_TOOL_TIMEOUT_MS = 20_000
/** Listing one server's tools may take this long. */
export const MCP_LOAD_BUDGET_MS = 5_000

export interface UserMcpTool {
  /** The adapter's tool, named mcp__<server>_<tool> (mcp-adapters 2.0.1, dist/tools.js convertMcpTools). */
  tool: StructuredToolInterface
  /** The server's stored name. */
  server: string
  /** The tool's own name on that server. */
  name: string
  /** Never-tier tools are left out. */
  tier: Exclude<McpTier, 'never'>
  /** recipientKeys of its input schema. */
  recipients: string[]
}

export interface UserMcpTools {
  /** Read-tier tools only: what the orchestrator (lib/agents/run.ts) receives as extraTools. */
  tools: StructuredToolInterface[]
  /** Read and confirm tools with their tier, for Chat. */
  entries: UserMcpTool[]
  /** Servers that were left out, and why. Chat shows the names. */
  skipped: { name: string; reason: string }[]
  close: () => Promise<void>
}

const none = (skipped: UserMcpTools['skipped'] = []): UserMcpTools => ({ tools: [], entries: [], skipped, close: async () => undefined })

type Client = Pick<MultiServerMCPClient, 'getTools' | 'close'>
type ClientConfig = ConstructorParameters<typeof MultiServerMCPClient>[0]

/** The adapter writes `mcp__<server>_<tool>` for a client holding one server. */
const prefixOf = (server: string) => `mcp__${server}_`

function raceBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('did not answer in 5 seconds')), MCP_LOAD_BUDGET_MS)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

export async function loadUserMcpTools(
  ctx: Pick<AgentContext, 'admin' | 'userId' | 'isDemo'>,
  // Test seam: the adapter client.
  makeClient: (config: ClientConfig) => Client = (c) => new MultiServerMCPClient(c)
): Promise<UserMcpTools> {
  if (ctx.isDemo) return none()
  let rows: McpServerRow[]
  try {
    rows = (await listServers(ctx.admin, ctx.userId)).filter((r) => r.enabled)
  } catch {
    // A database hiccup costs the person their own tools for this turn, never the turn.
    return none([{ name: 'your tools', reason: 'could not be read' }])
  }
  const skipped: UserMcpTools['skipped'] = []
  const clients: Client[] = []
  const entries: UserMcpTool[] = []

  const load = async (row: McpServerRow) => {
    // A stdio server runs a program on the host, which a serverless function must not do.
    if (row.transport !== 'http' && row.transport !== 'sse') {
      skipped.push({ name: row.name, reason: 'only http and sse servers can be used here' })
      return
    }
    if (!row.url) {
      skipped.push({ name: row.name, reason: 'no address' })
      return
    }
    const check = await checkMcpAddress(row.url)
    if (!check.ok) {
      skipped.push({ name: row.name, reason: check.message })
      return
    }
    const config = toConfig(row)
    // One client per server, so one slow or dead server costs only itself.
    const client = makeClient({
      mcpServers: { [row.name]: { transport: row.transport, url: row.url, ...(Object.keys(config.headers).length ? { headers: config.headers } : {}) } },
      onConnectionError: 'throw',
      defaultToolTimeout: MCP_TOOL_TIMEOUT_MS,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: 'mcp',
    } as never)
    try {
      const listed = (await raceBudget(client.getTools())) as StructuredToolInterface[]
      const never = Object.keys(row.tool_rules ?? {})
      const prefix = prefixOf(row.name)
      for (const tool of listed) {
        const name = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
        const meta = (tool as { metadata?: { annotations?: { readOnlyHint?: boolean } } }).metadata
        const facts = { name, readOnlyHint: meta?.annotations?.readOnlyHint, inputSchema: (tool as { schema?: unknown }).schema }
        const tier = classifyMcpTool(facts, { never, isDemo: ctx.isDemo })
        if (tier !== 'never') entries.push({ tool, server: row.name, name, tier, recipients: recipientKeys(facts.inputSchema) })
      }
      clients.push(client)
    } catch (e) {
      skipped.push({ name: row.name, reason: e instanceof Error ? e.message : String(e) })
      await client.close().catch(() => undefined)
    }
  }

  // Servers load side by side, then entries are put back in the person's server order.
  const order = new Map(rows.map((r, i) => [r.name, i]))
  await Promise.all(rows.map(load))
  entries.sort((a, b) => (order.get(a.server) ?? 0) - (order.get(b.server) ?? 0))
  if (clients.length === 0) return none(skipped)
  return {
    tools: entries.filter((e) => e.tier === 'read').map((e) => e.tool),
    entries,
    skipped,
    close: async () => void (await Promise.all(clients.map((c) => c.close().catch(() => undefined)))),
  }
}

export type McpCallResult = { ok: true; text: string; isError: boolean } | { ok: false; reason: string; fix: string }

const SETTINGS_FIX = 'in Settings, under Your own tools.'
const refuse = (reason: string, fix: string): McpCallResult => ({ ok: false, reason, fix })

/** The text blocks of a tool result joined with blank lines; other blocks as [<type>]. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown }
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : `[${typeof block?.type === 'string' ? block.type : 'unknown'}]`
    })
    .join('\n\n')
}

/** One call to one server, as the person, from their Confirm. Same address check, same toConfig, a fresh connection (callMcpTool closes it). */
export async function callUserMcpTool(
  ctx: Pick<AgentContext, 'admin' | 'userId' | 'isDemo'>,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  call: typeof callMcpTool = callMcpTool
): Promise<McpCallResult> {
  if (ctx.isDemo) return refuse('A demo account cannot use outside tools.', 'Sign up to connect your own tools.')
  const row = (await listServers(ctx.admin, ctx.userId)).find((r) => r.name.toLowerCase() === server.toLowerCase())
  if (!row || !row.enabled) return refuse('That server is not connected any more.', `Add it again ${SETTINGS_FIX}`)
  if (row.tool_rules?.[tool] === 'never') return refuse('You marked that tool Never.', `Change it ${SETTINGS_FIX}`)
  // A stdio server has no address to reach from here; it gets the address copy, as it is skipped when loading.
  const check = row.transport === 'http' || row.transport === 'sse' ? (row.url ? await checkMcpAddress(row.url) : null) : null
  if (!check?.ok) return refuse("Cello cannot reach that server's address.", `Check the address ${SETTINGS_FIX}`)
  try {
    const out = await call(toConfig(row), tool, args, { timeoutMs: MCP_TOOL_TIMEOUT_MS })
    return { ok: true, text: textOf(out.content), isError: out.isError }
  } catch {
    // No error text: it can name the address or echo a header.
    return refuse(`Could not reach ${row.name}.`, 'Try Confirm again.')
  }
}
