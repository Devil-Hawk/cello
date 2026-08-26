// A custom TaskStore backing app/api/a2a/route.ts's DefaultRequestHandler,
// deliberately NOT @a2a-js/sdk's built-in InMemoryTaskStore.
//
// WHY NOT InMemoryTaskStore
//   Same reason app/api/mcp/route.ts builds a fresh, stateless
//   McpServer/transport per request instead of pinning a session: a Vercel
//   serverless function has no shared memory across invocations, and an A2A
//   client's tasks/get poll can land on a completely different instance
//   than the one that handled message/send. In-memory storage would make
//   every poll after the first see "task not found." This store persists to
//   a2a_tasks (supabase/migrations/20260819000002_a2a_tasks.sql) instead.
//
// WHERE "tasks/get polls: non-terminal -> invokeGraphForUser({kind:
// 'continue'}) then report state" (spec Step 3, item 3) LIVES
//   Right here, in load(). Both A2ARequestHandler.getTask() AND
//   .cancelTask() call taskStore.load() first (see
//   node_modules/@a2a-js/sdk's DefaultRequestHandler — cancelTask loads
//   BEFORE it marks a task canceled), so a cancel that lands mid-run can
//   observe one extra continue step before the cancel itself finalizes
//   status='cancelled' via save(). ponytail: harmless (the run was already
//   going to advance to its next checkpoint either way; canceling stops
//   FUTURE polls from resuming it, which is the guarantee that matters) and
//   not fixable without a different SDK hook — TaskStore has no
//   "read without side effects" method distinct from the one both callers
//   share.
//
// OWNERSHIP (anti-IDOR, ruling 5's stated concern for this table)
//   load() refuses a task that does not belong to `context`'s userId the
//   SAME way lib/graph/invoke.ts#loadOwnedThread refuses a thread that
//   isn't the caller's: by returning `undefined` — indistinguishable, from
//   the wire, from "no such task" (DefaultRequestHandler turns either into
//   TaskNotFoundError). Telling an attacker "that task belongs to someone
//   else" vs. "no such task" for a bare task_id capability is a distinction
//   with no honest use.

import type { TaskStore } from '@a2a-js/sdk/server'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import type { Task, Message } from '@a2a-js/sdk'
import { TaskState } from '@a2a-js/sdk'
import type { AdminClient } from '../harness/types'
import type { AgentRunRow } from '../harness/types'
import { invokeGraphForUser, type CompiledGraphLike } from '../graph/invoke'
import { harnessRunGraph } from '../graph/runs'
import { runStatusToTaskState, isNonTerminalRunStatus, type A2aAgent } from './agent'
import { STATE_USER_ID_KEY } from './context'

/** Reverse of runStatusToTaskState, narrowed to the five values
 *  a2a_tasks.status's CHECK constraint accepts — see that migration's
 *  header for why the other four protocol states never apply here. */
function taskStateToA2aTasksStatus(state: TaskState): 'submitted' | 'working' | 'completed' | 'failed' | 'cancelled' {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return 'submitted'
    case TaskState.TASK_STATE_WORKING:
      return 'working'
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed'
    case TaskState.TASK_STATE_CANCELED:
      return 'cancelled'
    default:
      return 'failed'
  }
}

interface A2aTaskRow {
  task_id: string
  user_id: string
  thread_id: string
  agent: A2aAgent
  status: string
}

/** Builds the artifact carrying the harness step's real output (the score
 *  verdict / dossier / prep kit) once agent_runs.result is populated —
 *  `undefined` while the run is still in flight, so a non-terminal Task
 *  simply has no artifacts yet rather than a placeholder one. */
function outcomeArtifact(taskId: string, run: AgentRunRow): Task['artifacts'] {
  const outcome = run.result as { outputs?: Record<string, unknown> } | null
  const output = outcome?.outputs?.run
  if (output === undefined) return []
  return [
    {
      artifactId: `${taskId}:run`,
      name: 'run',
      description: '',
      parts: [{ content: { $case: 'data', value: output }, metadata: undefined, filename: '', mediaType: 'application/json' }],
      metadata: undefined,
      extensions: [],
    },
  ]
}

function statusMessage(taskId: string, contextId: string, run: AgentRunRow): Message | undefined {
  if (!run.error) return undefined
  return {
    messageId: `${taskId}:error`,
    contextId,
    taskId,
    role: 2 /* Role.ROLE_AGENT */,
    parts: [{ content: { $case: 'text', value: run.error }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

export function createA2aTaskStore(admin: AdminClient): TaskStore {
  return {
    async save(task: Task, context: ServerCallContext): Promise<void> {
      const userId = context.state.get(STATE_USER_ID_KEY) as string | undefined
      const meta = task.metadata as { agent?: A2aAgent; threadId?: string } | undefined
      // save() is only ever called by the SDK for a task THIS route already
      // published (message/send's own AgentEvent.task, or cancelTask's
      // synthesized CANCELED task, both of which carry metadata.agent/
      // .threadId) — a call missing either is a defensive no-op, not a
      // silent partial write.
      if (!userId || !meta?.agent || !meta.threadId || !task.status) return
      const { error } = await admin.from('a2a_tasks').upsert(
        {
          task_id: task.id,
          user_id: userId,
          thread_id: meta.threadId,
          agent: meta.agent,
          status: taskStateToA2aTasksStatus(task.status.state),
        },
        { onConflict: 'task_id' }
      )
      if (error) console.error(`[a2a] task-store save failed for ${task.id}: ${error.message}`)
    },

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const userId = context.state.get(STATE_USER_ID_KEY) as string | undefined
      if (!userId) return undefined

      const { data, error } = await admin.from('a2a_tasks').select('task_id, user_id, thread_id, agent, status').eq('task_id', taskId).maybeSingle()
      if (error) {
        console.error(`[a2a] task-store load failed for ${taskId}: ${error.message}`)
        return undefined
      }
      const row = data as A2aTaskRow | null
      if (!row || row.user_id !== userId) return undefined // see file header: not-found and not-yours look identical

      const { data: runData } = await admin.from('agent_runs').select('*').eq('thread_id', row.thread_id).maybeSingle()
      let run = runData as AgentRunRow | null
      if (!run) {
        console.error(`[a2a] task-store: a2a_tasks row ${taskId} has no matching agent_runs row for thread ${row.thread_id}`)
        return undefined
      }

      // THE ACTUAL WIRING FOR "tasks/get polls: non-terminal ->
      // invokeGraphForUser({kind:'continue'}) then report state" — see file
      // header. `row.status` (not a fresh runStatusToTaskState(run.status)
      // read) gates this: once THIS table says 'cancelled', nothing resumes
      // it again no matter what agent_runs still says.
      //
      // `run.started_at !== null` is the second, load-bearing half of this
      // guard: harnessRunGraph's own markRunRunning stamps started_at at
      // the top of the FIRST real invoke (lib/graph/runs.ts) — before that,
      // the thread has ZERO checkpoints, and @a2a-js/sdk's own ResultManager
      // calls THIS SAME load() to merge the task it just persisted
      // immediately after execute() publishes its first SUBMITTED event —
      // i.e. inside the very same message/send request that is already
      // racing to start that first real invoke via its own fire-and-forget
      // call (lib/a2a/executor.ts). Calling invoke(null, cfg) — THE RESUME
      // RULE's "continue" shape — against a thread with no checkpoint at
      // all is not just redundant with that race, it is unsafe: this
      // codebase's harnessRunGraph reads `input.runId` unconditionally at
      // its top, so a concurrent invoke(null) would throw on a virgin
      // thread instead of resuming anything. Skipping the continue attempt
      // until started_at is set means the message/send request's own
      // ResultManager-triggered reload is a pure read (reports 'submitted'
      // and does nothing else); the FIRST genuine tasks/get poll after that
      // is what actually advances the run, exactly once started_at proves a
      // checkpoint exists to continue from.
      if (row.status !== 'cancelled' && run.started_at !== null && isNonTerminalRunStatus(run.status)) {
        try {
          const { result } = await invokeGraphForUser({
            admin,
            userId,
            surface: 'run',
            graph: harnessRunGraph as unknown as CompiledGraphLike,
            threadId: row.thread_id,
          })
          const interrupted =
            typeof result === 'object' && result !== null && Array.isArray((result as { __interrupt__?: unknown[] }).__interrupt__)
          if (!interrupted) {
            // Not parked at an interrupt -> either it just finished, or it
            // was already fully complete and invoke(null) replayed the
            // cached terminal result (THE RESUME RULE, lib/graph/invoke.ts).
            // Either way agent_runs is now the freshest source of truth.
            const { data: freshRun } = await admin.from('agent_runs').select('*').eq('id', run.id).maybeSingle()
            if (freshRun) run = freshRun as AgentRunRow
          }
        } catch (err) {
          console.error(`[a2a] task-store: continue failed for task ${taskId}, thread ${row.thread_id}`, err)
          // Falls through and reports whatever agent_runs already held —
          // never surfaces the continue failure as if the TASK failed.
        }
      }

      const state = runStatusToTaskState(run.status)
      const status = taskStateToA2aTasksStatus(state)
      if (status !== row.status) {
        const { error: updateErr } = await admin.from('a2a_tasks').update({ status }).eq('task_id', taskId)
        if (updateErr) console.error(`[a2a] task-store: status update failed for ${taskId}: ${updateErr.message}`)
      }

      return {
        id: taskId,
        contextId: taskId, // one A2A task = one thread = its own context (spec Architecture table)
        status: { state, message: statusMessage(taskId, taskId, run), timestamp: new Date().toISOString() },
        artifacts: outcomeArtifact(taskId, run),
        history: [],
        metadata: { agent: row.agent, threadId: row.thread_id },
      }
    },

    async list() {
      // Not reached by any of the three classic methods this route wires
      // (message/send, tasks/get, tasks/cancel) — ListTasks has no v0.3
      // classic-method twin. A real, empty response rather than a throw:
      // TaskStore's contract has no "unsupported" signal to raise instead.
      return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }
    },
  }
}
