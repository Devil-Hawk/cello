// The AgentExecutor app/api/a2a/route.ts hands to @a2a-js/sdk's
// DefaultRequestHandler — maps an incoming A2A message to one of the three
// exposed agents and starts it through invokeGraphForUser (spec binding
// ruling 7: no second graph door), exactly the "fresh thread; a2a_tasks
// row" shape spec Step 3 asks for.
//
// DOES NOT BLOCK ON THE FULL RUN — same reasoning as
// lib/harness/copilot-tools.ts#doTriggerRun (see that function's own
// comment): a harness run can take up to MAX_RUN_MS. execute() publishes
// ONE task event (state=SUBMITTED) and returns; @a2a-js/sdk's
// DefaultRequestHandler treats SUBMITTED as neither terminal nor
// interrupted, so `_settleBus` finishes the event bus the instant this
// promise resolves and the blocking `message/send` RPC returns with that
// SUBMITTED task — verified against the real SDK source
// (DefaultRequestHandler.sendMessage/_runExecutor/_settleBus in
// node_modules/@a2a-js/sdk/dist/server/index.js), not assumed. The caller
// then polls tasks/get, whose non-terminal branch (lib/a2a/task-store.ts)
// is what actually advances the run.
//
// READ/DRAFT-ONLY BY CONSTRUCTION, NOT BY A RUNTIME GUARD
//   buildA2aPlan (lib/a2a/agent.ts) only ever emits a single step whose
//   agent_type is matcher | company_researcher | interview_prep — none of
//   which is 'applier' (the only step type that can submit — see
//   lib/harness/schemas.ts's stripUntrustedSubmit) — so no plan this file
//   builds can ever reach a submit-capable node. lib/a2a/graph-shape.test.ts
//   asserts this by construction rather than trusting this comment.
//
// NO PROMPT-BUILDING HERE — see lib/a2a/agent.ts's header: every field this
// file threads through (jobIds/companyId/jobId) is an id, not free text;
// this file is a FORWARDER in lib/security/injection-chokepoints.test.ts's
// ledger for the same reason app/api/mcp/route.ts is.

import { AgentEvent } from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import { TaskState } from '@a2a-js/sdk'
import type { Message } from '@a2a-js/sdk'
import type { AdminClient } from '../harness/types'
import { invokeGraphForUser, type CompiledGraphLike } from '../graph/invoke'
import { harnessRunGraph, markRunPausedOnInterrupt } from '../graph/runs'
import { STATE_USER_ID_KEY } from './context'
import { buildA2aPlan, isUserMessage, parseA2aAgentRequest } from './agent'

/** Single-step A2A run: far less headroom than a multi-step copilot
 *  trigger_run (lib/harness/copilot-tools.ts's COPILOT_RUN_BUDGET=90_000)
 *  needs, since buildA2aPlan never emits more than one step. */
const A2A_RUN_BUDGET_TOKENS = 40_000

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Publishes a single terminal FAILED task carrying `reason` as its status
 *  message — the loud-failure shape this surface wants for anything
 *  malformed or unrecognized (spec Step 3, item 6: "loud error ... NEVER
 *  silent content loss"). Deliberately NOT a thrown Error left for
 *  @a2a-js/sdk's own `_runExecutor` catch to turn into a task: that path
 *  synthesizes BOTH a 'task' event AND a SEPARATE 'statusUpdate' event, and
 *  the second one's `ResultManager.applyStatusUpdate` re-loads the task
 *  from the TaskStore — a round trip lib/a2a/task-store.ts's save() cannot
 *  always satisfy for a task with no real agent/thread behind it yet (the
 *  a2a_tasks.agent CHECK constraint has no "none of these" value — see that
 *  migration). Publishing exactly ONE terminal task ourselves and returning
 *  normally sidesteps that round trip entirely: `_settleBus` finishes the
 *  bus on ANY terminal state, not only ones the SDK synthesized itself
 *  (verified against the real SDK source, same as this file's header note
 *  on the SUBMITTED path). */
function publishFailure(eventBus: ExecutionEventBus, taskId: string, contextId: string, message: Message | undefined, reason: string): void {
  eventBus.publish(
    AgentEvent.task({
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: {
          messageId: `${taskId}:error`,
          contextId,
          taskId,
          role: 2 /* Role.ROLE_AGENT */,
          parts: [{ content: { $case: 'text', value: reason }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: message ? [message] : [],
      metadata: {},
    })
  )
}

export function createA2aExecutor(admin: AdminClient): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const context: ServerCallContext = requestContext.context
      const taskId = requestContext.taskId
      const contextId = requestContext.contextId
      const message = requestContext.userMessage

      const userId = context.state.get(STATE_USER_ID_KEY) as string | undefined
      if (!userId) {
        publishFailure(eventBus, taskId, contextId, message, 'A2A request context is missing an authenticated userId.')
        return
      }
      if (!isUserMessage(message)) {
        publishFailure(eventBus, taskId, contextId, message, `Expected role=ROLE_USER, got role=${message.role} (see scripts/spike-a2a-roundtrip.ts case B).`)
        return
      }

      let req: ReturnType<typeof parseA2aAgentRequest>
      try {
        // zod-validates the structured request; the parse error's own
        // message becomes the FAILED task's reason.
        req = parseA2aAgentRequest(message)
      } catch (e) {
        publishFailure(eventBus, taskId, contextId, message, errMsg(e))
        return
      }

      // One graph_threads row minted directly (this is a plain insert, not
      // a graph.invoke/stream call — ruling 7's "one door" governs the
      // latter, not row ownership bookkeeping), so thread_id is known
      // BEFORE the background run starts and can be published on the very
      // first task event and stored on a2a_tasks synchronously. Both writes
      // are wrapped: a failure here has no real agent/thread to hand
      // save() either, same reasoning as the validation-failure branches
      // above — publish once, return, never throw.
      let threadId: string
      let runId: string
      try {
        const { data: threadRow, error: threadErr } = await admin
          .from('graph_threads')
          .insert({ user_id: userId, surface: 'run' })
          .select('thread_id')
          .single()
        if (threadErr || !threadRow) throw new Error(`Failed to mint a graph thread: ${threadErr?.message ?? 'no row returned'}`)
        threadId = (threadRow as { thread_id: string }).thread_id

        const plan = buildA2aPlan(req)
        const { data: runRow, error: runErr } = await admin
          .from('agent_runs')
          .insert({ user_id: userId, goal: plan.goal, status: 'queued', budget_tokens: A2A_RUN_BUDGET_TOKENS, plan, thread_id: threadId })
          .select('id')
          .single()
        if (runErr || !runRow) throw new Error(`Failed to create agent_runs row: ${runErr?.message ?? 'no row returned'}`)
        runId = (runRow as { id: string }).id
      } catch (e) {
        publishFailure(eventBus, taskId, contextId, message, errMsg(e))
        return
      }

      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [message],
          // Read back by lib/a2a/task-store.ts#save — see that file's header.
          metadata: { agent: req.agent, threadId, runId },
        })
      )

      // DO NOT AWAIT THE WHOLE RUN — see file header. Errors here are
      // failures of STARTING the run (thread/run row already committed
      // above); a normal step failure inside the graph is journaled onto
      // agent_runs by harnessRunGraph itself and read back by
      // lib/a2a/task-store.ts on the next poll, same as any other harness run.
      void invokeGraphForUser({
        admin,
        userId,
        surface: 'run',
        graph: harnessRunGraph as unknown as CompiledGraphLike,
        threadId,
        input: { runId },
      })
        .then(({ result }) => markRunPausedOnInterrupt(admin, runId, result))
        .catch(async (err) => {
          console.error('[a2a] background agent run failed', runId, err)
          await admin
            .from('agent_runs')
            .update({ status: 'failed', error: errMsg(err), finished_at: new Date().toISOString() })
            .eq('id', runId)
        })
    },

    async cancelTask(taskId: string): Promise<void> {
      // No ownership check on taskId here — none is needed ONLY because the
      // SDK's DefaultRequestHandler.cancelTask always calls
      // taskStore.load(taskId, context) first and throws TaskNotFoundError
      // before ever reaching this method, and our load() (task-store.ts)
      // returns undefined for a task the context's userId doesn't own. This
      // method is never reachable directly for another user's task — but it
      // depends on that call order holding upstream, not on anything checked
      // in this file. Don't add a second entry point to this executor
      // without re-verifying that invariant.
      //
      // load() (lib/a2a/task-store.ts) is what actually stops future polls
      // from resuming — see that file's header for the load-before-cancel
      // ordering this method composes with. Marking a2a_tasks here directly
      // (rather than only through the SDK's own save() call, which the
      // request handler issues right after this resolves) means a poll
      // that races the cancel RPC still observes 'cancelled' as soon as
      // either write lands, not only after the SDK's own save() completes.
      const { error } = await admin.from('a2a_tasks').update({ status: 'cancelled' }).eq('task_id', taskId)
      if (error) console.error(`[a2a] cancelTask: failed to mark ${taskId} cancelled`, error.message)
    },
  }
}
