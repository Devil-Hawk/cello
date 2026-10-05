// What the continue endpoint does. Three things ask for it, all signed (scheduler.ts):
//
//   slice  a request ran out of time and saved its place. Carry on in a fresh one.
//   stale  the sweeper found work marked as working whose request died (no heartbeat, no
//          lease). Carry on from the last saved step, a few times at most.
//   due    a Scheduled task is due, or the person pressed Run now. Start one occurrence.
//
// One occurrence of a Scheduled task is its own thread, so its context stays small and its
// task tree and trace are its own. When it ends, its result is added to the task's own
// conversation, so the person can open that conversation and ask about it.
//
// Nobody is watching any of this, so nothing here streams; the person sees it through the
// task rows (Realtime), the approvals it queues, and the conversation.

import { AIMessage } from '@langchain/core/messages'
import { loadApiKeys } from '@/lib/harness/keys'
import type { AdminClient } from '@/lib/harness/types'
import { newDeadline, type AgentContext } from './context'
import { AGENT_COPY } from './copy'
import { createCelloAgent } from './factory'
import { openAgentPersistence } from './persistence'
import { executeTurn, type RunnableAgent, type TurnRequest, type TurnResult } from './run'
import { getScheduledTask, nextRunAt, type ScheduledTaskRow } from './schedules'
import { claimLease, ensureThread, releaseLease, type ContinuePayload } from './scheduler'
import { finishTask } from './tasks'
import { traced } from './traced'

/** A task more than this late did not run; the card says it was missed instead of running at the wrong time. */
export const MISSED_AFTER_MS = 12 * 60 * 60 * 1000
/** A stale request is resumed this many times before the task is marked failed. */
export const MAX_RESUMES = 5

export interface ContinueDeps {
  loadKeys?: typeof loadApiKeys
  /** Seams for tests: the persistence, the agent, the MCP tools, and the follow-up request. */
  turn?: TurnRequest['deps']
  now?: () => Date
  /** Test seam: when the request must stop starting work. Default is a normal slice. */
  deadlineAt?: number
}

export type ContinueOutcome =
  | { kind: 'ignored'; why: 'unknown' | 'busy' | 'nothing_to_do' | 'not_due' | 'paused' | 'gave_up' }
  | { kind: 'missed' }
  | { kind: 'ran'; outcome: TurnResult['outcome'] }

export async function handleContinue(admin: AdminClient, payload: ContinuePayload, deps: ContinueDeps = {}): Promise<ContinueOutcome> {
  if (payload.reason === 'due') return payload.scheduled_task_id ? runDue(admin, payload.scheduled_task_id, payload.force === true, deps) : { kind: 'ignored', why: 'unknown' }
  return payload.thread_id ? continueThread(admin, payload.thread_id, payload.reason, deps) : { kind: 'ignored', why: 'unknown' }
}

// --- helpers ------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

async function emailOf(admin: AdminClient, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle()
  return (data as { email?: string | null } | null)?.email ?? ''
}

/** The agent's context for a request nobody is watching. */
async function contextFor(
  admin: AdminClient,
  deps: ContinueDeps,
  who: { userId: string; threadId: string; conversationId: string | null; task: ScheduledTaskRow | null },
  traceId: string
): Promise<AgentContext> {
  const apiKeys = await (deps.loadKeys ?? loadApiKeys)(admin, who.userId)
  return {
    admin,
    userId: who.userId,
    userEmail: await emailOf(admin, who.userId),
    apiKeys,
    isDemo: apiKeys.isDemo !== false,
    threadId: who.threadId,
    conversationId: who.conversationId,
    scheduledTaskId: who.task?.id ?? null,
    autonomy: who.task?.autonomy ?? 'ask',
    rules: who.task?.rules ?? {},
    traceId,
    deadlineAt: deps.deadlineAt ?? newDeadline(),
  }
}

// --- carrying on --------------------------------------------------------------------

async function continueThread(admin: AdminClient, threadId: string, reason: 'slice' | 'stale', deps: ContinueDeps): Promise<ContinueOutcome> {
  const { data: thread } = await admin.from('graph_threads').select('thread_id, user_id, conversation_id').eq('thread_id', threadId).maybeSingle()
  const row = thread as { thread_id: string; user_id: string; conversation_id: string | null } | null
  if (!row) return { kind: 'ignored', why: 'unknown' }

  const { data: roots } = await admin
    .from('agent_tasks')
    .select('id, scheduled_task_id, caps')
    .eq('thread_id', threadId)
    .eq('user_id', row.user_id)
    .is('parent_id', null)
    .eq('status', 'working')
    .order('created_at', { ascending: false })
    .limit(1)
  const root = ((roots as { id: string; scheduled_task_id: string | null; caps: Record<string, unknown> | null }[] | null) ?? [])[0]
  // It finished while this request was on its way.
  if (!root) return { kind: 'ignored', why: 'nothing_to_do' }

  const lease = await claimLease(admin, threadId)
  if (!lease) return { kind: 'ignored', why: 'busy' }

  let handedOver = false
  try {
    if (reason === 'stale') {
      const resumes = Number(root.caps?.resumes ?? 0)
      if (resumes >= MAX_RESUMES) {
        await finishTask(admin, root.id, { status: 'failed', summary: AGENT_COPY.generic })
        const task = root.scheduled_task_id ? await getScheduledTask(admin, row.user_id, root.scheduled_task_id) : null
        if (task) await endOccurrence(admin, task, { outcome: 'failed', finalText: '', error: { code: 'failed', message: AGENT_COPY.generic } }, deps, null)
        return { kind: 'ignored', why: 'gave_up' }
      }
      await admin.from('agent_tasks').update({ caps: { ...(root.caps ?? {}), resumes: resumes + 1 } }).eq('id', root.id)
    }
    const task = root.scheduled_task_id ? await getScheduledTask(admin, row.user_id, root.scheduled_task_id) : null
    const result = await traced(admin, row.user_id, { name: task ? 'agent-occurrence' : 'agent-turn', sessionId: row.conversation_id }, async (traceId) => {
      const ctx = await contextFor(admin, deps, { userId: row.user_id, threadId, conversationId: row.conversation_id, task }, traceId)
      handedOver = true
      const turn = await executeTurn({ ctx, lease, mode: { kind: 'continue' }, deps: deps.turn, traceName: 'agent-turn' })
      if (task && turn.outcome !== 'slice') await endOccurrence(admin, task, turn, deps, ctx)
      return turn
    })
    return { kind: 'ran', outcome: result.outcome }
  } finally {
    if (!handedOver) await releaseLease(admin, lease)
  }
}

// --- one occurrence -----------------------------------------------------------------

type Claimed = { task: ScheduledTaskRow } | { skip: ContinueOutcome }

/**
 * Take this occurrence for this request, in one conditional update: it only succeeds while
 * the task still has the next time and last time it had when it was read, so a duplicate
 * request (the sweeper poking twice, a double press of Run now) finds it already taken.
 */
async function claimOccurrence(admin: AdminClient, id: string, force: boolean, now: Date): Promise<Claimed> {
  const { data } = await admin.from('scheduled_tasks').select('*').eq('id', id).maybeSingle()
  const task = data as ScheduledTaskRow | null
  if (!task) return { skip: { kind: 'ignored', why: 'unknown' } }
  if (!force) {
    if (task.status !== 'active') return { skip: { kind: 'ignored', why: 'paused' } }
    if (!task.next_run_at || new Date(task.next_run_at).getTime() > now.getTime()) return { skip: { kind: 'ignored', why: 'not_due' } }
  }
  const late = task.next_run_at ? now.getTime() - new Date(task.next_run_at).getTime() : 0
  const missed = !force && late > MISSED_AFTER_MS
  const patch: Record<string, unknown> = { poked_at: null, ...(force ? {} : { next_run_at: nextRunAt(task.cron, task.timezone, now) }) }
  if (missed) {
    patch.last_run_at = task.next_run_at
    patch.last_status = 'missed'
    patch.last_result = null
  } else {
    patch.last_run_at = now.toISOString()
  }
  let q = admin.from('scheduled_tasks').update(patch).eq('id', id)
  q = task.next_run_at ? q.eq('next_run_at', task.next_run_at) : q.is('next_run_at', null)
  q = task.last_run_at ? q.eq('last_run_at', task.last_run_at) : q.is('last_run_at', null)
  const { data: won } = await q.select('id')
  if (!((won as unknown[] | null) ?? []).length) return { skip: { kind: 'ignored', why: 'busy' } }
  return missed ? { skip: { kind: 'missed' } } : { task: { ...task, ...(patch as Partial<ScheduledTaskRow>) } as ScheduledTaskRow }
}

/** The words an occurrence starts from. The person is away, so questions go to Needs you, not to them. */
export function occurrenceBrief(task: Pick<ScheduledTaskRow, 'name' | 'instruction'>): string {
  return `This is your scheduled task "${task.name}". The person is away, so do not ask questions. Do the work, and put anything that needs their say in Needs you.\n\n${task.instruction}`
}

async function runDue(admin: AdminClient, id: string, force: boolean, deps: ContinueDeps): Promise<ContinueOutcome> {
  const claimed = await claimOccurrence(admin, id, force, (deps.now ?? (() => new Date()))())
  if ('skip' in claimed) return claimed.skip
  const { task } = claimed

  const thread = await ensureThread(admin, task.user_id, { surface: 'scheduled', conversationId: task.conversation_id })
  const lease = await claimLease(admin, thread.thread_id)
  if (!lease) return { kind: 'ignored', why: 'busy' }

  let handedOver = false
  try {
    const result = await traced(admin, task.user_id, { name: 'agent-occurrence', sessionId: task.conversation_id }, async (traceId) => {
      const ctx = await contextFor(admin, deps, { userId: task.user_id, threadId: thread.thread_id, conversationId: task.conversation_id, task }, traceId)
      handedOver = true
      const turn = await executeTurn({ ctx, lease, mode: { kind: 'input', text: occurrenceBrief(task) }, title: task.name, traceName: 'agent-occurrence', deps: deps.turn })
      if (turn.outcome !== 'slice') await endOccurrence(admin, task, turn, deps, ctx)
      return turn
    })
    return { kind: 'ran', outcome: result.outcome }
  } catch (e) {
    // The request could not even start (no key, an expired demo): the card says so.
    await endOccurrence(admin, task, { outcome: 'failed', finalText: '', error: { code: 'failed', message: failureCopy(e) } }, deps, null)
    return { kind: 'ran', outcome: 'failed' }
  } finally {
    if (!handedOver) await releaseLease(admin, lease)
  }
}

function failureCopy(e: unknown): string {
  const name = (e as { name?: string } | null)?.name
  if (name === 'DemoAccessError') return AGENT_COPY.demoExpired
  if (name === 'MissingKeyError') return AGENT_COPY.needsKey
  return AGENT_COPY.generic
}

// --- ending one ---------------------------------------------------------------------

const STATUS = { done: 'ok', partial: 'partial', waiting: 'partial', failed: 'failed', slice: 'partial' } as const

/** Record how the occurrence ended on the task, and leave the result in the task's conversation. */
export async function endOccurrence(admin: AdminClient, task: ScheduledTaskRow, result: TurnResult, deps: ContinueDeps, ctx: AgentContext | null): Promise<void> {
  const text = result.error?.message ?? (result.outcome === 'waiting' ? 'Waiting for you in Needs you.' : result.finalText) ?? ''
  await admin
    .from('scheduled_tasks')
    .update({ last_status: STATUS[result.outcome], last_result: text ? clip(text, 500) : null, poked_at: null, updated_at: new Date().toISOString() })
    .eq('id', task.id)
    .eq('user_id', task.user_id)
  if (ctx && text) {
    try {
      await leaveResult(admin, task, text, ctx, deps)
    } catch (e) {
      // The card still shows the result; only the conversation misses it.
      console.error('[agents] could not add an occurrence result to its conversation', e instanceof Error ? e.message : e)
    }
  }
}

/** Add the result to the task's conversation as a message from Cello, without a model call. */
async function leaveResult(admin: AdminClient, task: ScheduledTaskRow, text: string, ctx: AgentContext, deps: ContinueDeps): Promise<void> {
  if (!task.conversation_id) return
  const { data } = await admin.from('copilot_conversations').select('thread_id').eq('id', task.conversation_id).eq('user_id', task.user_id).maybeSingle()
  let threadId = (data as { thread_id: string | null } | null)?.thread_id ?? null
  if (!threadId) {
    threadId = (await ensureThread(admin, task.user_id, { surface: 'agent', conversationId: task.conversation_id })).thread_id
    await admin.from('copilot_conversations').update({ thread_id: threadId }).eq('id', task.conversation_id).eq('user_id', task.user_id)
  }
  // The person may be talking in this conversation right now; their message wins and the card still has the result.
  const lease = await claimLease(admin, threadId)
  if (!lease) return
  const persistence = deps.turn?.persistence ?? openAgentPersistence(ctx.apiKeys)
  try {
    const agent = (deps.turn?.buildAgent ?? ((i) => createCelloAgent(i) as unknown as RunnableAgent))({
      kind: 'orchestrator',
      ctx: { ...ctx, threadId, conversationId: task.conversation_id },
      saver: persistence.saver,
      store: persistence.store,
    })
    const when = (deps.now ?? (() => new Date()))().toISOString()
    await agent.updateState({ configurable: { thread_id: threadId } }, { messages: [new AIMessage({ content: text, additional_kwargs: { cello_occurrence: true, scheduled_task_id: task.id, occurred_at: when } })] }, '__start__')
  } finally {
    await releaseLease(admin, lease)
    if (!deps.turn?.persistence) await persistence.close()
  }
}
