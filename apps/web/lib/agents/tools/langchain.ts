// The registry as LangChain tools, for the agents.

import { ToolMessage } from '@langchain/core/messages'
import { tool, type ToolRuntime } from '@langchain/core/tools'
import { isGraphBubbleUp } from '@langchain/langgraph'
import type { AgentContext } from '../context'
import { isBudgetCapError } from '../spend-port'
import { isToolFix } from './common'
import { CELLO_TOOLS } from './registry'

export interface ToAgentToolsOptions {
  /** Only these tools. The Researcher holds two; the orchestrator holds all of them. */
  names?: readonly string[]
}

/**
 * One LangChain tool per registry entry. A result is JSON text. An error the tool
 * returns on purpose ({error, fix}) comes back as an error message the model can act
 * on. A thrown error is turned into one too, except the ones that must travel up: a
 * graph interrupt, and the budget cap (so the fallback and the person's message work).
 */
export function toAgentTools(ctx: AgentContext, opts: ToAgentToolsOptions = {}) {
  const defs = opts.names ? CELLO_TOOLS.filter((t) => opts.names!.includes(t.name)) : CELLO_TOOLS
  return defs.map((def) =>
    tool(
      async (args: Record<string, unknown>, runtime: ToolRuntime) => {
        const state = (runtime.state ?? {}) as { messages?: unknown[] }
        let result: unknown
        try {
          result = await def.handler(ctx, args, {
            toolCallId: runtime.toolCallId,
            channel: 'agent',
            messages: (state.messages ?? []) as never,
            config: runtime,
          })
        } catch (e) {
          if (isGraphBubbleUp(e) || isBudgetCapError(e)) throw e
          result = { error: `${def.name} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, fix: 'Try again once, or tell the person it did not work.' }
        }
        const text = JSON.stringify(result)
        if (isToolFix(result)) return new ToolMessage({ content: text, tool_call_id: runtime.toolCallId, name: def.name, status: 'error' })
        return text
      },
      { name: def.name, description: def.description, schema: def.schema }
    )
  )
}
