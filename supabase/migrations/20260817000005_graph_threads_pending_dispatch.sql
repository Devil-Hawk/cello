-- Additive: a durable per-thread claim marking which (step, tool) the
-- copilot graph is about to dispatch, closing the replay hole a fix-round
-- adversarial review found in lib/graph/copilot.ts#dispatchExecute.
--
-- WHAT THIS PROTECTS AGAINST
--   A StateGraph node replays its WHOLE body on resume (see
--   lib/graph/copilot.ts's STATEGRAPH GOTCHA note) — including everything
--   AFTER an already-consumed interrupt(). Normally that's harmless (the
--   node reaches dispatchTool exactly once, on the pass a resume value was
--   actually delivered), but a crash between dispatchTool resolving and
--   dispatchExecute's own return committing to the checkpoint (a timeout, a
--   serverless eviction, an OOM) leaves the checkpoint exactly where it was
--   BEFORE the call — so any later continuation re-runs the whole node from
--   the top and, with no marker anywhere durable saying "this already
--   happened", silently re-fires an already-approved guarded (submit/send-
--   shaped) tool call with no new user confirmation. This column is that
--   marker: dispatchExecute claims it before calling dispatchTool for any
--   interrupt-approved dispatch, and treats finding an existing claim for
--   the SAME step as "outcome unknown — ask again" rather than retrying.
--
-- WHY A COLUMN ON graph_threads, NOT A NEW TABLE
--   The marker is scoped to exactly one thread and only ever needs the
--   latest claim (never a history of claims) — a single nullable jsonb
--   column is the smaller, additive change, matching last_invoked_at's own
--   precedent on this same table (20260817000002_graph_threads.sql).
--
-- WHY ADDITIVE
--   `add column if not exists`, nullable, no default: a metadata-only
--   change, safe to run any number of times, nothing existing rewritten.
--   No RLS change needed — the existing "own graph_threads select" policy
--   already covers every column, and this table has no authenticated
--   write policy at all (see its header): reads/writes of this column are
--   admin-client-only, same access pattern as every other column here.
alter table public.graph_threads
  add column if not exists pending_dispatch jsonb;

comment on column public.graph_threads.pending_dispatch is
  'Durable claim: {step, tool} for the tool call lib/graph/copilot.ts''s dispatchExecute is about to run. Written before dispatchTool is called for any interrupt-approved dispatch; cleared at the start of every new turn (beginTurn). NULL between dispatches. A claim found for the SAME step on re-entry means the prior attempt''s outcome is unknown, so dispatchExecute re-asks for confirmation instead of re-firing. Read/written only by the service-role admin client.';
