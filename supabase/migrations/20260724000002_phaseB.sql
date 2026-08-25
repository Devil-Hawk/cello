-- Phase B foundation: versioned resume documents + a full-text knowledge base.
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   Every statement is `create ... if not exists` / `add column if not exists`,
--   and policies are guarded by a do-block that checks pg_policies first (there
--   is no `create policy if not exists` in Postgres 15). Nothing here drops,
--   renames, or rewrites an existing object. The only change to a pre-existing
--   table is ONE new nullable column on application_drafts with no default, so
--   applying this does not rewrite the table and every existing read path keeps
--   working untouched. Safe to re-run.
--
-- WHAT IT ADDS
--   1. resume_documents  — immutable, numbered versions of a resume. `job_id IS
--      NULL` means "the base resume" (the master document); a non-null job_id
--      means "a resume tailored for that job". Versions count up per
--      (user_id, job_id) bucket.
--   2. kb_sources / kb_documents / kb_chunks — a per-user knowledge base. A
--      source is a connector config (resume, LinkedIn export, Apify actor, a
--      pasted blob, a URL, Gmail, a dossier), a document is one retrieved item,
--      and a chunk is a retrieval-sized slice of that document with a generated
--      tsvector for Postgres full-text search.
--   3. application_drafts.resume_document_id — lets a draft point at the FULL
--      tailored resume instead of only carrying the 2-4 sentence
--      `resume_summary` blurb.
--
-- SEARCH STRATEGY: Postgres full-text search ONLY. pgvector is available in this
--   project (`vector` 0.8.2 shows as available) but is deliberately NOT installed
--   — enabling it would force an embedding provider, a dimension, and an index
--   type that cannot be changed additively later. kb_chunks is shaped so an
--   `embedding vector(N)` column can be bolted on in a later migration without
--   touching any of the columns below; see the seam comment on kb_chunks.


-- ============================================================================
-- 1. resume_documents
-- ============================================================================

create table if not exists public.resume_documents (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,

    -- NULL = the base resume (the user's master document, not job-specific).
    -- Non-null = a resume tailored for that specific job.
    job_id uuid references public.jobs(id) on delete cascade,

    -- Optional back-pointer to the application draft this version was produced
    -- for. ON DELETE SET NULL so deleting a draft never destroys the resume.
    draft_id uuid references public.application_drafts(id) on delete set null,

    -- 1-based, monotonic within a (user_id, job_id) bucket. Assigned by
    -- lib/resume/store.ts createVersion() as max(version) + 1.
    version integer not null,

    title text,

    -- The rendered plain-text resume. Always populated; this is what gets sent
    -- to an ATS as the resume attachment.
    content text not null,

    -- Optional structured form: [{heading, bullets[]}] or similar. NULL means
    -- "plain text only" — every read path must tolerate NULL.
    content_json jsonb,

    -- 0-100 ATS score for THIS version, from lib/harness/agents/resume_optimizer.
    -- NULL = not scored yet.
    ats_score integer,

    -- Provenance: base | tailored | edited. No CHECK constraint on purpose —
    -- the vocabulary lives in TS (lib/resume/types.ts ResumeSource) so adding a
    -- value later stays a code-only change, matching application_drafts.status.
    source text,

    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,

    -- Job-specific versions are unique per (user, job, version). NOTE: Postgres
    -- treats NULLs as DISTINCT in unique constraints, so this constraint does
    -- NOT constrain base-resume rows at all (job_id IS NULL) — the partial
    -- unique index below covers that case.
    constraint unique_resume_version_per_job unique (user_id, job_id, version)
);

-- Base-resume versions (job_id IS NULL) must also be unique per user. Required
-- because the constraint above is a no-op when job_id is NULL.
create unique index if not exists uniq_resume_base_version
  on public.resume_documents (user_id, version)
  where job_id is null;

-- Primary read pattern: "latest version for this (user, job)" and
-- "all versions newest-first". job_id is nullable so this index also serves the
-- base-resume lookup.
create index if not exists idx_resume_documents_user_job_version
  on public.resume_documents (user_id, job_id, version desc);

comment on table  public.resume_documents               is 'Versioned resume documents. job_id IS NULL = the base/master resume; non-null = tailored for that job.';
comment on column public.resume_documents.job_id       is 'NULL means this is the base resume. Non-null means tailored for that job.';
comment on column public.resume_documents.version      is '1-based, monotonic within a (user_id, job_id) bucket. Assigned by lib/resume/store.ts.';
comment on column public.resume_documents.content_json is 'Optional structured sections. NULL = plain text only; read paths must tolerate NULL.';
comment on column public.resume_documents.ats_score    is '0-100 ATS score for this version. NULL = not scored.';
comment on column public.resume_documents.source       is 'base | tailored | edited. Vocabulary enforced in TS, not by a CHECK.';

alter table public.resume_documents enable row level security;


-- ============================================================================
-- 2. Knowledge base: kb_sources -> kb_documents -> kb_chunks
-- ============================================================================

create table if not exists public.kb_sources (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,

    -- resume | linkedin_export | apify | paste | url | gmail | dossier.
    -- No CHECK: the vocabulary lives in lib/kb/types.ts (KbSourceKind) so new
    -- connectors ship without a migration.
    kind text not null,

    label text,

    -- Connector config: {actorId, input, ...} for apify, {url} for url, etc.
    -- BYOK API keys must NOT be stored here — they live encrypted in
    -- profiles.preferences.api_keys.
    config jsonb,

    enabled boolean default true not null,
    last_synced_at timestamptz,
    last_error text,
    created_at timestamptz default now() not null
);

create index if not exists idx_kb_sources_user
  on public.kb_sources (user_id, created_at desc);

comment on table  public.kb_sources        is 'Per-user knowledge-base connectors. One row = one configured ingest source.';
comment on column public.kb_sources.kind   is 'resume|linkedin_export|apify|paste|url|gmail|dossier. Vocabulary enforced in TS, not by a CHECK.';
comment on column public.kb_sources.config is 'Connector config JSON. NEVER store API keys here — those live encrypted in profiles.preferences.api_keys.';

alter table public.kb_sources enable row level security;


create table if not exists public.kb_documents (
    id uuid default uuid_generate_v4() primary key,

    -- Denormalized owner. Present so RLS and every list/search query can filter
    -- on one column without joining kb_sources.
    user_id uuid references public.profiles(id) on delete cascade not null,

    source_id uuid references public.kb_sources(id) on delete cascade not null,

    -- Stable id from the upstream source (Apify item id, message id, URL, ...).
    -- NULL for one-off pastes that have no upstream identity.
    external_id text,

    title text,
    url text,
    content text not null,
    metadata jsonb,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- Re-sync idempotency: one row per (source, external_id). Partial so the many
-- external_id IS NULL rows (pastes) never collide with each other.
create unique index if not exists uniq_kb_documents_source_external
  on public.kb_documents (source_id, external_id)
  where external_id is not null;

create index if not exists idx_kb_documents_user
  on public.kb_documents (user_id, created_at desc);

create index if not exists idx_kb_documents_source
  on public.kb_documents (source_id);

comment on table  public.kb_documents             is 'One retrieved item from a kb_source. Chunked into kb_chunks for retrieval.';
comment on column public.kb_documents.user_id     is 'Denormalized from kb_sources.user_id so RLS and search need no join.';
comment on column public.kb_documents.external_id is 'Upstream stable id for re-sync dedupe. NULL for pastes (excluded from the unique index).';

alter table public.kb_documents enable row level security;


create table if not exists public.kb_chunks (
    id uuid default uuid_generate_v4() primary key,

    -- Denormalized owner, same rationale as kb_documents.user_id: searchKb()
    -- filters on this before ranking.
    user_id uuid references public.profiles(id) on delete cascade not null,

    document_id uuid references public.kb_documents(id) on delete cascade not null,

    -- 0-based position within the parent document.
    ord integer not null,

    content text not null,

    -- Generated, STORED tsvector. to_tsvector(regconfig, text) is IMMUTABLE
    -- (unlike the 1-arg form), which is what makes it legal in a generated
    -- column. The 'english' config is baked in and cannot be changed without a
    -- column rewrite — lib/kb/store.ts uses websearch_to_tsquery('english', ...)
    -- to match.
    tsv tsvector generated always as (to_tsvector('english', content)) stored,

    created_at timestamptz default now() not null

    -- ==== EMBEDDING SEAM ====================================================
    -- Semantic search is intentionally NOT enabled. To add it later, in a NEW
    -- additive migration:
    --     create extension if not exists vector with schema extensions;
    --     alter table public.kb_chunks add column if not exists embedding extensions.vector(1536);
    --     create index if not exists idx_kb_chunks_embedding
    --       on public.kb_chunks using hnsw (embedding vector_cosine_ops);
    -- Nothing above needs to change: `content` is already the exact text that
    -- would be embedded, `ord` keeps chunk order stable, and searchKb() can then
    -- blend the FTS rank with a cosine distance (hybrid) instead of replacing it.
    -- ========================================================================
);

-- Full-text search index. GIN on the generated tsvector is what makes
-- websearch_to_tsquery + ts_rank_cd fast.
create index if not exists idx_kb_chunks_tsv
  on public.kb_chunks using gin (tsv);

create index if not exists idx_kb_chunks_document_ord
  on public.kb_chunks (document_id, ord);

create index if not exists idx_kb_chunks_user
  on public.kb_chunks (user_id);

comment on table  public.kb_chunks     is 'Retrieval-sized slices of a kb_document with a generated english tsvector for FTS.';
comment on column public.kb_chunks.ord is '0-based position within the parent document.';
comment on column public.kb_chunks.tsv is 'GENERATED ALWAYS AS to_tsvector(''english'', content) STORED. Never write this column directly.';

alter table public.kb_chunks enable row level security;


-- ============================================================================
-- 3. application_drafts -> full tailored resume
-- ============================================================================
-- Deliberately does NOT touch unique_draft_per_job (user_id, job_id): the
-- approve/apply paths upsert on that conflict target. Instead a draft can now
-- reference the full tailored resume document, so ATS submits stop shipping the
-- 2-4 sentence resume_summary blurb as the resume attachment.

alter table public.application_drafts
  add column if not exists resume_document_id uuid references public.resume_documents(id) on delete set null;

comment on column public.application_drafts.resume_document_id is 'Optional pointer at the FULL tailored resume in resume_documents. NULL = fall back to profiles.resume_text.';

create index if not exists idx_app_drafts_resume_document
  on public.application_drafts (resume_document_id)
  where resume_document_id is not null;


-- ============================================================================
-- 4. RLS policies — full per-user CRUD, mirroring the application_drafts set
-- ============================================================================
-- Postgres has no `create policy if not exists`, so each policy is created only
-- when absent. This keeps the whole migration re-runnable.

do $$
declare
  t text;
begin
  foreach t in array array['resume_documents', 'kb_sources', 'kb_documents', 'kb_chunks']
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s select', t)
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
        format('own %s select', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s insert', t)
    ) then
      execute format(
        'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
        format('own %s insert', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s update', t)
    ) then
      execute format(
        'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
        format('own %s update', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s delete', t)
    ) then
      execute format(
        'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
        format('own %s delete', t), t
      );
    end if;
  end loop;
end
$$;


-- ============================================================================
-- 5. search_kb_chunks() — ranked full-text search over the knowledge base
-- ============================================================================
-- WHY A FUNCTION: PostgREST can express the `tsv @@ websearch_to_tsquery(...)`
-- filter (via .textSearch) but CANNOT order by `ts_rank_cd(...)`, because
-- relevance is a computed expression rather than a column. Ranking is the whole
-- point of retrieval, so lib/kb/store.ts searchKb() calls this via .rpc().
--
-- SECURITY INVOKER on purpose:
--   * called with the service-role admin client -> RLS is bypassed, and the
--     explicit `k.user_id = p_user_id` predicate is what scopes the result;
--   * called with a cookie-scoped RLS client -> the kb_chunks/kb_documents
--     policies apply on top, so a caller can never pass someone else's uuid.
-- Both callers are therefore safe. `create or replace` keeps this re-runnable.
--
-- EMBEDDING SEAM: to go hybrid later, add the embedding column (see the
-- kb_chunks comment) and replace the ORDER BY with a blended score, e.g.
--   order by (0.5 * ts_rank_cd(k.tsv, q.tsq) + 0.5 * (1 - (k.embedding <=> p_vec))) desc
-- The signature can stay the same by giving p_vec a default of NULL.

create or replace function public.search_kb_chunks(
  p_user_id uuid,
  p_query   text,
  p_limit   integer default 12
)
returns table (
  chunk_id    uuid,
  document_id uuid,
  source_id   uuid,
  ord         integer,
  content     text,
  title       text,
  url         text,
  rank        real
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  )
  select
    k.id,
    k.document_id,
    d.source_id,
    k.ord,
    k.content,
    d.title,
    d.url,
    ts_rank_cd(k.tsv, q.tsq) as rank
  from public.kb_chunks k
  join public.kb_documents d on d.id = k.document_id
  cross join q
  where k.user_id = p_user_id
    and k.tsv @@ q.tsq
  -- Ordering by the expression (not the output alias `rank`) so the SQL-language
  -- OUT parameter name can never shadow it.
  order by ts_rank_cd(k.tsv, q.tsq) desc, k.document_id, k.ord
  limit greatest(1, least(coalesce(p_limit, 12), 100));
$$;

comment on function public.search_kb_chunks(uuid, text, integer) is 'Ranked FTS over kb_chunks joined to kb_documents for citations. Ordered by ts_rank_cd desc, limit clamped 1..100.';

grant execute on function public.search_kb_chunks(uuid, text, integer) to authenticated, service_role;

-- Make the new table + function visible to PostgREST without waiting for its
-- periodic cache refresh.
notify pgrst, 'reload schema';
