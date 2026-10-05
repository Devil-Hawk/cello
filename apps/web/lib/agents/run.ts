// Running an agent turn: the one place agents are invoked.
//
// executeTurn takes a request that already has everything it needs (who, which thread, the
// lease on it, the deadline) and runs the orchestrator until it finishes, hands over, or
// needs the person. It is used three ways: the streaming route (a person is watching, events
// are sent as they happen), the continue endpoint (a slice ran out of time, or the sweeper
// found stale work: nobody is watching), and a scheduled occurrence (nobody is watching).
//
// What it guarantees, whatever happens:
//   - the thread lease is renewed while it runs and always released
//   - the task row for this request ends done, partial, waiting or failed
//   - the checkpoint is saved after each step (durability "sync": every agent thread can
//     reach a tool that writes), so a request killed mid-way resumes where it stopped
//   - past the deadline it stops starting work, saves, and fires the continue request
//   - one Langfuse trace for the whole request, with the person's reactions scored on it

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import { Command } from '@langchain/langgraph'
import { MissingKeyError } from '@/lib/harness/providers'
import { agentCallbacks, flushAgentSpans, withAgentSpanContext } from '@/lib/observability/langfuse'
import { captureError } from '@/lib/observability/sentry'
import { takeUnpostedResults } from './approvals'
import type { AgentContext } from './context'
import { AGENT_COPY, budgetCopy } from './copy'
import { createCelloAgent, type CelloAgentInput } from './factory'
import { openAgentPersistence, type AgentPersistenceHandle } from './persistence'
import { profileCard } from './profile-card'
import { releaseLease, renewLease, fireContinue, type Lease } from './scheduler'
import { chunkToEvent, type WireEvent } from './sse'
import { isBudgetCapError } from './spend-port'
import { finishTask, startHeartbeat, startTask, type TaskScope } from './tasks'
import { parseResearcherResult, researcherBrief, type ResearcherResult } from './subagents/researcher'
import { loadUserMcpTools, type UserMcpTools } from './user-mcp'

export type TurnMode = { kind: 'input'; text: string } | { kind: 'resume'; value: unknown } | { kind: 'continue' }

export interface TurnRequest {
  ctx: AgentContext
  lease: Lease
  mode: TurnMode
  /** Called for each stream event. Left out when nobody is watching. */
  emit?: (event: WireEvent) => void
  sessionId?: string | null
  traceName?: string
  /** Test seams. */
  deps?: {
    persistence?: AgentPersistenceHandle
    buildAgent?: (input: CelloAgentInput & { kind: 'orchestrator' }) => RunnableAgent
    mcp?: UserMcpTools
    fire?: typeof fireContinue
    card?: string
  }
}

export interface TurnResult {
  outcome: 'done' | 'partial' | 'slice' | 'waiting' | 'failed'
  /** The last assistant message, for a scheduled task's result. */
  finalText: string
  error?: { code: 'needs_key' | 'budget' | 'failed'; message: string }
}

/** The part of an agent this file uses. */
export interface RunnableAgent {
  stream: (input: unknown, config: Record<string, unknown>) => Promise<AsyncIterable<readonly [readonly string[], string, unknown]>>
  getState: (config: Record<string, unknown>) => Promise<{
    values?: { messages?: BaseMessage[] }
    next: readonly string[]
    tasks: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }>
  }>
}

/** langchain's own text when the model call limit ends a loop early. */
const CAP_TEXT = /model call limit/i

/** Slices and heartbeats: how often the lease is renewed, and the deepest a loop may recurse. */
const RECURSION_LIMIT = 400

function textOf(message: BaseMessage | undefined): string {
  if (!message) return ''
  return typeof message.content === 'string' ? message.content : message.content.map((b) => (b as { text?: string }).text ?? '').join('')
}

const lastAiText = (messages: BaseMessage[] | undefined): string => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i]
    if (AIMessage.isInstance(m) && textOf(m).trim()) return textOf(m).trim()
  }
  return ''
}

/** An approval's result as a message the model reads. It is marked, so it can never count as the person's words. */
export function eventMessage(text: string): HumanMessage {
  return new HumanMessage({ content: `<event>${text}</event>`, additional_kwargs: { cello_event: true } })
}

export async function executeTurn(req: TurnRequest): Promise<TurnResult> {
  const { ctx, lease } = req
  const emit = req.emit ?? (() => undefined)
  const scope: TaskScope = { admin: ctx.admin, userId: ctx.userId, threadId: ctx.threadId, conversationId: ctx.conversationId, scheduledTaskId: ctx.scheduledTaskId, traceId: ctx.traceId }
  const fire = req.deps?.fire ?? fireContinue
  let persistence: AgentPersistenceHandle | undefined
  let mcp: UserMcpTools | undefined
  let stopHeartbeat: (() => void) | undefined
  let rootTaskId: string | null = null
  let result: TurnResult = { outcome: 'failed', finalText: '' }

  emit({ event: 'metadata', data: { run_id: ctx.traceId, thread_id: ctx.threadId } })

  try {
    // The root task row: reuse the one this thread already has when resuming, so the tree stays one tree.
    const existing = req.mode.kind === 'input' ? null : await openRootTask(ctx)
    rootTaskId = existing ?? (await startTask(scope, { agent: 'cello', title: req.mode.kind === 'input' ? taskTitle(req.mode.text) : 'Working on your request' }))
    ctx.rootTaskId = rootTaskId
    if (existing) await finishWorking(ctx, existing)
    stopHeartbeat = startHeartbeat(ctx.admin, rootTaskId, () => renewLease(ctx.admin, lease))

    persistence = req.deps?.persistence ?? openAgentPersistence()
    mcp = req.deps?.mcp ?? (await loadUserMcpTools(ctx))
    const agent = (req.deps?.buildAgent ?? ((i) => createCelloAgent(i) as unknown as RunnableAgent))({
      kind: 'orchestrator',
      ctx,
      saver: persistence.saver,
      extraTools: mcp.tools,
      profileCard: req.deps?.card ?? (await profileCard(ctx.admin, ctx.userId).catch(() => '')),
    })

    const config: Record<string, unknown> = {
      configurable: { thread_id: ctx.threadId },
      streamMode: ['values', 'updates', 'messages', 'custom'],
      subgraphs: true,
      durability: 'sync',
      recursionLimit: RECURSION_LIMIT,
      signal: ctx.signal,
      callbacks: await agentCallbacks({ traceId: ctx.traceId, sessionId: req.sessionId ?? ctx.conversationId, userId: ctx.userId, isDemo: ctx.isDemo, name: req.traceName ?? 'agent-turn' }),
    }

    const input = await streamInput(req, agent, config)
    if (input === 'nothing') {
      result = { outcome: 'done', finalText: lastAiText((await agent.getState(config)).values?.messages) }
    } else {
      let interrupt: unknown
      await withAgentSpanContext(ctx.traceId, async () => {
        const stream = await agent.stream(input.value, config)
        for await (const chunk of stream) {
          emit(chunkToEvent(chunk))
          const [ns, mode, data] = chunk
          if (mode === 'values' && ns.length === 0 && data && typeof data === 'object' && '__interrupt__' in data) interrupt = (data as { __interrupt__?: { value?: unknown }[] }).__interrupt__?.[0]?.value
        }
      })
      const snapshot = await agent.getState(config)
      const pending = interrupt ?? snapshot.tasks.flatMap((t) => t.interrupts ?? [])[0]?.value
      const finalText = lastAiText(snapshot.values?.messages)
      if ((pending as { kind?: string } | undefined)?.kind === 'slice') {
        // Out of time for this request: the checkpoint is saved, so carry on in a fresh one.
        result = { outcome: 'slice', finalText }
        await fire({ reason: 'slice', thread_id: ctx.threadId })
      } else if (pending !== undefined) {
        result = { outcome: 'waiting', finalText }
      } else {
        result = { outcome: CAP_TEXT.test(finalText) ? 'partial' : 'done', finalText }
      }
    }
  } catch (e) {
    result = { outcome: 'failed', finalText: '', error: errorFor(e) }
    if (result.error?.code === 'failed') void captureError(e, { tags: { area: 'agent', phase: 'turn' }, extra: { threadId: ctx.threadId } })
    emit({ event: 'error', data: { error: result.error?.code ?? 'failed', message: result.error?.message ?? AGENT_COPY.generic } })
  } finally {
    stopHeartbeat?.()
    await finishRoot(ctx, rootTaskId, result)
    await Promise.allSettled([releaseLease(ctx.admin, lease), persistence?.close(), mcp?.close(), flushAgentSpans()])
  }
  return result
}

// --- helpers ------------------------------------------------------------------------

const taskTitle = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || 'Working on your request'
}

async function openRootTask(ctx: AgentContext): Promise<string | null> {
  const { data } = await ctx.admin
    .from('agent_tasks')
    .select('id')
    .eq('thread_id', ctx.threadId)
    .eq('user_id', ctx.userId)
    .is('parent_id', null)
    .in('status', ['working', 'waiting'])
    .order('created_at', { ascending: false })
    .limit(1)
  return ((data as { id: string }[] | null) ?? [])[0]?.id ?? null
}

async function finishWorking(ctx: AgentContext, id: string): Promise<void> {
  // The task goes back to working when a slice or a stale request resumes it.
  await ctx.admin.from('agent_tasks').update({ status: 'working', heartbeat_at: new Date().toISOString(), finished_at: null }).eq('id', id).eq('user_id', ctx.userId)
}

async function finishRoot(ctx: AgentContext, id: string | null, result: TurnResult): Promise<void> {
  if (!id) return
  // A handed-over task stays working: the continuation finishes it.
  if (result.outcome === 'slice') return
  await finishTask(ctx.admin, id, {
    status: result.outcome === 'done' ? 'done' : result.outcome === 'partial' ? 'partial' : result.outcome === 'waiting' ? 'waiting' : 'failed',
    partialReason: result.outcome === 'partial' ? 'steps' : null,
    summary: result.error?.message ?? (result.finalText ? result.finalText.slice(0, 500) : null),
  })
}

/** Pick what to hand the agent: new words (with any approval results first), an answer, or "carry on". */
async function streamInput(req: TurnRequest, agent: RunnableAgent, config: Record<string, unknown>): Promise<{ value: unknown } | 'nothing'> {
  const { ctx, mode } = req
  if (mode.kind === 'input') {
    const events = await takeUnpostedResults(ctx.admin, ctx.userId, ctx.threadId)
    return { value: { messages: [...events.map((e) => eventMessage(e.text)), new HumanMessage(mode.text)] } }
  }
  if (mode.kind === 'resume') return { value: new Command({ resume: mode.value }) }
  // Carry on: a parked slice resumes with its marker; a request killed mid-way resumes from its checkpoint.
  const state = await agent.getState(config)
  if (state.tasks.some((t) => (t.interrupts ?? []).length > 0)) return { value: new Command({ resume: 'continue' }) }
  if (state.next.length > 0) return { value: null }
  return 'nothing'
}

function errorFor(e: unknown): NonNullable<TurnResult['error']> {
  if (isBudgetCapError(e)) return { code: 'budget', message: budgetCopy() }
  const name = (e as { name?: string } | null)?.name
  if (e instanceof MissingKeyError || name === 'MissingKeyError') return { code: 'needs_key', message: AGENT_COPY.needsKey }
  return { code: 'failed', message: AGENT_COPY.generic }
}

// --- the Researcher, on its own ------------------------------------------------------

export interface ResearcherRun {
  signal?: AbortSignal
  /** The most model calls it gets. The guard stack enforces the same cap. */
  maxSteps?: number
  /** The calling tool's config, so the run joins the same trace. */
  config?: RunnableConfig
  /** Test seam. */
  build?: (input: CelloAgentInput & { kind: 'researcher' }) => { invoke: (input: unknown, config?: Record<string, unknown>) => Promise<{ messages: BaseMessage[] }> }
}

/**
 * One deep look at one subject by the Researcher, a loop of at most eight model calls with
 * read-only tools. Called from the research tool for each subject of a fan-out. The result is
 * read from its last message; an answer without a source, or a loop that ran out of steps,
 * is reported as not enough information, never as a guess.
 */
export async function runResearcher(ctx: AgentContext, brief: { subject: string; kind: 'company' | 'person' | 'topic' }, opts: ResearcherRun = {}): Promise<ResearcherResult> {
  const agent = (opts.build ?? ((i) => createCelloAgent(i) as never))({ kind: 'researcher', ctx: { ...ctx, readOnly: true, signal: opts.signal ?? ctx.signal } })
  const out = await agent.invoke(
    { messages: [new HumanMessage(researcherBrief(brief.subject, brief.kind))] },
    { ...(opts.config ?? {}), signal: opts.signal ?? ctx.signal, recursionLimit: 40 }
  )
  const last = textOf(out.messages.at(-1))
  const hitLimit = CAP_TEXT.test(last) && !last.trim().startsWith('{')
  return parseResearcherResult(last, hitLimit)
}
