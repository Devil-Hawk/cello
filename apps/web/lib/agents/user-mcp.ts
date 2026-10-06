// The person's own MCP servers, as tools for the orchestrator.
//
// A server is something the person configured (a notes app, a calendar), so it is
// third-party: its tool names, descriptions and results are all text someone else
// controls. Before any connection is made, each server's address passes the same checks the
// existing MCP client uses (http or https, no private, loopback or metadata address, DNS
// resolved and checked). Headers are decrypted only here, in memory, for the connection.
// A server that is down or refused is skipped, never fatal. Every tool is named
// mcp__<server>__<tool>, so it can never collide with a Cello tool, and every result reaches
// the model quoted as data (CelloUntrusted). A demo never loads any.

import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { listServers, toConfig } from '@/lib/mcp/registry'
import { checkSsrf } from '@/lib/security/untrusted'
import type { AgentContext } from './context'

/** One tool call to a server may take this long. */
export const MCP_TOOL_TIMEOUT_MS = 20_000

export interface UserMcpTools {
  tools: StructuredToolInterface[]
  /** Servers that were left out, and why, for the log. */
  skipped: { name: string; reason: string }[]
  close: () => Promise<void>
}

const none = (skipped: UserMcpTools['skipped'] = []): UserMcpTools => ({ tools: [], skipped, close: async () => undefined })

export async function loadUserMcpTools(
  ctx: Pick<AgentContext, 'admin' | 'userId' | 'isDemo'>,
  // Test seam: the adapter client.
  makeClient: (config: ConstructorParameters<typeof MultiServerMCPClient>[0]) => Pick<MultiServerMCPClient, 'getTools' | 'close'> = (c) => new MultiServerMCPClient(c)
): Promise<UserMcpTools> {
  if (ctx.isDemo) return none()
  const rows = (await listServers(ctx.admin, ctx.userId)).filter((r) => r.enabled)
  const mcpServers: Record<string, { transport: 'http' | 'sse'; url: string; headers?: Record<string, string> }> = {}
  const skipped: UserMcpTools['skipped'] = []

  for (const row of rows) {
    // A stdio server runs a program on the host, which a serverless function must not do.
    if (row.transport !== 'http' && row.transport !== 'sse') {
      skipped.push({ name: row.name, reason: 'only http and sse servers can be used here' })
      continue
    }
    if (!row.url) {
      skipped.push({ name: row.name, reason: 'no address' })
      continue
    }
    const check = await checkSsrf(row.url)
    if (!check.ok) {
      skipped.push({ name: row.name, reason: check.message })
      continue
    }
    const config = toConfig(row)
    mcpServers[row.name] = { transport: row.transport, url: row.url, ...(Object.keys(config.headers).length ? { headers: config.headers } : {}) }
  }
  if (Object.keys(mcpServers).length === 0) return none(skipped)

  const client = makeClient({
    mcpServers,
    // A server that cannot connect is left out rather than failing the turn.
    onConnectionError: 'ignore',
    defaultToolTimeout: MCP_TOOL_TIMEOUT_MS,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: 'mcp',
    useStandardContentBlocks: true,
  } as never)
  try {
    const tools = await client.getTools()
    return { tools: tools as StructuredToolInterface[], skipped, close: () => client.close().catch(() => undefined) as Promise<void> }
  } catch (e) {
    skipped.push({ name: '(all)', reason: e instanceof Error ? e.message : String(e) })
    await client.close().catch(() => undefined)
    return none(skipped)
  }
}
