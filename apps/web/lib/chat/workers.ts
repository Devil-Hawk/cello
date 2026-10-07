// Workers: one agent_tasks row for each branch a Chat command fans out into (research per company, a draft per
// object, a start per role). Code writes every field; the page reads them live (blueprint 5.3).
//
//   runWorkers   fans a command out over its items, four at a time, one row per branch
//   addRead      adds what a worker read, from its tool results, up to 50
//   requestStop  chat.stop: every unfinished row of the turn;  requestStopWorker  chat.stop_worker: one row
//
// Stop is a column, not a prompt. Each branch checks its own row before every model call and tool call, and
// polls it while a fetch is in flight so the fetch is aborted, so a page that tells a worker to ignore Stop
// has nothing to talk to. A stopped branch writes nothing more.

import { fanOut, type BranchCaps, type FanOutResult } from '@/lib/agents/fanout'
import type { AdminClient } from '@/lib/harness/types'

export const MAX_READS = 50
export const STOP_POLL_MS = 2000

export class StoppedError extends Error {
  constructor() {
    super('Stopped by you.')
    this.name = 'StoppedError'
  }
}

export interface WorkerScope {
  db: AdminClient
  userId: string
  threadId: string
  chatId: string
  /** The person's turn that started the work. */
  turnId: string
  model?: string
  rung?: string
}

export interface WorkerRead {
  label: string
  url?: string
  /** Or a row the worker read: {table, id}. */
  row?: { table: string; id: string }
}

type Finish = { status: 'done' | 'partial' | 'failed' | 'stopped'; summary?: string }

const now = () => new Date().toISOString()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A worker row in the working state. Null when it could not be written: the row is a view, the work goes on. */
export async function openWorker(
  scope: WorkerScope,
  input: { command: string; title: string; object?: { kind: string; ref: string }; parentId?: string | null; branchIndex?: number | null }
): Promise<string | null> {
  const { data, error } = await scope.db
    .from('agent_tasks')
    .insert({
      user_id: scope.userId,
      thread_id: scope.threadId,
      chat_id: scope.chatId,
      turn_id: scope.turnId,
      command: input.command,
      title: clip(input.title, 160),
      object: input.object ?? null,
      parent_id: input.parentId ?? null,
      branch_index: input.branchIndex ?? null,
      model: scope.model ?? null,
      rung: scope.rung ?? null,
      status: 'working',
      heartbeat_at: now(),
      started_at: now(),
    })
    .select('id')
    .single()
  return error || !data ? null : (data as { id: string }).id
}

/** Adds a read to a worker's list, as code read it from a tool result. The 51st is dropped, never the first. */
export async function addRead(db: AdminClient, workerId: string | null, read: WorkerRead): Promise<void> {
  if (!workerId) return
  const { data } = await db.from('agent_tasks').select('reads').eq('id', workerId).maybeSingle()
  const reads = ((data as { reads: unknown[] } | null)?.reads ?? []) as unknown[]
  if (reads.length >= MAX_READS) return
  await db.from('agent_tasks').update({ reads: [...reads, { ...read, at: now() }], heartbeat_at: now() }).eq('id', workerId)
}

export async function finishWorker(db: AdminClient, workerId: string | null, finish: Finish): Promise<void> {
  if (!workerId) return
  await db
    .from('agent_tasks')
    .update({ status: finish.status, ...(finish.summary ? { summary: clip(finish.summary, 2000) } : {}), finished_at: now(), heartbeat_at: now() })
    .eq('id', workerId)
}

/** chat.stop: every unfinished row of the turn. Returns how many rows were marked. */
export async function requestStop(db: AdminClient, userId: string, turnId: string): Promise<number> {
  const { data } = await db
    .from('agent_tasks')
    .update({ stop_requested_at: now() })
    .eq('user_id', userId)
    .eq('turn_id', turnId)
    .is('finished_at', null)
    .is('stop_requested_at', null)
    .select('id')
  return ((data as unknown[] | null) ?? []).length
}

/** chat.stop_worker: one row, the person's own. A task id that is not theirs marks nothing. */
export async function requestStopWorker(db: AdminClient, userId: string, taskId: string): Promise<boolean> {
  const { data } = await db
    .from('agent_tasks')
    .update({ stop_requested_at: now() })
    .eq('id', taskId)
    .eq('user_id', userId)
    .is('finished_at', null)
    .is('stop_requested_at', null)
    .select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}

export async function isStopped(db: AdminClient, workerId: string | null): Promise<boolean> {
  if (!workerId) return false
  const { data } = await db.from('agent_tasks').select('stop_requested_at').eq('id', workerId).maybeSingle()
  return Boolean((data as { stop_requested_at: string | null } | null)?.stop_requested_at)
}

/** Aborts `signal`'s child when the row is marked, checking every `everyMs`, so a fetch in flight ends. */
function watchStop(db: AdminClient, workerId: string | null, parent: AbortSignal, everyMs: number): { signal: AbortSignal; done: () => void } {
  const stop = new AbortController()
  const timer = setInterval(() => {
    void isStopped(db, workerId).then((yes) => yes && stop.abort(new StoppedError()))
  }, everyMs)
  timer.unref?.()
  return { signal: AbortSignal.any([parent, stop.signal]), done: () => clearInterval(timer) }
}

export interface WorkerBranch {
  taskId: string | null
  /** Aborts at the branch's time cap, when the request is cancelled, or when the person stops this worker. */
  signal: AbortSignal
  /** Call before every model call and tool call: throws StoppedError once the person has stopped this worker. */
  checkStop: () => Promise<void>
  read: (r: WorkerRead) => Promise<void>
}

export interface RunWorkersInput<I, R> {
  command: string
  items: readonly I[]
  titleOf: (item: I) => string
  objectOf?: (item: I) => { kind: string; ref: string }
  worker: (item: I, branch: WorkerBranch) => Promise<R>
  caps: BranchCaps
  deadlineAt: number
  signal?: AbortSignal
  pollMs?: number
}

/** Fans the command out over its items, at most four at once, one row each. One branch's stop or failure never ends the rest. */
export async function runWorkers<I, R>(scope: WorkerScope, input: RunWorkersInput<I, R>): Promise<FanOutResult<R>> {
  const ids = new Map<number, string | null>()
  return fanOut<I, R>({
    items: input.items,
    caps: input.caps,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
    async onBranch(event) {
      if (event.phase === 'start') {
        ids.set(event.index, await openWorker(scope, { command: input.command, title: input.titleOf(event.item), object: input.objectOf?.(event.item), branchIndex: event.index }))
        return
      }
      const id = ids.get(event.index) ?? null
      const r = event.result
      const stopped = r.status !== 'ok' && (await isStopped(scope.db, id))
      await finishWorker(scope.db, id, stopped ? { status: 'stopped' } : r.status === 'ok' ? { status: 'done' } : r.status === 'partial' ? { status: 'partial' } : { status: 'failed', summary: r.error })
    },
    async worker(item, branch) {
      const taskId = ids.get(branch.index) ?? null
      const watch = watchStop(scope.db, taskId, branch.signal, input.pollMs ?? STOP_POLL_MS)
      try {
        return await input.worker(item, {
          taskId,
          signal: watch.signal,
          checkStop: async () => {
            if (await isStopped(scope.db, taskId)) throw new StoppedError()
          },
          read: (r) => addRead(scope.db, taskId, r),
        })
      } finally {
        watch.done()
      }
    },
  })
}

/** One worker row around one piece of work: working while `work` runs, done when it returns, failed when it throws. */
export async function withWorker<T>(scope: WorkerScope, input: Parameters<typeof openWorker>[1], work: (workerId: string | null) => Promise<T>): Promise<T> {
  const id = await openWorker(scope, input)
  try {
    const out = await work(id)
    await finishWorker(scope.db, id, { status: 'done' })
    return out
  } catch (e) {
    await finishWorker(scope.db, id, { status: (await isStopped(scope.db, id)) ? 'stopped' : 'failed', summary: e instanceof Error ? e.message : 'Failed' })
    throw e
  }
}
