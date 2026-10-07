// Guard middleware: the rules every agent loop runs under, as code.
//
// createCelloAgent (lib/agents/factory.ts) attaches guardStack() to the
// orchestrator and to the Researcher, so no agent can be built without it. The
// order below is outermost first (langchain composes wrapModelCall and
// wrapToolCall in array order):
//
//   CelloDemoRules, modelCallLimit, toolCallLimit, contextEditing, CelloDeadline,
//   modelFallback, modelRetry, CelloSpend, CelloUntrusted, toolRetry
//
// - Retry sits inside fallback, so the chosen model is retried on a 429 before
//   the call moves to a free model.
// - CelloSpend is innermost on the model path, so every real attempt, each
//   fallback included, reserves and settles its own cost.
// - A BudgetCapError from CelloSpend is not retried; it reaches fallback, which
//   moves to the free list (a free model reserves $0). A demo has an empty
//   list, so the error reaches the person as plain copy.
// - Summarization is not here: Deep Agents adds langchain's summarization
//   middleware itself, with offload to the backend. Adding it twice would
//   summarize twice (factory.test.ts asserts it is present once).

import {
  ClearToolUsesEdit,
  contextEditingMiddleware,
  countTokensApproximately,
  createMiddleware,
  modelCallLimitMiddleware,
  modelFallbackMiddleware,
  modelRetryMiddleware,
  toolCallLimitMiddleware,
  toolRetryMiddleware,
  type AgentMiddleware,
} from 'langchain'
import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { Command, interrupt, isCommand } from '@langchain/langgraph'
import { scrubStructuralEscapes } from '@/lib/security/job-text'
import { isTransient } from '@/lib/util/retry'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { celloChatModel, freeFallbackModels, isFreeModel } from './model'
import { isBudgetCapError, reserve, rootCause, settle } from './spend-port'
import { isUntrustedTool, MCP_TOOL_PREFIX } from './tool-names'

export const DEMO_SEND_REFUSAL = 'Demo accounts can draft but not send.'
export const DEMO_MCP_REFUSAL = 'Demo accounts cannot use outside tools.'

/** The caps per agent loop. The orchestrator is the only one allowed to delegate (task). */
export const AGENT_CAPS = {
  orchestrator: { modelCalls: 24, toolCalls: 30, delegations: 4 },
  researcher: { modelCalls: 8, toolCalls: 12, delegations: 0 },
} as const

export type AgentKind = keyof typeof AGENT_CAPS

export interface GuardContext {
  admin: AdminClient
  userId: string
  apiKeys: DecryptedApiKeys
  isDemo: boolean
  traceId: string
  chatTurnId?: string
}

// --- spend --------------------------------------------------------------------------

/** The OpenRouter id of the model a request is aimed at. An unknown model prices at the highest rate. */
export function modelIdOf(model: unknown): string {
  const m = model as { model?: unknown; modelName?: unknown } | null
  if (typeof m?.model === 'string') return m.model
  if (typeof m?.modelName === 'string') return m.modelName
  return 'unknown'
}

function maxTokensOf(model: unknown): number {
  const n = (model as { maxTokens?: unknown } | null)?.maxTokens
  return typeof n === 'number' && n > 0 ? n : 4096
}

function usageOf(message: unknown): { promptTokens: number; completionTokens: number; model?: string } {
  const m = message as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number }
    response_metadata?: { model_name?: string; model?: string; tokenUsage?: { promptTokens?: number; completionTokens?: number } }
  }
  const meta = m?.response_metadata
  return {
    promptTokens: m?.usage_metadata?.input_tokens ?? meta?.tokenUsage?.promptTokens ?? 0,
    completionTokens: m?.usage_metadata?.output_tokens ?? meta?.tokenUsage?.completionTokens ?? 0,
    model: meta?.model_name ?? meta?.model,
  }
}

/**
 * Reserve before every model call and settle after it. The reserve and settle
 * functions are the seam in spend-port.ts; this file adds no budget check.
 * A call that throws after reserving settles as failed: the provider's refusal
 * is charged nothing, and any other failure stays reserved for the sweeper.
 */
export function celloSpend(ctx: Pick<GuardContext, 'admin' | 'userId' | 'traceId' | 'chatTurnId'>) {
  return createMiddleware({
    name: 'CelloSpend',
    wrapModelCall: async (request, handler) => {
      const model = modelIdOf(request.model)
      const messages: BaseMessage[] = [request.systemMessage, ...request.messages]
      const reservation = await reserve({
        admin: ctx.admin,
        userId: ctx.userId,
        model,
        promptTokens: countTokensApproximately(messages),
        maxTokens: maxTokensOf(request.model),
        traceId: ctx.traceId,
        chatTurnId: ctx.chatTurnId,
      })
      try {
        const response = await handler(request)
        const { model: answeredBy, ...tokens } = usageOf(response)
        // OpenRouter may have answered from a free model through its own fallback list.
        await settle(reservation, { model: answeredBy && isFreeModel(answeredBy) ? answeredBy : model, ...tokens })
        return response
      } catch (err) {
        await settle(reservation, { failed: err })
        throw err
      }
    },
  })
}

// --- demo rules ---------------------------------------------------------------------

function refusal(request: { toolCall: { id?: string; name: string } }, text: string): ToolMessage {
  return new ToolMessage({
    content: JSON.stringify({ error: text }),
    tool_call_id: request.toolCall.id ?? '',
    name: request.toolCall.name,
    status: 'error',
  })
}

/**
 * For a demo account: no send or submit, and no outside tools. The tool list
 * stays the same (a changing list breaks prompt caching); the call is refused.
 */
export function celloDemoRules(ctx: Pick<GuardContext, 'isDemo'>) {
  return createMiddleware({
    name: 'CelloDemoRules',
    wrapToolCall: async (request, handler) => {
      if (!ctx.isDemo) return handler(request)
      const { name, args } = request.toolCall
      if (name === 'request_approval') {
        const action = (args as { action?: unknown } | undefined)?.action
        if (action === 'send_email' || action === 'submit_application') return refusal(request, DEMO_SEND_REFUSAL)
      }
      if (name.startsWith(MCP_TOOL_PREFIX)) return refusal(request, DEMO_MCP_REFUSAL)
      return handler(request)
    },
  })
}

// --- untrusted text -----------------------------------------------------------------

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const DATA_URL = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,][^\s)"'<>]*/gi
const URL_WITH_QUERY = /https?:\/\/[^\s)"'<>\\]+/g
const CLOSING_TAG = /<\/?\s*untrusted_data/gi
/** A long query string is a place to hide data; the path is enough to cite a page. */
const MAX_QUERY_CHARS = 100

/** Text made safe to show a model as a quotation: no images, no data URLs, no long query strings, no fake structure. */
export function sanitizeUntrusted(text: string): string {
  return scrubStructuralEscapes(text)
    .replace(MARKDOWN_IMAGE, '[image removed]')
    .replace(DATA_URL, '[data url removed]')
    .replace(URL_WITH_QUERY, (url) => {
      const q = url.indexOf('?')
      return q >= 0 && url.length - q > MAX_QUERY_CHARS ? `${url.slice(0, q)}?[query removed]` : url
    })
    .replace(CLOSING_TAG, '[tag removed]')
}

export function quoteUntrusted(source: string, text: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64)
  return `<untrusted_data source="${safeSource}">\n${sanitizeUntrusted(text)}\n</untrusted_data>`
}

function contentText(content: ToolMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Results that carry other people's text reach the model as quoted data.
 * The system prompt says what the quotation means; this makes sure the text
 * cannot close it, show an image, or carry a data URL out.
 */
export function celloUntrusted() {
  const quote = (name: string, m: ToolMessage) =>
    new ToolMessage({ content: quoteUntrusted(name, contentText(m.content)), tool_call_id: m.tool_call_id, name: m.name, status: m.status, artifact: m.artifact })
  return createMiddleware({
    name: 'CelloUntrusted',
    wrapToolCall: async (request, handler) => {
      const result = await handler(request)
      const name = request.toolCall.name
      if (!isUntrustedTool(name)) return result
      if (ToolMessage.isInstance(result)) return quote(name, result)
      // The task tool returns a Command carrying the specialist's answer as a message in its state update.
      const update = isCommand(result) ? (result.update as { messages?: unknown[] } | [string, unknown][] | undefined) : undefined
      if (update && !Array.isArray(update) && Array.isArray(update.messages)) {
        const messages = update.messages.map((m) => (ToolMessage.isInstance(m) ? quote(name, m) : m))
        return new Command({ ...(result as Command), update: { ...update, messages } })
      }
      return result
    },
  })
}

// --- slices -------------------------------------------------------------------------

/**
 * Past the request's deadline, stop before the next model call. The checkpoint
 * is already saved, so the route fires a continuation that resumes here. Only
 * the orchestrator and the Researcher loop, so only they need it.
 */
export function celloDeadline(deadlineAt: number) {
  return createMiddleware({
    name: 'CelloDeadline',
    beforeModel: () => {
      if (Date.now() > deadlineAt) interrupt({ kind: 'slice' })
      return undefined
    },
  })
}

// --- the stack ----------------------------------------------------------------------

export interface GuardStackOptions {
  ctx: GuardContext
  agent: AgentKind
  deadlineAt: number
  /** Test seam: fallback models to use instead of the free list. */
  fallbacks?: Parameters<typeof modelFallbackMiddleware>
}

/** Retry only what is worth retrying: not a cap, not a missing key. */
const retryable = (err: Error): boolean => !isBudgetCapError(err) && isTransient(rootCause(err))

export function guardStack(opts: GuardStackOptions): AgentMiddleware[] {
  const { ctx, agent, deadlineAt } = opts
  const caps = AGENT_CAPS[agent]
  const purpose = agent === 'researcher' ? 'researcher' : 'orchestrator'
  // A demo gets no free top-up past its cap.
  const fallbacks = ctx.isDemo
    ? []
    : (opts.fallbacks ?? freeFallbackModels().map((id) => celloChatModel({ apiKeys: ctx.apiKeys, model: id, purpose })))

  const stack: unknown[] = [
    celloDemoRules(ctx),
    modelCallLimitMiddleware({ runLimit: caps.modelCalls, exitBehavior: 'end' }),
    toolCallLimitMiddleware({ runLimit: caps.toolCalls, exitBehavior: 'continue' }),
    ...(caps.delegations > 0
      ? [toolCallLimitMiddleware({ toolName: 'task', runLimit: caps.delegations, exitBehavior: 'continue' })]
      : []),
    contextEditingMiddleware({ edits: [new ClearToolUsesEdit({ trigger: { tokens: 60_000 }, keep: { messages: 3 } })] }),
    celloDeadline(deadlineAt),
    modelFallbackMiddleware(...fallbacks),
    modelRetryMiddleware({ maxRetries: 3, backoffFactor: 2, initialDelayMs: 500, retryOn: retryable, onFailure: 'error' }),
    celloSpend(ctx),
    celloUntrusted(),
    toolRetryMiddleware({ maxRetries: 2, backoffFactor: 2, initialDelayMs: 300, retryOn: (err: Error) => isTransient(rootCause(err)) }),
  ]
  return stack as AgentMiddleware[]
}

/** The names, in order, for the factory test. */
export const GUARD_ORDER = [
  'CelloDemoRules',
  'ModelCallLimitMiddleware',
  'ToolCallLimitMiddleware',
  'ContextEditingMiddleware',
  'CelloDeadline',
  'modelFallbackMiddleware',
  'modelRetryMiddleware',
  'CelloSpend',
  'CelloUntrusted',
  'toolRetryMiddleware',
] as const
