// runUnitOnce — the door a plain request-context route uses to run a single
// unit through lib/graph/unit.ts#runAgentUnit WITHOUT a durable graph thread.
//
// WHY THIS FILE EXISTS
//   runAgentUnit journals into trace_spans via lib/graph/journal.ts, which
//   resolves a new step row's user_id off its agent_runs row (trace_spans.
//   user_id is NOT NULL — see that file's lookupRunUserId) — there is no
//   such thing as a step journaled against a run that doesn't exist: a
//   missing agent_runs row makes journalStepStart/Finish log and skip the
//   write entirely rather than journal anything (best-effort, same as every
//   other failure mode in that file — see its own header). lib/graph/
//   runs.ts's DAG runs always have that row because app/api/harness/run/
//   route.ts inserts the agent_runs row itself before ever calling
//   invokeGraphForUser. The four
//   one-shot routes this port flips onto runAgentUnit (analyze, match/batch,
//   outreach draft, outreach follow-up — step 9 of the langgraph port) call
//   runAgentUnit DIRECTLY, on purpose (see lib/graph/unit.ts's header: "a
//   second, schema-checked/metered/journaled door onto the SAME entry
//   functions" — not a reason to run the whole planner-driven graph for a
//   single job's analysis or a single outreach draft). Each of those routes
//   needs the identical bootstrap — mint an agent_runs row, run the unit,
//   finalize the row — so it lives once here instead of four times inline.
//
// A one-shot run never pauses (no interrupts, no checkpointer involved: this
// never touches lib/graph/invoke.ts or a compiled graph), so unlike a DAG run
// there is no 'paused' status to account for — it is 'running' until it is
// 'completed' or 'failed', full stop. On failure the agent_runs row is marked
// failed and the ORIGINAL error is rethrown unchanged, so a caller's own
// error handling (e.g. app/api/agents/analyze/route.ts's AnalystError ->
// HTTP-status mapping) sees exactly what runAgentUnit threw.

import type { AdminClient, UnitType } from '../harness/types'
import { runAgentUnit, type UnitResult } from './unit'

export interface RunUnitOnceArgs {
  admin: AdminClient
  userId: string
  /** agent_runs.goal — a short human-readable label for this one-shot call. */
  goal: string
  /** Static input for this unit — validated against agentSchemas[unitType].input. */
  input: unknown
}

export async function runUnitOnce<T extends UnitType>(
  unitType: T,
  args: RunUnitOnceArgs
): Promise<UnitResult<T>> {
  const { admin, userId, goal, input } = args

  const { data: run, error: insertErr } = await admin
    .from('agent_runs')
    .insert({ user_id: userId, goal, status: 'running', started_at: new Date().toISOString() })
    .select('id')
    .single()
  if (insertErr || !run) {
    throw new Error(`runUnitOnce: failed to create agent_runs row: ${insertErr?.message ?? 'no row returned'}`)
  }
  const runId = (run as { id: string }).id

  try {
    const result = await runAgentUnit(unitType, {
      input,
      admin,
      // No real graph thread exists for a one-shot call — threadId has no
      // reader (runAgentUnit destructures only {userId, runId} off
      // config.configurable), so it is set to runId rather than inventing a
      // second, equally-unused identifier.
      config: { configurable: { userId, runId, threadId: runId } },
    })
    await admin
      .from('agent_runs')
      .update({ status: 'completed', finished_at: new Date().toISOString(), spent_tokens: result.tokensUsed })
      .eq('id', runId)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await admin
      .from('agent_runs')
      .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
      .eq('id', runId)
    throw err
  }
}
