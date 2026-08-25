-- Harness resumption: a run that hits its wall-clock deadline mid-DAG is now
-- PAUSED, not failed (additive; safe to re-run).
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   agent_runs.status is untyped `text` with no CHECK constraint (see
--   20260728000004_dynamic_runs.sql's own comment when 'completed_with_errors'
--   was added the same way), so teaching the executor a new status value is a
--   documentation-only change here — no data migration needed for existing
--   rows. The one real schema change is ONE new NOT NULL column with a
--   default, added via `add column if not exists`, so applying this does not
--   rewrite the table and every existing read path (which never selects this
--   column today) keeps working untouched.
--
-- WHAT IT ADDS
--   agent_runs.status gains 'incomplete' — see lib/harness/executor.ts and
--   the RunStatus doc in lib/harness/types.ts. The run stopped at its
--   MAX_RUN_MS deadline (NOT a budget exhaustion, which stays
--   'completed_with_errors'/'failed' exactly as before) with agent_steps rows
--   still 'pending'. app/api/harness/cron/route.ts's continueIncompleteRuns()
--   re-enters runAgentRun for these runs so the work already done (sourcing,
--   matching, ...) is never thrown away and only what's left actually runs.
--
--   agent_runs.continuation_count — how many times continueIncompleteRuns()
--   has re-entered runAgentRun for a given run after it paused. Bumped
--   BEFORE each continuation attempt (not after), so a continuation that
--   itself gets killed mid-request still counts against
--   MAX_CONTINUATIONS in that route — a pathological plan that always lands
--   back on the deadline cannot loop forever re-attempting itself.

alter table public.agent_runs
  add column if not exists continuation_count integer not null default 0;

comment on column public.agent_runs.status is
  'queued | planning | running | completed | completed_with_errors | incomplete | failed | cancelled. ''incomplete'' = paused at the executor''s wall-clock deadline with steps still pending; auto-resumed by app/api/harness/cron/route.ts, bounded by continuation_count. Never used for budget exhaustion (see lib/harness/types.ts).';

comment on column public.agent_runs.continuation_count is
  'How many times app/api/harness/cron/route.ts has re-entered runAgentRun for this run after it paused with status ''incomplete''. Bumped before each attempt so a crashed continuation still counts against the cap. 0 for a run that has never been continued.';

-- Make the new column visible to PostgREST without waiting for its periodic
-- schema-cache refresh.
notify pgrst, 'reload schema';
