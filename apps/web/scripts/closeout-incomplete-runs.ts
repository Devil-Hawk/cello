/**
 * One-time (idempotent) operational step for the LangGraph harness-run port
 * (docs/superpowers/specs/2026-08-16-langgraph-port-design.md).
 *
 * WHAT THIS CLOSES OUT
 *   Every agent_runs row still carrying the pre-port status='incomplete' —
 *   the bespoke executor's own pause state (deadline hit mid-DAG, tracked via
 *   continuation_count + app/api/harness/cron/route.ts's old
 *   continueIncompleteRuns()). That mechanism is deleted by this port
 *   (lib/harness/types.ts's RunStatus['paused'] doc) in favor of a real
 *   LangGraph checkpoint, so an 'incomplete' row left over from before this
 *   deploy has nothing left that will ever resume it — cron's new resume
 *   pass (app/api/harness/cron/route.ts#resumeCheckpointedRuns) only looks at
 *   'paused' and stale 'running' rows, never 'incomplete'.
 *
 * WHAT IT DOES
 *   Exactly what the old continueIncompleteRuns() did to a run that
 *   exhausted MAX_CONTINUATIONS while still incomplete: closes it out as
 *   'completed_with_errors' with a clear, honest reason, leaving whatever
 *   steps DID complete (and their output) intact and visible — nothing here
 *   deletes agent_steps or touches a run's plan/result.
 *
 * WHEN THIS RUNS
 *   At deploy time, once, per the langgraph-port-design rollout runbook — NOT
 *   part of any request path, NOT scheduled, NOT invoked by this task. Every
 *   run this script would touch predates the deploy that removes
 *   continueIncompleteRuns(), so running it once after that deploy lands is
 *   sufficient; a second run is a safe no-op (the `status = 'incomplete'`
 *   filter matches nothing left).
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) — the same service-role credentials
 *   lib/harness/supabase-admin.ts#createAdminClient() uses everywhere else in
 *   this app. That helper (not a re-derived client) is imported directly
 *   below — it has no Next.js-only dependencies, and apps/web/scripts already
 *   imports freely from lib/ (see scripts/backfill-classification.ts).
 *
 * Usage:
 *   set -a && source /path/to/prod.env && set +a
 *   npx tsx scripts/closeout-incomplete-runs.ts                # apply
 *   npx tsx scripts/closeout-incomplete-runs.ts --dry-run       # report only
 */
import { createAdminClient } from '../lib/harness/supabase-admin'

interface IncompleteRun {
  id: string
  user_id: string
  goal: string
  continuation_count: number | null
  created_at: string
}

const CLOSEOUT_REASON =
  "closed out by scripts/closeout-incomplete-runs.ts: this run paused under the pre-LangGraph-port 'incomplete' " +
  'mechanism (continuation_count / continueIncompleteRuns), which no longer exists to resume it — see ' +
  "lib/harness/types.ts's RunStatus['paused'] doc."

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const supabase = createAdminClient()

  console.log('closeout-incomplete-runs')
  console.log(`  mode : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`)

  const { data, error } = await supabase
    .from('agent_runs')
    .select('id, user_id, goal, continuation_count, created_at')
    .eq('status', 'incomplete')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`select failed: ${error.message}`)

  const rows = (data ?? []) as IncompleteRun[]
  console.log(`\nfound ${rows.length} row(s) with status='incomplete'`)
  if (rows.length === 0) {
    console.log('nothing to do.')
    return
  }

  for (const row of rows) {
    console.log(
      `  ${row.id}  user=${row.user_id}  continuations=${row.continuation_count ?? 0}  created=${row.created_at}  goal="${row.goal.slice(0, 80)}"`
    )
  }

  if (dryRun) {
    console.log(`\nDRY RUN — nothing written. Re-run without --dry-run to close out ${rows.length} run(s).`)
    return
  }

  let closed = 0
  const failures: string[] = []
  for (const row of rows) {
    // Guarded by `.eq('status', 'incomplete')` on the write too, same
    // discipline the old continueIncompleteRuns() used: don't clobber a row
    // that changed status between the select above and this update.
    const { error: updErr } = await supabase
      .from('agent_runs')
      .update({ status: 'completed_with_errors', error: CLOSEOUT_REASON, finished_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'incomplete')
    if (updErr) {
      console.error(`  FAILED ${row.id}: ${updErr.message}`)
      failures.push(row.id)
      continue
    }
    console.log(`  closed  ${row.id}`)
    closed += 1
  }

  console.log(`\nclosed ${closed} of ${rows.length} row(s)${failures.length > 0 ? ` — ${failures.length} failure(s): ${failures.join(', ')}` : ''}`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
