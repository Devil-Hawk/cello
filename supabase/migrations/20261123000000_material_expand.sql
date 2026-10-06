-- K23: material. "Your material" is what the person gave Cello (a resume, a note, a
-- link they added); the pages Cello fetched itself (company sites, dossiers) are
-- not part of it and never reach the Writer as the person's own words. Search moves
-- to a 384 dimension vector (the server embedder, MiniLM) and to one new function
-- that keeps fetched pages out, and honours the person's "Cello may use this" switch,
-- before the top 50 is cut.
--
-- Expand only: every change adds. The old search_kb_chunks function and the 1536
-- columns stay until the backfill count is 0 on production; then the contract file
-- (20261123000001_material_contract.sql, its own pull request) drops them.

-- The kind is derived from the connector, so it cannot drift. Cello itself writes
-- company_site and dossier sources (lib/kb/ingest.ts); everything else is the
-- person's. A link the person added is theirs (it is refreshed weekly and checked
-- against DNS before every fetch).
alter table public.kb_sources
  add column if not exists material_kind text
  generated always as (case when kind in ('company_site', 'dossier') then 'fetched' else 'person' end) stored;

-- "Cello may use this". `enabled` stays the connector's own sync switch.
alter table public.kb_sources
  add column if not exists may_use boolean not null default true;

comment on column public.kb_sources.material_kind is 'person = the person gave it to Cello; fetched = Cello fetched it (company_site, dossier). Generated from kind. Fetched sources are never returned by search_material.';
comment on column public.kb_sources.may_use is 'False hides the source from search_material: Cello may not use it.';

-- 384 dimension vectors beside the 1536 ones.
alter table public.kb_chunks
  add column if not exists embedding_384 extensions.vector(384);

create index if not exists idx_kb_chunks_embedding_384
  on public.kb_chunks using hnsw (embedding_384 extensions.vector_cosine_ops)
  where embedding_384 is not null;

alter table public.resume_claims
  add column if not exists embedding_384 extensions.vector(384);

comment on column public.kb_chunks.embedding_384 is 'Xenova/all-MiniLM-L6-v2 (384 dims), written by the embed step. NULL = not embedded yet: search_material ranks the row by words only.';
comment on column public.resume_claims.embedding_384 is 'Same 384 dimension embedder. NULL = matchClaim falls back to exact-key matching.';

-- One search function, filtered before the top-50 cut. A new name, not an overload,
-- so PostgREST never has to choose between two signatures.
create or replace function public.search_material(
  p_user_id    uuid,
  p_query      text,
  p_limit      integer default 12,
  p_vec        extensions.vector(384) default null,
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
    join public.kb_documents d on d.id = k.document_id
    join public.kb_sources s on s.id = d.source_id
    cross join q
    where k.user_id = p_user_id
      and s.user_id = p_user_id
      and s.material_kind = 'person'
      and s.may_use
      and (p_company_id is null or d.company_id = p_company_id)
      and k.tsv @@ q.tsq
    order by ts_rank_cd(k.tsv, q.tsq) desc, k.document_id, k.ord
    limit 50
  ),
  vec as (
    select
      k.id,
      row_number() over (
        order by k.embedding_384 <=> p_vec, k.document_id, k.ord
      ) as rnk
    from public.kb_chunks k
    join public.kb_documents d on d.id = k.document_id
    join public.kb_sources s on s.id = d.source_id
    where p_vec is not null
      and k.user_id = p_user_id
      and s.user_id = p_user_id
      and s.material_kind = 'person'
      and s.may_use
      and (p_company_id is null or d.company_id = p_company_id)
      and k.embedding_384 is not null
    order by k.embedding_384 <=> p_vec, k.document_id, k.ord
    limit 50
  ),
  -- Reciprocal Rank Fusion, k = 60, as search_kb_chunks does: rank positions, not
  -- raw scores, so words and vectors fuse without one drowning the other.
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

comment on function public.search_material(uuid, text, integer, extensions.vector, uuid) is
  'Hybrid words + 384 dimension vector search over the person''s own material (material_kind person, may_use true), RRF k=60 over two top-50 lists. p_vec NULL gives words only. p_company_id keeps one company''s documents.';

revoke all on function public.search_material(uuid, text, integer, extensions.vector, uuid) from public, anon;
grant execute on function public.search_material(uuid, text, integer, extensions.vector, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
