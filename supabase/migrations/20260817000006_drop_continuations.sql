-- DESTRUCTIVE — DO NOT APPLY YET. Apply only after
-- app/api/harness/cron/route.ts's RESUME_ATTEMPT_CEILING backstop has been
-- migrated off agent_runs.continuation_count onto its own column (or
-- retired outright). As of this migration's authoring, that route REUSES
-- continuation_count as a live consecutive-resume-failure-streak cap (see
-- its own header comment, and lib/harness/types.ts's AgentRunRow field doc)
-- — not the "prod still runs the pre-port executor" condition this file's
-- name might suggest. Dropping the column while that code is deployed
-- breaks the one backstop that bounds a thread whose resume attempt fails
-- before ever producing a new checkpoint (thread-ownership refusal, expired
-- demo thread, checkpointer connectivity failure) — CHECKPOINT_CEILING
-- structurally cannot see that case. This file exists now, gated, so the
-- eventual cleanup is one reviewed statement instead of a hand-written DDL
-- session; do not run it against apps/web/lib/harness/cron/route.ts's
-- current shape.
--
-- WHAT THIS DROPS
--   agent_runs.continuation_count — added by
--   20260728000009_run_incomplete_status.sql for the pre-port executor's
--   continueIncompleteRuns() (deleted in the langgraph port; see
--   app/api/harness/cron/route.ts's header). Safe to drop only once nothing
--   reads or writes it — i.e. after RESUME_ATTEMPT_CEILING no longer reuses
--   this column.
--
-- STATUS COLUMN
--   agent_runs.status has never had a CHECK constraint (untyped `text` —
--   see 20260728000009's own comment), so there is no constraint to alter.
--   'incomplete' (the pre-port pause state; see lib/harness/types.ts's
--   RunStatus) is retired from the TypeScript type and every switch over it
--   in the same commit that adds this file — the comment below is
--   documentation-only, matching how 'incomplete' was originally added.
--
-- OPERATOR NOTE — spike schemas
--   Stage 0 of this port created two scratch Postgres schemas directly
--   against the production database for its GO/NO-GO spikes:
--   'langgraph_spike' (checkpointer interrupt/resume proof) and 'mem0_spike'
--   (memory-store pgvector/injected-model proof). Neither was ever created
--   by a tracked migration (spike work is explicitly scratchpad-only), so
--   there is nothing here for `DROP SCHEMA` to target correctly by
--   assumption — an operator applying this migration should separately run
--   `drop schema if exists langgraph_spike cascade;` and
--   `drop schema if exists mem0_spike cascade;` once satisfied nothing still
--   reads them (they are unrelated to the real `langgraph` schema created by
--   20260817000001_langgraph_schema.sql, which this migration does not
--   touch).

alter table public.agent_runs
  drop column if exists continuation_count;

comment on column public.agent_runs.status is
  'queued | planning | running | completed | completed_with_errors | paused | failed | cancelled. ''paused'' = a LangGraph checkpoint parked mid-DAG (deadline interrupt, or an ask-form/review wait); resumed by app/api/harness/cron/route.ts''s resumeCheckpointedRuns(). ''incomplete'' (the pre-port executor''s pause state) is retired — see lib/harness/types.ts.';

notify pgrst, 'reload schema';
