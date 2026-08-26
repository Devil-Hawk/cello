-- insights — the one durable-memory table (binding ruling 3 of the langgraph
-- port design doc): "One insights table: `insights` with `supersedes_id` and
-- status `active|retired|contradicted`. Writers go through
-- `lib/insights/store.ts#ingestInsight()` and `lib/kb/ingest.ts` only."
--
-- WHAT THIS REPLACES
--   The 12-slot standingPreferences FIFO in profiles.preferences (lib/harness/
--   standing-preferences.ts) evicted the OLDEST preference once a 13th was
--   recorded, permanently — a preference stated ten conversations ago and
--   never repeated just vanished, no trace. This table never evicts: every
--   ingested insight is a row that lives until something explicitly retires
--   or contradicts it. lib/insights/store.ts#readStandingPreferences still
--   injects only the most-recently-affirmed 12 into the prompt (the context-
--   window argument in standing-preferences.ts's header is still correct —
--   see that file's MAX_STANDING_PREFERENCES comment) but the other N+1..
--   stay queryable via searchInsights instead of being destroyed.
--
-- WHY status HAS THREE VALUES, NOT A BOOLEAN
--   'retired' and 'contradicted' are different histories a reader needs to
--   tell apart: 'retired' is "no longer relevant" (e.g. a goal that finished),
--   'contradicted' is "actively superseded by a newer, conflicting statement"
--   (supersedes_id points at what replaced it — see ingestInsight). Neither
--   ever becomes a DELETE: ruling 3 in the spec is explicit that contradictions
--   "are marked, never deleted" — a judge or the user revisiting an old
--   decision needs the superseded row still there to explain WHY the current
--   one exists.
--
-- WHY kind IS AN OPEN SET OF FIVE, NOT JUST 'preference'
--   Ruling 3 / the KB+memory design section names three writers: "the
--   reward-loop distiller, the judge aggregation, and user-stated
--   preferences." Preferences are user-stated; strategy/pattern are what the
--   distiller and judge aggregation produce (a recurring winning approach, a
--   recurring failure mode); company_note is a fact pinned to one employer
--   (hence the nullable company_id FK below); self is a durable fact about the
--   user themselves (not a preference — a preference is a want, 'self' is a
--   fact: "based in Austin", "authorized to work in the US without
--   sponsorship"). One table, one CHECK, because every kind shares the same
--   lifecycle (active/retired/contradicted) and the same retrieval shape
--   (embed + search) — a table per kind would be five copies of both.
--
-- Demo-lockdown class: user-data table (ruling 5's second class, same as
-- interactions — see 20260816000004_interactions.sql's header for why that
-- class gets RLS + demo-wipe-at-expiry rather than the trigger-deny treatment
-- api_tokens/apply_phase_tokens/graph_threads get: an insight is a user's own
-- accumulated memory, not a bare capability token). The wipe sweep lives in
-- apps/web/lib/access/demo-wipe.ts, not duplicated here.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

create table if not exists public.insights (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    kind text not null check (kind in ('preference', 'strategy', 'pattern', 'company_note', 'self')),
    statement text not null,
    evidence jsonb,
    confidence real,
    status text not null default 'active' check (status in ('active', 'retired', 'contradicted')),
    source text not null check (source in ('reward_loop', 'user_stated', 'judge', 'strategy_module')),
    company_id uuid references public.companies(id) on delete set null,
    supersedes_id uuid references public.insights(id),
    embedding extensions.vector(1536),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.insights is 'Durable memory: preferences, distilled strategies/patterns, company notes and self-facts. Written ONLY through lib/insights/store.ts#ingestInsight and lib/kb/ingest.ts (binding ruling 3) — never deleted, contradictions are marked via status=''contradicted''+supersedes_id.';
comment on column public.insights.statement is 'The insight as a short sentence, in whoever stated/derived it''s own terms — same "sentences, not schema" reasoning as the FIFO this replaces (see file header).';
comment on column public.insights.evidence is 'Pointers back to what grounded this (verdict ids, job ids, conversation refs) — required for reward_loop/judge-sourced rows per the design doc''s "every insight carries evidence pointers back to raw verdicts."';
comment on column public.insights.supersedes_id is 'Set on a row being superseded: points at the NEW insight that replaced it. Only meaningful alongside status=''contradicted''.';
comment on column public.insights.embedding is 'text-embedding-3-small (1536 dims), written best-effort by lib/insights/store.ts#ingestInsight. NULL = not yet embedded (no provider configured, or the embed call failed) — searchInsights degrades to recency-only ranking for these rows.';

create index if not exists idx_insights_user_kind_status
    on public.insights (user_id, kind, status);

-- Partial, same reasoning as idx_kb_chunks_embedding (20260816000001_pgvector_
-- enable.sql): only embedded rows belong in the ANN index, and every
-- unembedded row still needs to be found some other way (recency) regardless.
create index if not exists idx_insights_embedding
    on public.insights using hnsw (embedding vector_cosine_ops)
    where embedding is not null;

-- Enforces "a restatement refreshes in place, it never piles up as a second
-- row" (lib/insights/store.ts#ingestInsight's header) at the one place a race
-- actually closes it: the DB. An app-level SELECT-then-INSERT lets two
-- concurrent calls for the same normalized statement both pass the "no dup
-- yet" check before either commits. This repo's own precedent for exactly
-- this class of bug is always a DB-level unique index, never an app-level
-- check (uniq_user_mcp_servers_user_name, uniq_kb_documents_source_external,
-- uniq_interactions_ref, unique_draft_per_job) — this is that index for
-- insights. Partial + expression, same shape as uniq_user_mcp_servers_user_
-- name's `lower(name)`: only ACTIVE rows compete for a dedupe slot (a
-- contradicted/retired row must never block a fresh restatement of the same
-- fact), and the expression is dedupeKey's normalization ported to SQL —
-- reused verbatim by upsert_insight's ON CONFLICT target and the backfill's
-- ON CONFLICT below.
create unique index if not exists uniq_insights_user_kind_statement_active
    on public.insights (user_id, kind, (btrim(regexp_replace(lower(statement), '[^a-z0-9]+', ' ', 'g'))))
    where status = 'active';

alter table public.insights enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'insights'
          and policyname = 'own insights select'
    ) then
        create policy "own insights select"
            on public.insights for select
            to authenticated
            using ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'insights'
          and policyname = 'own insights insert'
    ) then
        create policy "own insights insert"
            on public.insights for insert
            to authenticated
            with check ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'insights'
          and policyname = 'own insights update'
    ) then
        create policy "own insights update"
            on public.insights for update
            to authenticated
            using ((select auth.uid()) = user_id)
            with check ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'insights'
          and policyname = 'own insights delete'
    ) then
        create policy "own insights delete"
            on public.insights for delete
            to authenticated
            using ((select auth.uid()) = user_id);
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- BACKFILL: profiles.preferences.standingPreferences -> insights rows.
--
-- Migration-embedded, not a script: this is a pure jsonb-to-relational copy
-- (no LLM, no embedding call), so it is idempotent and zero-spend — exactly
-- the case where a script would just add a second thing to remember to run.
-- Embeddings stay NULL until scripts/backfill-embeddings.ts-style pass embeds
-- them (out of scope for this migration; searchInsights degrades to
-- recency-only for NULL-embedding rows regardless).
--
-- IDEMPOTENT via uniq_insights_user_kind_statement_active (created above),
-- not a NOT EXISTS guard: NOT EXISTS only sees rows committed before the
-- statement started, so two entries in the SAME user's standingPreferences
-- array that normalize to the same dedupeKey (legacy data predating the
-- app-level dedupe, or a manual profile edit) would both insert as separate
-- active rows in one run — a NOT EXISTS subquery can't see siblings being
-- inserted by its own statement. ON CONFLICT DO NOTHING can: Postgres checks
-- the unique index against rows already inserted earlier in the SAME
-- statement too, so the second sibling is skipped, not just the second run.
-- This also makes re-running the migration after insights already holds a
-- migrated (or since-then re-ingested) row for the same user+statement
-- insert nothing, same guarantee the old NOT EXISTS gave for the cross-run
-- case.
--
-- profiles.preferences.standingPreferences is READ, not cleared — the design
-- doc's stage-2 says that key's final deletion is a later step, once every
-- reader has moved off it.
-- ---------------------------------------------------------------------------
insert into public.insights (user_id, kind, statement, source, created_at, updated_at)
select
    p.id,
    'preference',
    trim(pref ->> 'text'),
    'user_stated',
    coalesce((pref ->> 'recordedAt')::timestamptz, now()),
    coalesce((pref ->> 'recordedAt')::timestamptz, now())
from public.profiles p
cross join lateral jsonb_array_elements(coalesce(p.preferences -> 'standingPreferences', '[]'::jsonb)) as pref
where trim(coalesce(pref ->> 'text', '')) <> ''
on conflict (user_id, kind, (btrim(regexp_replace(lower(statement), '[^a-z0-9]+', ' ', 'g'))))
    where status = 'active'
do nothing;

-- ---------------------------------------------------------------------------
-- search_insights — cosine + recency retrieval for lib/insights/store.ts#
-- searchInsights. A single candidate list, not RRF: unlike search_kb_chunks
-- (FTS ranks + vector ranks are two genuinely different signals worth fusing),
-- there is no FTS half here, so blending would just be "cosine distance, with
-- a recency tiebreak for rows that tie or lack a signal" — which is exactly
-- what ORDER BY expresses directly. p_vec NULL (no embedding available for
-- the query — see lib/kb/retrieve.ts's identical degrade precedent) makes the
-- CASE below NULL for every row, so ordering falls through to updated_at desc
-- alone: pure recency, same "NULL query-vector degrades" contract
-- search_kb_chunks documents for its own p_vec.
--
-- SECURITY INVOKER + the `user_id = p_user_id` predicate: same justification
-- as search_kb_chunks (20260816000007_hybrid_search.sql) — safe under both
-- the service-role admin client and a cookie-scoped RLS client, because RLS
-- would independently enforce the same scoping for the latter.
create or replace function public.search_insights(
    p_user_id uuid,
    p_vec     extensions.vector(1536) default null,
    p_kinds   text[] default null,
    p_limit   integer default 12
)
returns table (
    id            uuid,
    kind          text,
    statement     text,
    evidence      jsonb,
    confidence    real,
    status        text,
    source        text,
    company_id    uuid,
    supersedes_id uuid,
    created_at    timestamptz,
    updated_at    timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    i.id, i.kind, i.statement, i.evidence, i.confidence, i.status, i.source,
    i.company_id, i.supersedes_id, i.created_at, i.updated_at
  from public.insights i
  where i.user_id = p_user_id
    and i.status = 'active'
    and (p_kinds is null or i.kind = any(p_kinds))
  order by
    (case when p_vec is not null and i.embedding is not null then i.embedding <=> p_vec end) asc nulls last,
    i.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 12), 100));
$$;

comment on function public.search_insights(uuid, extensions.vector, text[], integer) is
  'Cosine-ranked (with recency tiebreak/fallback) search over active insights. p_vec NULL degrades to pure recency ordering. p_kinds NULL matches every kind. Limit clamped 1..100.';

grant execute on function public.search_insights(uuid, extensions.vector, text[], integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- upsert_insight — the atomic half of ingestInsight's dedupe (see
-- uniq_insights_user_kind_statement_active above for why this has to be one
-- DB statement, not an app-level SELECT-then-INSERT). This can't ship as a
-- plain PostgREST `.upsert({ onConflict })` call: that generates an ON
-- CONFLICT with no WHERE clause, which cannot target a partial index — the
-- exact limitation lib/kb/store.ts#upsertDocument's header already documents
-- for kb_documents. Writing the ON CONFLICT ... WHERE by hand inside a real
-- SQL statement has no such limitation, so it ships as an RPC instead, the
-- same way search_insights already is.
--
-- `inserted` (via the standard xmax=0 trick) tells lib/insights/store.ts#
-- ingestInsight whether this call produced a fresh row (run the supersedes/
-- embed side-effects) or refreshed an existing active dup in place (bump
-- only — see that function's dedupe-vs-contradiction split).
-- ---------------------------------------------------------------------------
create or replace function public.upsert_insight(
    p_user_id    uuid,
    p_kind       text,
    p_statement  text,
    p_evidence   jsonb,
    p_confidence real,
    p_source     text,
    p_company_id uuid
)
returns table (
    id            uuid,
    kind          text,
    statement     text,
    evidence      jsonb,
    confidence    real,
    status        text,
    source        text,
    company_id    uuid,
    supersedes_id uuid,
    created_at    timestamptz,
    updated_at    timestamptz,
    inserted      boolean
)
language sql
security invoker
set search_path = public, extensions, pg_catalog
as $$
  insert into public.insights (user_id, kind, statement, evidence, confidence, source, company_id)
  values (p_user_id, p_kind, p_statement, p_evidence, p_confidence, p_source, p_company_id)
  on conflict (user_id, kind, (btrim(regexp_replace(lower(statement), '[^a-z0-9]+', ' ', 'g'))))
      where status = 'active'
  do update set updated_at = now()
  returning
    id, kind, statement, evidence, confidence, status, source, company_id, supersedes_id,
    created_at, updated_at, (xmax = 0) as inserted;
$$;

comment on function public.upsert_insight(uuid, text, text, jsonb, real, text, uuid) is
  'Atomic insert-or-refresh backing ingestInsight''s dedupe, via uniq_insights_user_kind_statement_active. inserted=false means an existing active row with the same normalized statement was refreshed instead of a new one being created.';

grant execute on function public.upsert_insight(uuid, text, text, jsonb, real, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_class
        where oid = 'public.insights'::regclass and relrowsecurity
    ) then
        raise exception 'row level security is not enabled on public.insights';
    end if;

    if (
        select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'insights'
    ) < 4 then
        raise exception 'public.insights is missing one or more of its 4 RLS policies';
    end if;

    if to_regprocedure('public.search_insights(uuid, extensions.vector, text[], integer)') is null then
        raise exception 'public.search_insights was not created';
    end if;

    if to_regprocedure('public.upsert_insight(uuid, text, text, jsonb, real, text, uuid)') is null then
        raise exception 'public.upsert_insight was not created';
    end if;

    if not exists (
        select 1 from pg_indexes
        where schemaname = 'public' and tablename = 'insights'
          and indexname = 'uniq_insights_user_kind_statement_active'
    ) then
        raise exception 'uniq_insights_user_kind_statement_active was not created';
    end if;
end
$$;

notify pgrst, 'reload schema';
