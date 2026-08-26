-- kb_documents entity refs — lets a knowledge-base document point back at the
-- domain row it was actually about, so a caller can ask "what do we already
-- have on file for company X" without parsing external_id strings.
--
-- lib/kb/ingest.ts (the named door for KB writes — Binding ruling 3) is the
-- first caller: it stamps company_id on both the company's own home/about/
-- careers pages and the synthesized dossier summary it persists, and
-- lib/contacts/sources.ts reads company_id back to decide whether a fresh
-- company-page fetch is even necessary (see that file's module header).
--
-- contact_id / job_id are added alongside for the SAME shape of future writer
-- (a contact's own note, a job posting's stored text) rather than adding a
-- migration per entity kind later — no code sets them yet, so they cost
-- nothing beyond three nullable columns and their partial indexes.
--
-- WHY THIS SORTS BEFORE 20260816000007_hybrid_search.sql: that migration's
-- search_kb_chunks accepts p_company_id but, by its own ponytail comment,
-- deliberately does NOT filter on it yet because this column did not exist at
-- the time it was written. This migration is what makes that column real;
-- wiring the filter back into search_kb_chunks is follow-up work for whoever
-- picks up that ponytail note, not part of this migration.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists`, `create index if not
-- exists`. Nothing here drops, renames or rewrites an existing row. NOTHING IN
-- THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE — reviewed and
-- committed as source; a human operator runs it.

alter table public.kb_documents
  add column if not exists company_id uuid references public.companies(id) on delete cascade,
  add column if not exists contact_id uuid references public.contacts(id) on delete cascade,
  add column if not exists job_id uuid references public.jobs(id) on delete cascade;

comment on column public.kb_documents.company_id is 'Set when this document is about one company (a home/about/careers page, a dossier summary — see lib/kb/ingest.ts). Null for connector-sourced documents (resume, paste, apify, ...) that are not about any one entity.';
comment on column public.kb_documents.contact_id is 'Set when this document is about one contact. No writer sets this yet.';
comment on column public.kb_documents.job_id is 'Set when this document is about one job posting. No writer sets this yet.';

create index if not exists idx_kb_documents_company_id
  on public.kb_documents (company_id) where company_id is not null;

create index if not exists idx_kb_documents_contact_id
  on public.kb_documents (contact_id) where contact_id is not null;

create index if not exists idx_kb_documents_job_id
  on public.kb_documents (job_id) where job_id is not null;

notify pgrst, 'reload schema';
