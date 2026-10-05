// The live task tree: one agent_tasks row per task, with child rows for each
// specialist and each branch of a fan-out. Supabase Realtime pushes the rows to
// the browser, so the tree survives a reconnect and a continuation in a new request.
//
// This is a view of the work, never part of it: a write that fails is logged and
// the work goes on. The one exception is what the sweeper reads (status and
// heartbeat of a root task), which is why the heartbeat also renews the lease.

import type { AdminClient } from '@/lib/harness/types'
import type { BranchEvent, BranchResult, PartialReason } from './fanout'

export type TaskAgent = 'cello' | 'scout' | 'researcher' | 'writer' | 'reviewer' | 'applier'
export type TaskStatus = 'queued' | 'working' | 'waiting' | 'done' | 'partial' | 'failed'

export interface TaskScope {
  admin: AdminClient
  userId: string
  threadId: string
  conversationId: string | null
  scheduledTaskId?: string | null
  traceId?: string | null
}

export interface StartTaskInput {
  agent: TaskAgent
  title: string
  parentId?: string | null
  branchIndex?: number | null
  caps?: Record<string, unknown> | null
  status?: TaskStatus
}

const now = () => new Date().toISOString()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function log(what: string, error: unknown) {
  console.error(`[agent_tasks] ${what}`, error instanceof Error ? error.message : error)
}

/** Add a task row in the working state. Returns its id, or null when the row could not be written. */
export async function startTask(scope: TaskScope, input: StartTaskInput): Promise<string | null> {
  try {
    const { data, error } = await scope.admin
      .from('agent_tasks')
      .insert({
        user_id: scope.userId,
        thread_id: scope.threadId,
        conversation_id: scope.conversationId,
        scheduled_task_id: scope.scheduledTaskId ?? null,
        parent_id: input.parentId ?? null,
        agent: input.agent,
        title: clip(input.title, 160),
        status: input.status ?? 'working',
        branch_index: input.branchIndex ?? null,
        caps: input.caps ?? null,
        trace_id: scope.traceId ?? null,
        heartbeat_at: now(),
        started_at: now(),
      })
      .select('id')
      .single()
    if (error || !data) {
      log('could not start a task row', error)
      return null
    }
    return (data as { id: string }).id
  } catch (e) {
    log('could not start a task row', e)
    return null
  }
}

export interface FinishTaskInput {
  status: Exclude<TaskStatus, 'queued' | 'working'>
  partialReason?: PartialReason | null
  summary?: string | null
  artifactIds?: string[]
  costUsd?: number
  title?: string
}

export async function finishTask(admin: AdminClient, id: string | null, input: FinishTaskInput): Promise<void> {
  if (!id) return
  try {
    const { error } = await admin
      .from('agent_tasks')
      .update({
        status: input.status,
        partial_reason: input.partialReason ?? null,
        ...(input.summary !== undefined ? { summary: input.summary ? clip(input.summary, 2000) : null } : {}),
        ...(input.artifactIds ? { artifact_ids: input.artifactIds } : {}),
        ...(input.costUsd !== undefined ? { cost_usd: Math.round(input.costUsd * 10_000) / 10_000 } : {}),
        ...(input.title ? { title: clip(input.title, 160) } : {}),
        // A task waiting for the person has not finished.
        finished_at: input.status === 'waiting' ? null : now(),
        heartbeat_at: now(),
      })
      .eq('id', id)
    if (error) log('could not finish a task row', error)
  } catch (e) {
    log('could not finish a task row', e)
  }
}

/** Rename a task, for the parent line of a fan-out ("Researching 6 companies (4 done, 1 failed)"). */
export async function retitleTask(admin: AdminClient, id: string | null, title: string): Promise<void> {
  if (!id) return
  try {
    await admin.from('agent_tasks').update({ title: clip(title, 160), heartbeat_at: now() }).eq('id', id)
  } catch (e) {
    log('could not retitle a task row', e)
  }
}

/** Beat the heart of a task. Returns false when the row is gone or the write failed. */
export async function heartbeat(admin: AdminClient, id: string | null): Promise<boolean> {
  if (!id) return false
  try {
    const { error } = await admin.from('agent_tasks').update({ heartbeat_at: now() }).eq('id', id)
    return !error
  } catch {
    return false
  }
}

export const HEARTBEAT_MS = 30_000

/**
 * Beat every HEARTBEAT_MS until stopped. `alsoDo` runs on each beat (the runner
 * renews the thread lease there). The timer never keeps the process alive.
 */
export function startHeartbeat(admin: AdminClient, id: string | null, alsoDo?: () => Promise<unknown>, everyMs = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    void heartbeat(admin, id)
    if (alsoDo) void alsoDo().catch((e) => log('heartbeat side effect failed', e))
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** The status a finished fan-out branch shows in the tree. */
export function statusOfBranch(result: BranchResult<unknown>): FinishTaskInput {
  if (result.status === 'ok') return { status: 'done' }
  if (result.status === 'partial') return { status: 'partial', partialReason: result.reason ?? null }
  return { status: 'failed', summary: result.error ?? 'Something went wrong' }
}

/**
 * An onBranch handler for fanOut: a child row per branch, working while it runs
 * and finished with ok, partial (with the reason) or failed when it ends.
 */
export function branchRecorder<I, R>(
  scope: TaskScope,
  parentId: string | null,
  agent: TaskAgent,
  titleOf: (item: I, index: number) => string,
  summaryOf?: (result: BranchResult<R>) => string | undefined
) {
  const ids = new Map<number, string | null>()
  return async (event: BranchEvent<I, R>): Promise<void> => {
    if (event.phase === 'start') {
      ids.set(event.index, await startTask(scope, { agent, title: titleOf(event.item, event.index), parentId, branchIndex: event.index }))
      return
    }
    const finish = statusOfBranch(event.result)
    await finishTask(scope.admin, ids.get(event.index) ?? null, {
      ...finish,
      ...(summaryOf ? { summary: summaryOf(event.result) ?? finish.summary } : {}),
    })
  }
}

/** The line the tree shows for a status, in the product's words. */
export function statusLabel(status: TaskStatus, reason?: PartialReason | null, failure?: string | null): string {
  switch (status) {
    case 'queued':
    case 'working':
      return 'Working'
    case 'done':
      return 'Done'
    case 'waiting':
      return 'Waiting for your approval'
    case 'partial':
      return reason === 'budget' ? 'Partial: ran out of budget' : reason === 'time' ? 'Partial: ran out of time' : 'Partial: hit the step limit'
    case 'failed':
      return `Failed: ${failure ?? 'something went wrong'}`
  }
}
