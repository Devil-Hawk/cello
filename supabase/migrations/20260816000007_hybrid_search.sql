-- Hybrid retrieval: fuses the existing FTS ranking with the pgvector cosine
-- ranking (extensions.vector(1536), enabled by 20260816000001_pgvector_enable
-- .sql) via Reciprocal Rank Fusion, per the EMBEDDING SEAM comment on
-- kb_chunks in 20260724000002_phaseB.sql.
--
-- WHY RRF INSTEAD OF A WEIGHTED-SCORE BLEND
--   ts_rank_cd and cosine distance live on incomparable scales (ts_rank_cd is
--   an unbounded, corpus-dependent weight; cosine similarity is 0..1), so a
--   linear blend like the phaseB comment's `0.5 * rank + 0.5 * (1 - dist)`
--   would let whichever signal happens to have the larger numeric range
--   dominate. RRF sidesteps that by fusing RANK POSITION, not raw score:
--     score(doc) = sum over lists containing doc of  1 / (k + rank_in_list)
--   with the standard IR constant k = 60. A document ranked 1st in one list
--   and unranked in the other still beats one ranked 15th in both — being
--   genuinely best-in-class at ONE signal outweighs being mediocre at both
--   (see the k-value and behavior verified in lib/kb/store.test.ts).
--
-- WHY TWO top-50 CANDIDATE LISTS, NOT A JOIN OVER EVERYTHING
--   RRF only needs each doc's RANK within a list, not its score, so each list
--   is computed independently (LIMIT 50, same ts_rank_cd ordering FTS already
--   used) and combined with a FULL OUTER-style union — a doc present in only
--   one list still gets a score from that list alone. 50 keeps both scans
--   cheap (GIN for FTS, the partial HNSW index for vector) regardless of
--   corpus size.
--
-- p_vec NULL (no embedding available for this query — see lib/kb/retrieve.ts
-- degrading to FTS-only on MissingKeyError/BudgetCapError/timeout) means the
-- vector candidate list is empty, so `fused` degenerates to exactly the FTS
-- list's rank order — same rows, same order as today's pure-FTS
-- search_kb_chunks. Only the `rank` OUTPUT column's numeric value changes
-- (RRF score instead of a raw ts_rank_cd weight) — KbSearchHit.rank was
-- already documented as "only comparable within one query", never a value
-- contract, so this is not a breaking change for any caller.
--
-- KNOWN EDGE CASE: because each candidate list is capped at 50, a p_vec-NULL
-- call requesting p_limit > 50 can return fewer rows than plain FTS would
-- have for a query with >50 total matches (the 51st..Nth FTS matches never
-- entered the candidate list at all). No caller in this codebase requests
-- more than 20 (lib/harness/copilot-tools.ts clamps 8..20; the /api/kb/search
-- route defaults to 12) — flagged here rather than silently accepted.
--
-- ponytail: p_company_id is accepted for forward call-shape compatibility
-- (lib/kb/store.ts already threads opts.companyId through) but does NOT
-- filter anything yet — kb_documents.company_id does not exist in this
-- repo's migration history (only the langgraph-port company-identity step
-- will add it), and a LANGUAGE SQL function body is parsed against the live
-- catalog at CREATE FUNCTION time, so referencing that column here would
-- break `supabase db reset` today, not just at some future call. When that
-- column lands, add `and (p_company_id is null or d.company_id =
-- p_company_id)` back into both the fts and vec CTEs below (git blame this
-- migration for the exact clause) and rejoin kb_documents in each CTE.
--
-- WHY A drop FIRST, NOT A BARE create or replace
--   `create or replace function` only replaces a function with the IDENTICAL
--   parameter type list — adding p_vec/p_company_id gives this a different
--   signature (5 args vs. the old 3), so a bare create-or-replace would leave
--   BOTH overloads installed. A caller invoking search_kb_chunks with named
--   args {p_user_id, p_query, p_limit} (searchKb()'s pre-hybrid call shape)
--   would then hit "function search_kb_chunks(...) is not unique" — Postgres
--   can't tell whether to use the old 3-arg function or the new 5-arg one
--   with its last two params defaulted. Dropping the old overload first
--   guarantees exactly one search_kb_chunks exists after this migration.
--   `drop function if exists` is idempotent — a second run finds nothing to
--   drop and create-or-replace still succeeds.
drop function if exists public.search_kb_chunks(uuid, text, integer);

-- SECURITY INVOKER + the `k.user_id = p_user_id` predicate are copied
-- VERBATIM from the definition this replaces (20260724000002_phaseB.sql) —
-- see that migration's comment for why both callers (service-role admin
-- client, cookie-scoped RLS client) are safe under SECURITY INVOKER. The
-- predicate now also appears in the vector candidate list, for the same
-- reason: it is the only thing scoping a service-role call to one user.
create or replace function public.search_kb_chunks(
  p_user_id    uuid,
  p_query      text,
  p_limit      integer default 12,
  p_vec        extensions.vector(1536) default null,
  p_company_id uuid default null
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
set search_path = public, extensions, pg_catalog
as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  ),
  fts as (
    select
      k.id,
      row_number() over (
        order by ts_rank_cd(k.tsv, q.tsq) desc, k.document_id, k.ord
      ) as rnk
    from public.kb_chunks k
    cross join q
    where k.user_id = p_user_id
      and k.tsv @@ q.tsq
    order by ts_rank_cd(k.tsv, q.tsq) desc, k.document_id, k.ord
    limit 50
  ),
  vec as (
    select
      k.id,
      row_number() over (
        order by k.embedding <=> p_vec, k.document_id, k.ord
      ) as rnk
    from public.kb_chunks k
    where p_vec is not null
      and k.user_id = p_user_id
      and k.embedding is not null
    order by k.embedding <=> p_vec, k.document_id, k.ord
    limit 50
  ),
  -- Reciprocal Rank Fusion, k = 60 (the standard IR constant): a doc's score
  -- is the sum, over every candidate list it appears in, of 1/(60+rank).
  -- Missing from a list contributes nothing (not zero-ranked) — that's what
  -- lets a doc absent from one signal still win on the strength of the other.
  fused as (
    select id, sum(1.0 / (60 + rnk)) as score
    from (
      select id, rnk from fts
      union all
      select id, rnk from vec
    ) candidates
    group by id
  )
  select
    k.id,
    k.document_id,
    d.source_id,
    k.ord,
    k.content,
    d.title,
    d.url,
    f.score::real as rank
  from fused f
  join public.kb_chunks k on k.id = f.id
  join public.kb_documents d on d.id = k.document_id
  order by f.score desc, k.document_id, k.ord
  limit greatest(1, least(coalesce(p_limit, 12), 100));
$$;

comment on function public.search_kb_chunks(uuid, text, integer, extensions.vector, uuid) is
  'Hybrid FTS+vector search over kb_chunks via Reciprocal Rank Fusion (k=60) of two top-50 ranked lists. p_vec NULL degrades to the FTS list alone (same rows/order as pure FTS). p_company_id is accepted but not yet filtered on — kb_documents.company_id does not exist yet (see ponytail comment above). Limit clamped 1..100.';

grant execute on function public.search_kb_chunks(uuid, text, integer, extensions.vector, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
