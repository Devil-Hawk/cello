// The registry as Cello's own MCP server.
//
// The same list the agents use, so a tool has the same name, description and
// arguments in both places. Over MCP nothing is ever sent: request_approval queues
// a row the person approves in the web app, like everywhere else. Tools that need a
// conversation to check the person's own words (remember) are not served.

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentContext } from '../context'
import { isToolFix } from './common'
import { MCP_TOOLS } from './registry'

export function registerCelloTools(server: McpServer, ctx: AgentContext): void {
  for (const def of MCP_TOOLS) {
    server.registerTool(def.name, { title: def.name, description: def.description, inputSchema: def.schema.shape }, async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await def.handler({ ...ctx, autonomy: 'ask' }, args as never, { toolCallId: randomUUID(), channel: 'mcp', messages: [] })
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: isToolFix(result) }
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: `${def.name} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, fix: 'Try again once.' }) }],
        }
      }
    })
  }
}
