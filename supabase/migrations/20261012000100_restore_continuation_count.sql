-- Restore agent_runs.continuation_count (additive; safe to re-run).
--
-- 20260817000006_drop_continuations.sql was gated "DO NOT APPLY" until the
-- resume routine (lib/clock/routines/harness.ts) stopped using this column.
-- It has not stopped: RESUME_ATTEMPT_CEILING still reads and writes the column
-- as the consecutive resume-failure streak. Creating the production database
-- from scratch applied every migration, including the gated drop, so every
-- harness.resume tick failed with 42703 until the column came back.
--
-- The column stays until agent_runs itself is retired by the chat lane.

alter table public.agent_runs
  add column if not exists continuation_count integer not null default 0;

comment on column public.agent_runs.continuation_count is
  'Consecutive resume-attempt failure streak for the harness.resume routine (RESUME_ATTEMPT_CEILING). Bumped durably before each resume attempt so an attempt killed mid-request still counts, reset to 0 when an attempt returns without throwing. Bounds a thread whose resume fails before ever writing a checkpoint. 0 for a run that has never failed a resume attempt.';

notify pgrst, 'reload schema';
