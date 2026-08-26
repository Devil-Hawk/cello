-- Re-issues trace_spans's table comment only — no shape change. Additive and
-- idempotent (comment on table is a plain overwrite, safe to run any number
-- of times).
--
-- 20260818000001_trace_spans.sql's original comment said "Emitted from
-- callLlm + the unit wrapper + the invoke wrapper — never from LangGraph
-- callbacks", true only through Step 2 (lib/trace/spans.ts as sole writer).
-- Step 7 (the journal swap, ruling 1's endgame) added a SECOND, direct
-- writer: lib/graph/journal.ts's upsertStep, for the live, resumable step
-- ledger the batched-flush SpanBuffer can't offer (see journal.ts's own
-- header). Migrations are never edited after landing (repo convention), so
-- the correction is a new file re-stating the comment rather than an edit to
-- 20260818000001_trace_spans.sql. lib/graph/graph-chokepoints.test.ts's
-- "trace_spans has exactly its two known writers" scan is the enforced
-- claim; this comment is the human-readable echo of it, same relationship
-- 20260818000006_drop_agent_steps.sql's header has to its own scan.

comment on table public.trace_spans is 'Durable per-span trace store (binding ruling 1). Two writers: lib/trace/spans.ts (buffered, flush-at-end OTel-shaped spans) and lib/graph/journal.ts (direct, synchronous step-ledger rows, attributes.stepStatus set) — never from LangGraph callbacks. Retention pruning rides the existing daily cron (app/api/harness/cron/route.ts).';
