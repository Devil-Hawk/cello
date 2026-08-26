-- Company identity resolution — the audit's single weakest link.
--
-- Two employers are the same company only when something STRONG says so: the
-- same real domain, or a human confirming a fuzzy name match. Nothing here
-- ever rewrites a job/contact/dossier row's company_id — a "merge" is pure
-- INDIRECTION (companies.canonical_id points the loser at the survivor) so
-- every foreign key written before the merge keeps resolving correctly
-- through lib/entities/companies.ts's chokepoint, and an unmerge is just
-- clearing canonical_id back to null. See that file for the accessor
-- contract this schema exists to serve.
--
-- WHY ONE HOP, NEVER A CHAIN
--   mergeCompanies always collapses: absorbing company B into survivor A also
--   repoints anything that already pointed at B onto A directly, so
--   canonical_id is never more than one hop from a row with canonical_id =
--   null. resolveCompanyId (the chokepoint) relies on this and does exactly
--   one lookup — see its own comment for why that's safe.
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   `add column if not exists`, `create table if not exists`, `create index
--   if not exists`, and the phaseB do-block pattern for policies (no `create
--   policy if not exists` in Postgres 15). Nothing here drops, renames or
--   rewrites an existing row. pg_trgm is already enabled by
--   20260816000001_pgvector_enable.sql.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

alter table public.companies
  add column if not exists name_key text,
  add column if not exists canonical_id uuid references public.companies(id) on delete set null;

comment on column public.companies.name_key is 'normalizeCompanyName(name) (lib/sources/index.ts), stamped at insert/backfill. Used for exact + trgm-fuzzy dedupe matching, never for display.';
comment on column public.companies.canonical_id is 'NULL = this row is a survivor (or unmerged). Set by mergeCompanies() = this row is a duplicate; readers resolve through it via lib/entities/companies.ts#resolveCompanyId. One hop only — mergeCompanies collapses chains, never lets one form.';

-- Exact name_key lookups (resolveCompany's first match path).
create index if not exists idx_companies_name_key
  on public.companies (name_key);

-- Fuzzy name_key lookups (scanMergeCandidates' trgm similarity pass).
create index if not exists idx_companies_name_key_trgm
  on public.companies using gin (name_key gin_trgm_ops);

-- A duplicate's canonical_id is looked up by resolveCompanyId on every read
-- through the chokepoint.
create index if not exists idx_companies_canonical_id
  on public.companies (canonical_id) where canonical_id is not null;

-- One company is one company, enforced, not just detected. resolveCompany's
-- create-if-absent path (ingestLeads step 2) is check-then-insert: without a
-- DB-level constraint, two concurrent ingests for the same user each see "no
-- match" and each insert a row, producing two live companies for one real
-- employer — exactly the defect this migration exists to close. Plain (not
-- partial) unique indexes: Postgres already excludes NULLs from uniqueness,
-- so pre-backfill companies with no name_key/domain yet are unaffected, and
-- `onConflict: 'user_id,name_key'` in lib/entities/companies.ts's upsert can
-- target this index directly (a partial index's WHERE predicate isn't
-- something a PostgREST upsert can express).
-- Live-data backfill: absorb pre-existing exact duplicates so the unique
-- indexes below can build on an install that already has data. The oldest row
-- per (user_id, domain) survives; each loser gets canonical_id -> survivor and
-- its identity keys cleared (every read chases canonical_id via
-- lib/entities/companies.ts, so nothing is lost). Idempotent: reruns match
-- nothing once losers carry canonical_id. Same pass for name_key, which is a
-- no-op until the owner-run backfill script populates name_key.
with dupes as (
  select id,
         first_value(id) over (partition by user_id, domain order by created_at, id) as survivor
    from public.companies
   where domain is not null and canonical_id is null
)
update public.companies c
   set canonical_id = dupes.survivor, domain = null, name_key = null
  from dupes
 where c.id = dupes.id and dupes.id <> dupes.survivor;

with dupes as (
  select id,
         first_value(id) over (partition by user_id, name_key order by created_at, id) as survivor
    from public.companies
   where name_key is not null and canonical_id is null
)
update public.companies c
   set canonical_id = dupes.survivor, domain = null, name_key = null
  from dupes
 where c.id = dupes.id and dupes.id <> dupes.survivor;

create unique index if not exists idx_companies_user_name_key_unique
  on public.companies (user_id, name_key);

create unique index if not exists idx_companies_user_domain_unique
  on public.companies (user_id, domain);


-- ============================================================================
-- company_merge_candidates — pending human review + audit trail for merges
-- ============================================================================
-- One row per (company_a, company_b) pair ever surfaced by scanMergeCandidates
-- or created directly by mergeCompanies. 'pending' rows are proposals nobody
-- has acted on; 'merged'/'rejected' are the audit trail of what a human (or,
-- for a same-domain pair, the strong-signal auto-merge) decided.
create table if not exists public.company_merge_candidates (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    company_a uuid not null references public.companies(id) on delete cascade,
    company_b uuid not null references public.companies(id) on delete cascade,
    score real not null,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'merged', 'rejected')),
    created_at timestamptz not null default now()
);

create index if not exists idx_merge_candidates_user
  on public.company_merge_candidates (user_id, status, created_at desc);

-- Same race as companies(user_id, name_key) above, one layer up: two
-- overlapping scanMergeCandidates runs for the same user (ingestLeads calls
-- it after every company-creation batch) can both pass a "no existing row"
-- check before either write commits. Without this, that produces two audit
-- rows for one pair AND leaves a future mergeCompanies call for that same
-- pair unable to find a single row via .maybeSingle(). mergeCompanies now
-- writes through this index (upsert ignoreDuplicates + unconditional
-- update), which is race-safe only because the index makes the conflict
-- real instead of silent.
create unique index if not exists idx_merge_candidates_pair_unique
  on public.company_merge_candidates (user_id, company_a, company_b);

comment on table  public.company_merge_candidates        is 'Pending review + audit trail for company merges. Never auto-applied on a fuzzy (trgm) match — only a same-domain pair auto-merges, and even that writes a row here (status merged) for the trail. See lib/entities/companies.ts.';
comment on column public.company_merge_candidates.score  is 'trgm similarity() on name_key (0..1), or 1 for a domain-identity auto-merge.';
comment on column public.company_merge_candidates.status is 'pending = awaiting human confirmation. merged = applied (by mergeCompanies, human-confirmed or domain auto-merge). rejected = a human said no; scanMergeCandidates must not re-propose a pair already recorded here in any status.';

alter table public.company_merge_candidates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_merge_candidates'
      and policyname = 'own company_merge_candidates select'
  ) then
    create policy "own company_merge_candidates select"
      on public.company_merge_candidates for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_merge_candidates'
      and policyname = 'own company_merge_candidates insert'
  ) then
    create policy "own company_merge_candidates insert"
      on public.company_merge_candidates for insert
      to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_merge_candidates'
      and policyname = 'own company_merge_candidates update'
  ) then
    create policy "own company_merge_candidates update"
      on public.company_merge_candidates for update
      to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_merge_candidates'
      and policyname = 'own company_merge_candidates delete'
  ) then
    create policy "own company_merge_candidates delete"
      on public.company_merge_candidates for delete
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;


-- ============================================================================
-- find_company_merge_candidates() — trgm-similarity pairs, DB-side
-- ============================================================================
-- WHY A FUNCTION: pairwise name_key similarity is a self-join computation
-- (every survivor against every other survivor for the same user), which is
-- exactly the platform's job (pg_trgm's similarity(), GIN-indexed) rather than
-- pulling every company row into app code to score O(n^2) pairs by hand.
-- Restricted to canonical_id is null on both sides: an already-absorbed
-- duplicate has nothing left to be a candidate for.
create or replace function public.find_company_merge_candidates(
  p_user_id   uuid,
  p_threshold real default 0.6
)
returns table (
  company_a uuid,
  company_b uuid,
  score     real
)
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select a.id as company_a, b.id as company_b,
         similarity(a.name_key, b.name_key)::real as score
  from public.companies a
  join public.companies b
    on b.user_id = a.user_id
   and b.id > a.id
   and b.canonical_id is null
   and b.name_key is not null and b.name_key <> ''
  where a.user_id = p_user_id
    and a.canonical_id is null
    and a.name_key is not null and a.name_key <> ''
    and similarity(a.name_key, b.name_key) > p_threshold
  order by score desc;
$$;

comment on function public.find_company_merge_candidates(uuid, real) is 'trgm similarity() pairs of survivor companies (canonical_id is null) for one user, above p_threshold (default 0.6). Never applies a merge itself — lib/entities/companies.ts#scanMergeCandidates inserts the pending rows.';

grant execute on function public.find_company_merge_candidates(uuid, real) to authenticated, service_role;

notify pgrst, 'reload schema';
