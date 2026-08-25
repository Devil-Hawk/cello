-- Dynamic harness runs: loop iterations + fan-out children (additive)
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   Both new columns are `add column if not exists` with no default, so
--   applying this does not rewrite agent_steps and every existing read path
--   (which never selects these columns today) keeps working untouched. The
--   comment updates are always safe to re-run. Safe to re-run.
--
-- WHAT IT ADDS
--   lib/harness/executor.ts can now drive a step through a LOOP (re-run the
--   same agent_type until a condition holds) or a FAN-OUT (spawn N parallel
--   children over a dependency's list output) — see lib/harness/schemas.ts
--   (LoopSpecSchema / FanOutSpecSchema) and lib/harness/dynamic.ts (the pure
--   control-flow). Each loop iteration / fan-out child is journaled as its
--   OWN agent_steps row (e.g. "source-roles#2") so the graph stays auditable
--   in the existing per-step journal instead of collapsing into one row that
--   overwrites itself on every iteration.
--
--   parent_step_id  — points a child row back at the plan step's own (parent)
--                      agent_steps row. NULL for a normal, non-looped,
--                      non-fanned-out step.
--   iteration       — 1-based iteration/child index. NULL for a normal step.
--
--   ON DELETE CASCADE on parent_step_id mirrors agent_steps.run_id's own
--   cascade-on-run-delete: deleting a run (or, in principle, a single step
--   row) takes its children with it rather than leaving orphans.

alter table public.agent_steps
  add column if not exists parent_step_id uuid references public.agent_steps(id) on delete cascade;

alter table public.agent_steps
  add column if not exists iteration integer;

create index if not exists idx_agent_steps_parent
  on public.agent_steps (parent_step_id)
  where parent_step_id is not null;

comment on column public.agent_steps.parent_step_id is 'NULL for a normal plan step. Non-null for a loop iteration or a fan-out child: points at the plan step''s own agent_steps row.';
comment on column public.agent_steps.iteration       is 'NULL for a normal step. 1-based loop-iteration or fan-out-child index otherwise.';

-- agent_runs.status gained 'completed_with_errors' (a run with >=1 failed step,
-- or one aborted on budget/deadline before finishing its graph, that still
-- produced at least one completed step — see lib/harness/executor.ts). The
-- column itself is untyped `text` (no CHECK constraint), so this is a
-- documentation-only change; no data migration needed for existing rows.
comment on column public.agent_runs.status is 'queued | planning | running | completed | completed_with_errors | failed | cancelled';

-- Make the new columns visible to PostgREST without waiting for its periodic
-- schema-cache refresh.
notify pgrst, 'reload schema';
