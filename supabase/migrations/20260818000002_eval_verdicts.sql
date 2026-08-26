-- eval_verdicts — the single verdict store the design doc names outright:
-- "eval_verdicts is the single verdict store; /api/outreach/judge persists
-- verdicts (the audited dead end closes early; its existing budget calls are
-- preserved)." One row per judged subject: a match score, a cv_tailor draft,
-- an outreach draft, a plan, a tool call, or a distillation pass.
--
-- WHY subject_kind + subject_id, NOT A DIRECT FK PER SUBJECT
-- A verdict subject spans six unrelated tables (jobs.match_score is a column
-- not a row, application_drafts, outreach_messages, a future plan/tool-call
-- shape, distill_insights' own aggregate run) — one column per possible FK
-- would mean five more nullable FK columns, all but one NULL on every row.
-- (subject_kind, subject_id) is the same open-polymorphic-reference shape
-- interactions.ref_table/ref_id already uses in this codebase for the
-- identical problem (one projection row, several possible source tables).
--
-- WHY verdict CARRIES insufficient-data/insufficient-budget/unjudged
-- REFUSE-OVER-GUESS (invariant 7): meteredJudgeClient's budget check and
-- MIN_SAMPLE_PER_CLASS both refuse before spending, and the refusal itself
-- has to be a readable, typed row here — never silence, and never a
-- substituted score standing in for "we didn't actually judge this." A
-- caller reading eval_verdicts for a subject must be able to tell "not yet
-- judged" (no row) apart from "judged, and here is why we couldn't score
-- it" (a row with one of these three verdicts and score left NULL).
--
-- WHAT WRITES HERE: meteredJudgeClient-backed judge calls (lib/evals/judge.ts)
-- and the deterministic containment gate (judge='deterministic'), all
-- server-side with the service-role admin client. See the RLS section below
-- for why that makes owner-SELECT-only correct here, not a gap.
--
-- RLS: user-data class (ruling 5, class 2), identical shape and
-- justification to trace_spans (20260818000001_trace_spans.sql) and
-- graph_threads (20260817000002_graph_threads.sql) — owner SELECT only, no
-- authenticated insert/update/delete policy, because every write is the
-- service-role admin client, which bypasses RLS entirely.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

create table if not exists public.eval_verdicts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- Back-pointers, both nullable and independent — same rationale as
    -- trace_spans.thread_id/run_id: a verdict may trace back to the run and
    -- span that produced its subject, or may not (a verdict recomputed
    -- offline by distill_insights has no live span).
    run_id uuid references public.agent_runs(id) on delete set null,
    span_id uuid references public.trace_spans(span_id) on delete set null,

    subject_kind text not null check (subject_kind in (
        'match_score', 'cv_tailor_draft', 'outreach_draft', 'plan', 'tool_call', 'distillation'
    )),
    -- The row id within whatever table subject_kind names (jobs, application_
    -- drafts, outreach_messages, ...). Not FK'd — see file header.
    subject_id uuid not null,

    judge text not null check (judge in ('factuality', 'closed_qa', 'containment', 'deterministic')),
    score numeric,
    verdict text not null check (verdict in (
        'pass', 'fail', 'insufficient-data', 'insufficient-budget', 'unjudged', 'error'
    )),
    threshold numeric,
    rationale text,
    model text,
    tokens_used integer,

    created_at timestamptz not null default now()
);

comment on table  public.eval_verdicts             is 'Single verdict store (design doc: "eval_verdicts is the single verdict store"). One row per judged subject. Refuse-over-guess: insufficient-data/insufficient-budget/unjudged are typed verdicts, never silence or a substituted score.';
comment on column public.eval_verdicts.subject_kind is 'match_score|cv_tailor_draft|outreach_draft|plan|tool_call|distillation — which kind of thing was judged.';
comment on column public.eval_verdicts.subject_id   is 'The row id within whichever table subject_kind names. Not FK''d: subject_kind spans multiple unrelated tables (see this migration''s header).';
comment on column public.eval_verdicts.judge        is 'factuality|closed_qa|containment|deterministic — which judge produced this verdict. containment/deterministic need no LLM call.';
comment on column public.eval_verdicts.score        is 'NULL when verdict is a refusal (insufficient-data/insufficient-budget/unjudged/error) — a refusal never carries a substituted score.';
comment on column public.eval_verdicts.tokens_used  is 'Tokens spent producing this verdict, via meteredJudgeClient. NULL for judge=deterministic (no model call).';

create index if not exists idx_eval_verdicts_user_subject
    on public.eval_verdicts (user_id, subject_kind, subject_id);

create index if not exists idx_eval_verdicts_user_created
    on public.eval_verdicts (user_id, created_at desc);

alter table public.eval_verdicts enable row level security;

-- SELECT only, own rows only — see the file header for why insert/update/
-- delete deliberately have no policy at all rather than a `false` one.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'eval_verdicts'
      and policyname = 'own eval_verdicts select'
  ) then
    create policy "own eval_verdicts select"
      on public.eval_verdicts for select
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
        where oid = 'public.eval_verdicts'::regclass and relrowsecurity
    ) then
        raise exception 'row level security is not enabled on public.eval_verdicts';
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'eval_verdicts'
          and policyname = 'own eval_verdicts select'
    ) then
        raise exception 'public.eval_verdicts is missing its select policy';
    end if;
end
$$;

notify pgrst, 'reload schema';
