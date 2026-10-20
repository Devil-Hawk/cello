// Guard middleware: the rules every agent loop runs under, as code.
//
// createCelloAgent (lib/agents/factory.ts) attaches guardStack() to the
// orchestrator and to the Researcher, so no agent can be built without it. The
// order below is outermost first (langchain composes wrapModelCall and
// wrapToolCall in array order):
//
//   CelloDemoRules, modelCallLimit, toolCallLimit, contextEditing, CelloDeadline,
//   modelFallback, modelRetry, CelloOneAnswer, CelloSpend, CelloUntrusted, toolRetry
//
// (Chat's loop also gets CelloTaskRows directly after CelloStop, inside it: one worker row per delegation
// to the Researcher. GUARD_ORDER lists the orchestrator's and the Researcher's stack, which have none.)
//
// - Retry sits inside fallback, so the chosen model is retried on a 429 before
//   the call moves to a free model.
// - CelloOneAnswer trims a doubled structured answer off the model's message and asks again, itself and a bounded
//   number of times, when the answer does not fit its shape (langchain's own retry breaks the after-model nodes). It
//   sits just outside CelloSpend, so each ask reserves and settles on its own, and CelloSpend still sees the provider's raw error.
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
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { Command, interrupt, isCommand } from '@langchain/langgraph'
import { scrubStructuralEscapes } from '@/lib/security/job-text'
import { isTransient } from '@/lib/util/retry'
import { STOP_POLL_MS, StoppedError, finishWorker, isStopped, openWorker, type WorkerScope } from '@/lib/chat/workers'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { celloChatModel, freeFallbackModels, isFreeModel, runTagOf } from './model'
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

/**
 * Graph steps one model call can take with the guard stack on (measured in factory.test.ts: 7, with the call
 * limits' nodes before and after the model, and the tools). The step limit is only a backstop, so it has to sit
 * above what the model-call cap allows, or a long turn dies of the backstop before the cap can end it politely.
 */
const STEPS_PER_MODEL_CALL = 8

export const recursionLimitFor = (agent: AgentKind): number => AGENT_CAPS[agent].modelCalls * STEPS_PER_MODEL_CALL + 16

export interface GuardContext {
  admin: AdminClient
  userId: string
  apiKeys: DecryptedApiKeys
  isDemo: boolean
  traceId: string
  chatTurnId?: string
  /** The role this loop is: written on every ledger row it makes. */
  role?: 'chat' | 'researcher'
  /** The row's Stop flag, checked before every model and tool call. */
  stop?: () => Promise<boolean>
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
export function celloSpend(ctx: Pick<GuardContext, 'admin' | 'userId' | 'traceId' | 'chatTurnId' | 'role'>) {
  return createMiddleware({
    name: 'CelloSpend',
    wrapModelCall: async (request, handler) => {
      // A model built for the person's choice says which way in it uses and the effort it was given; a fallback
      // (built in this file's stack) carries no tag, is an OpenRouter free id and was given no thinking setting.
      const tag = runTagOf(request.model)
      const id = modelIdOf(request.model)
      const model = tag && (tag.via === 'openai' || tag.via === 'anthropic') ? `${tag.via}/${id}` : id
      const messages: BaseMessage[] = [request.systemMessage, ...request.messages]
      const reservation = await reserve({
        admin: ctx.admin,
        userId: ctx.userId,
        model,
        promptTokens: countTokensApproximately(messages),
        maxTokens: maxTokensOf(request.model),
        traceId: ctx.traceId,
        chatTurnId: ctx.chatTurnId,
        role: ctx.role,
        effort: tag?.effort ?? null,
        rung: tag?.rung,
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

/**
 * Stop is a row, read before every provider attempt and every tool attempt. This sits inside the retry and
 * fallback middleware and outside CelloSpend, so a retry or a step-down after Stop reserves nothing and calls
 * nobody. A StoppedError is never transient, so neither retry middleware tries again.
 */
export function celloStop(isStopped: () => Promise<boolean>) {
  return createMiddleware({
    name: 'CelloStop',
    wrapModelCall: async (request, handler) => {
      if (await isStopped()) throw new StoppedError()
      return handler(request)
    },
    wrapToolCall: async (request, handler) => {
      if (await isStopped()) throw new StoppedError()
      return handler(request)
    },
  })
}

/**
 * Each delegation to the Researcher (the `task` tool) is a worker row in the thread with its own Stop. Stop is
 * polled every STOP_POLL_MS while the delegation runs; a stopped row ends stopped and the loop gets a plain
 * result to answer from. Not withWorker: that would mark a stopped row done. A row that could not be written
 * (openWorker gives null) never stops the research.
 */
export function celloTaskRows(scope: WorkerScope) {
  return createMiddleware({
    name: 'CelloTaskRows',
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== 'task') return handler(request)
      const args = (request.toolCall.args ?? {}) as { description?: unknown }
      const title = 'Research: ' + String(args.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const rowId = await openWorker(scope, { command: 'research', title })
      let timer: ReturnType<typeof setInterval> | undefined
      const stopped = new Promise<'stopped'>((resolve) => {
        timer = setInterval(() => void isStopped(scope.db, rowId).then((yes) => yes && resolve('stopped')), STOP_POLL_MS)
        timer.unref?.()
      })
      try {
        // ponytail: a stopped Researcher is not aborted; its call ends on its own and the result is dropped.
        const out = await Promise.race([handler(request), stopped])
        if (out === 'stopped') {
          await finishWorker(scope.db, rowId, { status: 'stopped' })
          return new ToolMessage({ content: 'The person stopped this research. Answer with what you have.', tool_call_id: request.toolCall.id ?? '', name: 'task' })
        }
        await finishWorker(scope.db, rowId, { status: 'done' })
        return out
      } catch (e) {
        await finishWorker(scope.db, rowId, { status: 'failed', summary: e instanceof Error ? e.message : 'Failed' })
        throw e
      } finally {
        clearInterval(timer)
      }
    },
  })
}

// --- one structured answer -----------------------------------------------------------

const isAnswerCall = (c: { name?: string }) => c.name?.startsWith('extract-') === true

/** The message with only the calls `keep` returns true for, everywhere a provider format keeps them. */
function keepCalls(m: AIMessage, keep: (c: { id?: string; name?: string }) => boolean): AIMessage {
  const calls = m.tool_calls ?? []
  const dropped = new Set(calls.filter((c) => !keep(c)).map((c) => c.id))
  if (!dropped.size) return m
  const kept = <T extends { id?: string }>(c: T) => !dropped.has(c.id)
  const kwargs = m.additional_kwargs
  return new AIMessage({
    content: Array.isArray(m.content) ? m.content.filter((b) => kept(b as { id?: string })) : m.content,
    tool_calls: calls.filter(kept),
    additional_kwargs: kwargs.tool_calls ? { ...kwargs, tool_calls: kwargs.tool_calls.filter(kept) } : kwargs,
    response_metadata: m.response_metadata,
    usage_metadata: m.usage_metadata,
    id: m.id,
    name: m.name,
  })
}

/** A model may write its structured answer twice in one message: the first one is the answer. */
function firstAnswerOnly(m: AIMessage): AIMessage {
  const first = (m.tool_calls ?? []).find(isAnswerCall)
  return keepCalls(m, (c) => !isAnswerCall(c) || c === first)
}

/** What a model is told when its answer does not fit: where, and what was wrong. Never shown to a person. */
function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : 'answer'}: ${i.message}`)
    .join('; ')
    .slice(0, 600)
}

/** The most times Cello asks a model for one answer: the first ask and two more. */
export const MAX_ANSWER_ASKS = 3

export class AnswerShapeError extends Error {
  constructor(detail: string) {
    super(`The model's answer did not fit the shape after ${MAX_ANSWER_ASKS} tries: ${detail}`)
    this.name = 'AnswerShapeError'
  }
}

export interface AnswerShape {
  safeParse: (v: unknown) => { success: boolean; error?: unknown }
}

/**
 * One structured answer, and one bounded retry that is Cello's own.
 *
 * langchain meets a bad structured answer (two of them in one message, or one that does not fit the schema)
 * after the model returns, and answers it with a retry Command that goes back to the model node. That node
 * keeps its edge into the after-model nodes too, so the retried model call and the first call's chain of
 * after-model nodes (the model, tool and delegation limits) run one step apart, two of them land in one
 * step, and each writes `jumpTo`: InvalidUpdateError, and the turn dies. It also lets a model that keeps
 * failing loop until the step limit. langchain decides before any middleware sees the message, so this wraps
 * the model itself. It keeps the first answer, checks it against the schema, and when it does not fit it
 * hides the message from langchain (an empty plain one with the same usage, which langchain passes through),
 * then asks again from here with the reason, at most MAX_ANSWER_ASKS times, reading Stop before each ask.
 * Every ask goes through CelloSpend, which sits inside this. createCelloAgent also turns langchain's own
 * retry off for the answer (handleError false), so anything this misses ends the turn with a plain error.
 */
export function celloOneAnswer(opts: { answer?: AnswerShape; stop?: () => Promise<boolean> } = {}) {
  type Bound = { invoke: (...args: unknown[]) => Promise<unknown> }
  type Misfit = { message: AIMessage; why: string }
  return createMiddleware({
    name: 'CelloOneAnswer',
    wrapModelCall: async (request, handler) => {
      const model = request.model as unknown as { bindTools?: (...args: unknown[]) => Bound }
      if (typeof model.bindTools !== 'function') return handler(request)
      const seen: { misfit: Misfit | null } = { misfit: null }
      const bindTools = (...args: unknown[]) => {
        const bound = model.bindTools!(...args)
        const invoke = async (...a: unknown[]) => {
          const raw = await bound.invoke(...a)
          if (!AIMessage.isInstance(raw)) return raw
          const out = firstAnswerOnly(raw)
          const call = (out.tool_calls ?? []).find(isAnswerCall)
          const checked = call && opts.answer ? opts.answer.safeParse(call.args) : null
          if (!call || !checked || checked.success) return out
          // Only the answer goes back to the model: tool calls beside it were never run.
          seen.misfit = { message: keepCalls(out, (c) => c === call), why: issuesOf(checked.error as Parameters<typeof issuesOf>[0]) }
          return new AIMessage({ content: '', usage_metadata: out.usage_metadata, response_metadata: out.response_metadata, id: out.id, name: out.name })
        }
        return Object.create(bound, { invoke: { value: invoke } })
      }
      const wrapped = Object.create(model, { bindTools: { value: bindTools } })
      let messages = request.messages
      for (let ask = 1; ; ask++) {
        seen.misfit = null
        const response = await handler({ ...request, messages, model: wrapped })
        const bad = seen.misfit as Misfit | null
        if (!bad) return response
        // The words of the answer just thrown away may already be on the person's screen: say so on the stream.
        ;(request.runtime as { writer?: (chunk: unknown) => void } | undefined)?.writer?.({ type: 'misfit' })
        if (ask >= MAX_ANSWER_ASKS) throw new AnswerShapeError(bad.why)
        if (await opts.stop?.()) throw new StoppedError()
        const call = bad.message.tool_calls?.[0]
        messages = [...messages, bad.message, new ToolMessage({ content: `Your answer did not fit the shape, so it was not used: ${bad.why}. Call ${call?.name} again with a corrected answer.`, tool_call_id: call?.id ?? '', status: 'error' })]
      }
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
  /** The row's Stop flag. */
  stop?: () => Promise<boolean>
  /** Chat only: each delegation to the Researcher becomes a worker row with its own Stop. */
  taskRows?: WorkerScope
  /** The shape of the loop's final answer, when it has one: a misfit is asked for again by Cello, not by langchain. */
  answer?: AnswerShape
  /** Test seam: fallback models to use instead of the free list. */
  fallbacks?: Parameters<typeof modelFallbackMiddleware>
}

/** Retry only what is worth retrying: not a cap, not a missing key, not the person's Stop. */
const retryable = (err: Error): boolean => !(err instanceof StoppedError) && !isBudgetCapError(err) && isTransient(rootCause(err))

export function guardStack(opts: GuardStackOptions): AgentMiddleware[] {
  const { ctx, agent, deadlineAt } = opts
  const caps = AGENT_CAPS[agent]
  const purpose = agent === 'researcher' ? 'researcher' : 'orchestrator'
  // A demo gets no free top-up past its cap.
  const fallbacks = ctx.isDemo
    ? []
    : (opts.fallbacks ?? freeFallbackModels().map((id) => celloChatModel({ apiKeys: ctx.apiKeys, model: id, purpose })))

  // The first middleware is the outermost. Stop sits inside both retry middlewares and the fallback list and
  // outside CelloSpend: every provider attempt and every tool attempt reads the row first, and none reserves after it.
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
    celloUntrusted(),
    toolRetryMiddleware({ maxRetries: 2, backoffFactor: 2, initialDelayMs: 300, retryOn: retryable }),
    ...(opts.stop ? [celloStop(opts.stop)] : []),
    ...(opts.taskRows ? [celloTaskRows(opts.taskRows)] : []),
    celloOneAnswer({ answer: opts.answer, stop: opts.stop }),
    celloSpend(ctx),
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
  'CelloUntrusted',
  'toolRetryMiddleware',
  'CelloStop',
  'CelloOneAnswer',
  'CelloSpend',
] as const
