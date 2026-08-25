-- Additive job classification columns + indexes for the jobs list.
--
-- Every column is nullable with NO default, so applying this migration does not
-- rewrite the existing ~18k rows (a DEFAULT on a nullable column would still be
-- metadata-only on PG11+, but leaving it out keeps "unclassified" distinguishable
-- from "classified as the default"). NULL means "not yet classified" — every
-- read path must tolerate NULL.
--
-- Values are produced by the deterministic classifier in
-- apps/web/lib/jobs/classify.ts (see CLASSIFIER_VERSION there):
--   job_function   engineering|data|product|design|sales|marketing|support|
--                  operations|finance|hr|legal|other
--   seniority      intern|junior|mid|senior|staff|principal|manager|director|
--                  exec|unknown
--   language       ISO 639-1 ('en', 'de', ...) or 'unknown'
--   country        ISO 3166-1 alpha-2 ('US', 'DE', ...) or NULL when unparseable
--   is_remote      true when the location advertises remote/anywhere/distributed
--   source         ingest provenance ('greenhouse', 'lever', 'ashby',
--                  'themuse', 'arbeitnow', 'scraper', ...)
--   quality_score  0-100 garbage detector; low scores are city names / bare
--                  department words / URL-slug titles synthesized by the scraper
--
-- Idempotent: IF NOT EXISTS everywhere, safe to re-run.

alter table public.jobs add column if not exists job_function  text;
alter table public.jobs add column if not exists seniority     text;
alter table public.jobs add column if not exists language      text;
alter table public.jobs add column if not exists country       text;
alter table public.jobs add column if not exists is_remote     boolean;
alter table public.jobs add column if not exists source        text;
alter table public.jobs add column if not exists quality_score integer;

comment on column public.jobs.job_function  is 'Classifier taxonomy bucket (engineering|data|product|design|sales|marketing|support|operations|finance|hr|legal|other). NULL = unclassified.';
comment on column public.jobs.seniority     is 'Classifier seniority band (intern|junior|mid|senior|staff|principal|manager|director|exec|unknown). NULL = unclassified.';
comment on column public.jobs.language      is 'ISO 639-1 language code of the posting, or ''unknown''. NULL = unclassified.';
comment on column public.jobs.country       is 'ISO 3166-1 alpha-2 country parsed from the location string. NULL = unknown/unparseable.';
comment on column public.jobs.is_remote     is 'True when the location advertises remote/anywhere/distributed. NULL = unclassified.';
comment on column public.jobs.source        is 'Ingest provenance (ats provider or aggregator id).';
comment on column public.jobs.quality_score is '0-100 deterministic quality/garbage score. Low = synthesized junk title (city name, bare department word, URL slug).';

-- Primary jobs-list ordering: newest postings per tracked company.
-- posted_at NULLs sort last under "desc nulls last", matching the UI ordering.
create index if not exists idx_jobs_company_posted_at
  on public.jobs using btree (company_id, posted_at desc nulls last);

-- Global recency ordering across all companies (the jobs list default sort).
create index if not exists idx_jobs_posted_at
  on public.jobs using btree (posted_at desc nulls last);

-- Facet filters. Partial (WHERE NOT NULL) so the indexes stay small while the
-- backfill is still in flight and never index the unclassified majority.
create index if not exists idx_jobs_job_function
  on public.jobs using btree (job_function) where job_function is not null;

create index if not exists idx_jobs_country
  on public.jobs using btree (country) where country is not null;

create index if not exists idx_jobs_quality_score
  on public.jobs using btree (quality_score) where quality_score is not null;
