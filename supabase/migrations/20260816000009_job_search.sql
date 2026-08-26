-- Job/company search: ILIKE retires. Full-text search over jobs (title +
-- description), trgm typo-tolerance for both a short/misspelled title query
-- and a company-name lookup.
--
-- WHY ILIKE HAD TO GO
--   `ilike('title', '%query%')` (lib/harness/copilot-tools.ts listJobs) and
--   `ilike('name', '%query%')` (listContacts) are both leading-wildcard scans
--   — no index can serve `%foo%`, so every call is a full table scan, and
--   neither ranks a multi-word query ("staff backend engineer") by relevance
--   at all; it is a literal substring test. jobs.tsv + companies.name's trgm
--   index replace both with an actually-indexed, actually-ranked search.
--
-- WHY A GENERATED COLUMN, NOT AN EXPRESSION INDEX
--   `search_kb_chunks` (20260816000007_hybrid_search.sql) built its tsvector
--   at write time in application code because kb_chunks.tsv already existed
--   from an earlier migration. jobs has no tsv column yet, and a `generated
--   always as (...) stored` column is the platform doing the "keep this in
--   sync with title/description" work an app-level trigger or dual-write
--   would otherwise owe (ponytail ladder rung 4: DB feature over app code).
--
-- THE 20000-CHAR BOUND ON description, VERIFIED AGAINST THE REAL CEILING
--   Postgres's tsvector has a hard 1MB-of-lexeme-positions limit per document
--   — irrelevant here regardless, because description is ALREADY capped at
--   ingestion: lib/ats/html.ts, lib/ats/lever.ts and lib/ats/ashby.ts each
--   define MAX_DESCRIPTION_CHARS = 20_000 and every parsed posting is sliced
--   to it before it ever reaches an insert. `left(description, 20000)` here
--   is therefore not a truncation of real data — the stored column is never
--   longer than that already — it is a second, DB-level backstop against a
--   future writer that skips that helper (a raw insert, a backfill script),
--   so a single pathological row can never blow the 1MB tsvector ceiling.
--
-- WHY trgm FOR THE FALLBACK, NOT A SECOND tsvector STRATEGY
--   websearch_to_tsquery tokenizes and stems on word boundaries — it cannot
--   help with a short query ("eng"), a typo ("enginer"), or a query with no
--   English-stopword structure at all, which a %-similarity scan over the
--   raw title handles directly. Both listJobs (title) and listContacts
--   (contacts.name) fall back to trgm for exactly that reason; companies.name
--   gets the same index up front as the third %-searchable identity column
--   this schema already treats this way (see idx_companies_name_key_trgm in
--   20260816000002_company_identity.sql, which is a DIFFERENT column —
--   name_key, the normalized dedupe key — from this one, which is the raw
--   display name a user actually types).
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   `add column if not exists`, `create index if not exists`, `create or
--   replace function`. Nothing here drops, renames or rewrites an existing
--   row. pg_trgm is already enabled by 20260816000001_pgvector_enable.sql.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

alter table public.jobs
  add column if not exists tsv tsvector
    generated always as (
      to_tsvector('english', title || ' ' || left(coalesce(description, ''), 20000))
    ) stored;

comment on column public.jobs.tsv is 'Generated from title + left(description, 20000) — see this migration''s header for why 20000 is a backstop, not a truncation of real data. Searched via websearch_to_tsquery (lib/harness/copilot-tools.ts listJobs).';

create index if not exists idx_jobs_tsv
  on public.jobs using gin (tsv);

-- Typo/short-query fallback for the SAME listJobs call — the raw title, not
-- the generated tsvector, because trgm similarity works on literal substrings
-- a stemmed/tokenized column has already discarded.
create index if not exists idx_jobs_title_trgm
  on public.jobs using gin (title gin_trgm_ops);

-- The raw, user-typed company display name (as opposed to name_key, the
-- normalized identity-resolution key indexed by idx_companies_name_key_trgm)
-- — additive infra for the same %-similarity company-name search pattern
-- established there, for whichever caller looks a company up by what the
-- user actually typed rather than by its normalized dedupe key.
create index if not exists idx_companies_name_trgm
  on public.companies using gin (name gin_trgm_ops);


-- ============================================================================
-- search_jobs_by_title_trgm() — typo/short-query fallback, DB-side
-- ============================================================================
-- WHY A FUNCTION: PostgREST has no operator mapping for pg_trgm's `%`
-- similarity operator and no ORDER BY on a computed expression, so ranking by
-- similarity() has to happen in SQL, not in a chained .filter()/.order() —
-- exactly the reason find_company_merge_candidates
-- (20260816000002_company_identity.sql) is a function and not a query
-- built in application code. p_user_id is an explicit predicate (not RLS)
-- because the caller is the admin/service client, same as every other
-- ownership check in lib/harness/copilot-tools.ts.
create or replace function public.search_jobs_by_title_trgm(
  p_user_id uuid,
  p_query   text,
  p_limit   integer default 15
)
returns table (
  job_id uuid,
  score  real
)
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select j.id as job_id, similarity(j.title, p_query)::real as score
  from public.jobs j
  join public.companies c on c.id = j.company_id
  where c.user_id = p_user_id
    and j.title % p_query
  order by score desc
  limit greatest(1, least(p_limit, 50));
$$;

comment on function public.search_jobs_by_title_trgm(uuid, text, integer) is 'trgm similarity() fallback for listJobs when websearch_to_tsquery is unsuited to the query (short/typo). Never applies a filter itself — lib/harness/copilot-tools.ts#listJobs re-queries jobs by the returned ids so the result carries the same columns/ownership shape as the FTS path.';

grant execute on function public.search_jobs_by_title_trgm(uuid, text, integer) to authenticated, service_role;


-- ============================================================================
-- search_contacts_by_name_trgm() — the SAME retirement for listContacts'
-- former ilike('name', ...), the only other leading-wildcard scan this
-- module (lib/harness/copilot-tools.ts) had left.
-- ============================================================================
create index if not exists idx_contacts_name_trgm
  on public.contacts using gin (name gin_trgm_ops);

create or replace function public.search_contacts_by_name_trgm(
  p_user_id uuid,
  p_query   text,
  p_limit   integer default 25
)
returns table (
  contact_id uuid,
  score      real
)
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select c.id as contact_id, similarity(c.name, p_query)::real as score
  from public.contacts c
  where c.user_id = p_user_id
    and c.name % p_query
  order by score desc
  limit greatest(1, least(p_limit, 50));
$$;

comment on function public.search_contacts_by_name_trgm(uuid, text, integer) is 'trgm similarity() replacement for listContacts'' retired ilike(name, %query%) — see this migration''s header.';

grant execute on function public.search_contacts_by_name_trgm(uuid, text, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
