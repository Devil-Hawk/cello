-- Opens the EMBEDDING SEAM that 20260724000002_phaseB.sql left on kb_chunks,
-- exactly as that migration's own comment specced it: enable pgvector, add
-- kb_chunks.embedding, index it. Also enables pg_trgm (company name_key
-- fuzzy-merge, per the langgraph port spec's company-identity design) and
-- drops the dead ada-002 column initial_schema.sql declared.
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   `create extension if not exists`, `add column if not exists`, `create
--   index if not exists`, `drop column if exists` — every statement is safe
--   to re-run and none rewrites an existing row in a way any current reader
--   depends on. kb_chunks.embedding is a new NULLable column; every existing
--   FTS-only read path (search_kb_chunks) keeps working untouched — hybrid
--   retrieval is wired in a later migration/PR, not here.
--
-- WHICH SCHEMA HAS resume_embedding AT ALL
--   free_tier_migration.sql — the migration that actually bootstraps
--   production (see docs/superpowers/specs/2026-08-16-langgraph-port-
--   design.md's Step 1 read list) — never declared `vector` or
--   `resume_embedding`. Only initial_schema.sql (20240131000001), which is
--   declared but never applied, has both. So on prod this drop is a genuine
--   no-op (`drop column if exists` on a column that was never there); on any
--   environment that DID bootstrap from initial_schema.sql it removes a
--   1536-slot-shaped-wrong (ada-002, 1536 dims — coincidentally the same
--   width as text-embedding-3-small, but a different model's vectors) column
--   nothing reads, so keeping it around risks exactly the "mix incompatible
--   vectors" failure the embedding chokepoint is designed to prevent.
--   initial_schema.sql and free_tier_migration.sql are both left untouched —
--   per the port spec, neither historical migration file is ever edited.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.
--
-- initial_schema.sql (20240131000001) installs `vector` unqualified, so on
-- any environment that ran it fresh the extension already exists outside
-- `extensions` and `create extension if not exists ... with schema
-- extensions` below would be a silent no-op that leaves every
-- extensions.vector(...) reference in this file (and hybrid_search.sql,
-- insights.sql, resume_claims.sql) pointing at a type that doesn't exist in
-- that schema. Move it there if so; create it fresh otherwise.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    if not exists (
      select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'vector' and n.nspname = 'extensions'
    ) then
      alter extension vector set schema extensions;
    end if;
  else
    create extension vector with schema extensions;
  end if;
end
$$;
create extension if not exists pg_trgm;

alter table public.kb_chunks
  add column if not exists embedding extensions.vector(1536);

-- Partial: only rows that HAVE been embedded belong in the ANN index — an
-- HNSW index over mostly-NULL rows wastes build time and every unembedded
-- chunk still needs to be found some other way (FTS) regardless, per
-- search_kb_chunks' "NULL query-vector degrades to today's pure-FTS
-- behavior" design.
create index if not exists idx_kb_chunks_embedding
  on public.kb_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

comment on column public.kb_chunks.embedding is
  'text-embedding-3-small (1536 dims), written by lib/harness/llm.ts#callEmbedding. NULL = not yet embedded (or the account has no embedding provider configured) — search_kb_chunks degrades to pure FTS for those rows.';

-- No-op on prod (see header). Present only on an initial_schema.sql install.
alter table public.profiles
  drop column if exists resume_embedding;

notify pgrst, 'reload schema';
