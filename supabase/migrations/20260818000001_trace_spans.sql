-- trace_spans — the durable trace store binding ruling 1 promotes over
-- agent_steps: "agent_steps dies; trace_spans wins... stage 3 swaps
-- journal.ts's backing store to trace_spans, repoints the UI, drops
-- agent_steps." This migration only lands the table; journal.ts keeps
-- writing agent_steps until that stage-3 swap (see lib/graph/journal.ts's
-- own header, which already documents this table as its future backing
-- store).
--
-- WHAT WRITES HERE (per the design doc's reward-loop section): "trace_spans
-- emitted from callLlm + the unit wrapper + the invoke wrapper (all
-- surfaces, graphed or not — never from LangGraph callbacks)." Every writer
-- is server-side with the service-role admin client; see the RLS section
-- below for why that makes owner-SELECT-only correct here, not a gap.
--
-- SHAPE: one row per span in a trace tree. `trace_id` groups every span in
-- one graph/tool/llm call chain; `span_id` (not `id`, matching this table's
-- own vocabulary) is the row's own identity; `parent_span_id` links a span to
-- its immediate parent, NULL at the root. `kind` says what KIND of work the
-- span represents — a graph invocation, a single node, an LLM call, a tool
-- call, a judge call, or a raw HTTP call — so a trace viewer can render the
-- tree without guessing from the span's name.
--
-- RETENTION: not implemented by this migration. A later wiring step adds a
-- pruning pass to the existing daily cron (app/api/harness/cron/route.ts,
-- invoked by .github/workflows/harness-cron.yml — the same tick demo-wipe
-- already rides, see apps/web/lib/access/demo-wipe.ts) rather than standing
-- up a second scheduled path; noted here so that wiring lands beside a table
-- that already expects it, not as a surprise ALTER later.
--
-- RLS: user-data class (ruling 5, class 2 — RLS + demo wipe-at-expiry, not
-- the trigger-deny treatment api_tokens/apply_phase_tokens/graph_threads
-- get). Owner SELECT only, no authenticated insert/update/delete policy —
-- identical shape and identical justification to graph_threads
-- (20260817000002_graph_threads.sql): every write is the service-role admin
-- client emitting a span server-side, which bypasses RLS entirely, so
-- policies only need to keep a signed-in browser's own PostgREST calls from
-- writing here directly. With no insert/update/delete policy for
-- `authenticated`, PostgREST refuses every one of those verbs outright
-- (default-deny — a table with RLS enabled and no policy for a verb allows
-- nothing under that verb for that role).
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

create table if not exists public.trace_spans (
    trace_id uuid not null,
    span_id uuid primary key default gen_random_uuid(),
    parent_span_id uuid references public.trace_spans(span_id) on delete set null,
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- Back-pointers, both nullable and independent: a span may belong to a
    -- LangGraph thread, an agent_runs row, both, or neither (a bare tool/http
    -- call outside any run). ON DELETE SET NULL on both, same rationale as
    -- application_drafts.resume_document_id in phaseB — the span row is the
    -- durable trace record; losing the pointer loses one cross-reference, not
    -- the observed fact.
    thread_id uuid references public.graph_threads(thread_id) on delete set null,
    run_id uuid references public.agent_runs(id) on delete set null,

    name text not null,
    kind text not null check (kind in ('graph', 'node', 'llm', 'tool', 'judge', 'http')),

    start_time timestamptz not null,
    end_time timestamptz,
    status text check (status in ('ok', 'error')),

    attributes jsonb,
    events jsonb
);

comment on table  public.trace_spans           is 'Durable per-span trace store (binding ruling 1). Emitted from callLlm + the unit wrapper + the invoke wrapper — never from LangGraph callbacks. Retention pruning is a later cron wiring, not implemented here (see this migration''s header).';
comment on column public.trace_spans.trace_id  is 'Groups every span in one graph/tool/llm call chain. Not a FK — a trace has no separate row of its own, it is purely the shared value spans agree on.';
comment on column public.trace_spans.kind      is 'graph|node|llm|tool|judge|http — what kind of work this span represents.';
comment on column public.trace_spans.status    is 'ok|error. NULL while the span is still open (end_time also NULL).';
comment on column public.trace_spans.attributes is 'Span-kind-specific structured detail (model, tokens, tool name, args digest, ...).';
comment on column public.trace_spans.events    is 'Point-in-time events within the span''s lifetime (retries, partial results), as a JSON array.';

create index if not exists idx_trace_spans_user_start
    on public.trace_spans (user_id, start_time desc);

create index if not exists idx_trace_spans_trace
    on public.trace_spans (trace_id);

create index if not exists idx_trace_spans_run
    on public.trace_spans (run_id)
    where run_id is not null;

alter table public.trace_spans enable row level security;

-- SELECT only, own rows only — see the file header for why insert/update/
-- delete deliberately have no policy at all rather than a `false` one.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'trace_spans'
      and policyname = 'own trace_spans select'
  ) then
    create policy "own trace_spans select"
      on public.trace_spans for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_class
        where oid = 'public.trace_spans'::regclass and relrowsecurity
    ) then
        raise exception 'row level security is not enabled on public.trace_spans';
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'trace_spans'
          and policyname = 'own trace_spans select'
    ) then
        raise exception 'public.trace_spans is missing its select policy';
    end if;
end
$$;

notify pgrst, 'reload schema';
