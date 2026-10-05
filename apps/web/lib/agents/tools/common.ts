// What every tool shares: the definition shape, the two argument conventions
// (read tools take response_format and limit, write tools take an idempotency key),
// and the actionable error.

import { z } from 'zod'
import type { BaseMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { AgentContext } from '../context'
import type { CelloToolName } from '../tool-names'

/** Where a call came from. Over MCP there is no conversation, so tools that need one refuse. */
export interface ToolMeta {
  toolCallId: string
  channel: 'agent' | 'mcp'
  /** The messages of this conversation, for tools that must check the person's own words. */
  messages: readonly BaseMessage[]
  config?: RunnableConfig
}

export interface CelloTool<S extends z.ZodObject = z.ZodObject> {
  name: CelloToolName
  description: string
  schema: S
  /** Read tools change nothing the person did not ask for; write tools save, queue or schedule something. */
  kind: 'read' | 'write'
  /** Results carry text other people wrote, so they reach the model quoted as data. */
  untrusted: boolean
  /** Whether the tool is also served over MCP. The ones that need the conversation are not. */
  mcp: boolean
  handler: (ctx: AgentContext, args: z.infer<S>, meta: ToolMeta) => Promise<unknown>
}

export function defineTool<S extends z.ZodObject>(tool: CelloTool<S>): CelloTool<S> {
  return tool
}

/** response_format and limit, on every read tool. */
export const readFields = {
  response_format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe('concise returns the fields needed to answer. detailed adds more fields and costs more tokens.'),
  limit: z.number().int().min(1).max(25).default(10).describe('How many results to return, 1 to 25.'),
}

/** The idempotency key, on every write tool. Cello fills it in; a caller that retries passes the same one. */
export const writeFields = {
  idempotency_key: z
    .string()
    .max(80)
    .optional()
    .describe('Leave out. Cello fills it in. Pass the same key to retry safely without doing the work twice.'),
}

export function keyFor(ctx: AgentContext, meta: ToolMeta, given?: string): string {
  return (given?.trim() || `${ctx.threadId}:${meta.toolCallId}`).slice(0, 160)
}

/** An error the model can act on: what went wrong and what to do next. */
export interface ToolFix {
  error: string
  fix: string
}

export const toolFix = (error: string, fix: string): ToolFix => ({ error, fix })

export const isToolFix = (v: unknown): v is ToolFix =>
  typeof v === 'object' && v !== null && typeof (v as ToolFix).error === 'string' && typeof (v as ToolFix).fix === 'string'

/** Keep only these keys of an object. */
export function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k))) as Partial<T>
}

export const clip = (text: string | null | undefined, max: number): string | null => {
  if (!text) return null
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
