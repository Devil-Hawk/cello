-- Strategy proposal outcomes: closes the loop lib/strategy/proposals.ts opens.
-- proposals.ts turns an 'answered' finding into a suggestion the user can
-- accept or dismiss, but nothing ever recorded an acceptance or checked
-- whether it helped. lib/strategy/measure.ts has the pure comparison logic
-- (recordAcceptedProposal / measureProposalEffect) and, per that file's
-- header, "no schema exists yet to persist an AcceptedProposalRecord" — this
-- migration is that schema.
--
-- ONE ROW PER ACCEPTANCE, not per proposal: lib/strategy/proposals.ts's
-- `counter` is a per-process module-level variable, so `proposal_id` (e.g.
-- "sourceFunnel-3") is NOT a stable identity across server restarts or
-- separate serverless invocations — see AcceptedProposalRecord's `title`
-- field doc in measure.ts for why the wording is denormalized in here rather
-- than re-derived later. No uniqueness constraint on proposal_id follows from
-- the same fact: it cannot be relied on to dedupe.
--
-- metrics_before is a JSONB snapshot of lib/strategy/datasource.ts's
-- JobScopeCounts, taken on the SERVER at acceptance time (see
-- app/api/strategy/outcomes/route.ts) — never a client-supplied number, or
-- the measurement this table exists to support would be gameable.
--
-- Additive and idempotent, matching this repo's migration convention: `create
-- table if not exists`, guarded indexes, RLS mirrors
-- 20260729000001_application_receipts.sql's full-CRUD-by-owner shape.

create table if not exists public.strategy_proposal_outcomes (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    proposal_id text not null,
    question text not null,
    title text not null,
    accepted_at timestamptz not null,
    metrics_before jsonb not null,
    created_at timestamptz default now() not null
);

comment on table public.strategy_proposal_outcomes is
  'One row per accepted lib/strategy proposal — the "before" half of a before/after comparison. lib/strategy/measure.ts#measureProposalEffect compares metrics_before to a fresh JobScopeCounts read at query time; it refuses to render a verdict below its documented observation-window and new-jobs floors (see that file), so a recent row here is expected to read as "still measuring", not a bug.';
comment on column public.strategy_proposal_outcomes.proposal_id is
  'Matches StrategyProposal.id (lib/strategy/proposals.ts) AT ACCEPTANCE TIME. Not a stable identity across process restarts — see this table''s header — kept for same-session traceability only, never assumed unique.';
comment on column public.strategy_proposal_outcomes.question is
  'Which question produced the proposal (StrategyProposal.evidence[].question), e.g. "sourceFunnel". Kept for future grouping ("do filterImpact-derived proposals land more often than sourceFunnel ones") — see measure.ts''s AcceptedProposalRecord.';
comment on column public.strategy_proposal_outcomes.title is
  'StrategyProposal.title as it read AT THE TIME IT WAS ACCEPTED, copied in rather than re-derived later — proposals are regenerated fresh on every report run and carry no stable content beyond a per-process counter, so this is the only durable record of what was actually approved.';
comment on column public.strategy_proposal_outcomes.metrics_before is
  'JobScopeCounts (lib/strategy/datasource.ts#getJobScopeCounts), read on the server the moment this proposal was accepted — the "before" snapshot lib/strategy/measure.ts compares a later read against. Reuses that shape rather than inventing a parallel one.';

create index if not exists idx_strategy_proposal_outcomes_user
  on public.strategy_proposal_outcomes (user_id, accepted_at desc);
create index if not exists idx_strategy_proposal_outcomes_question
  on public.strategy_proposal_outcomes (user_id, question);

alter table public.strategy_proposal_outcomes enable row level security;

create policy "own strategy outcomes select" on public.strategy_proposal_outcomes for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own strategy outcomes insert" on public.strategy_proposal_outcomes for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own strategy outcomes update" on public.strategy_proposal_outcomes for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own strategy outcomes delete" on public.strategy_proposal_outcomes for delete to authenticated
    using ((select auth.uid()) = user_id);

notify pgrst, 'reload schema';
