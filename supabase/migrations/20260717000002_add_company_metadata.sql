-- Additive: machine-managed metadata on companies (nullable jsonb).
-- Used to cache discovered ATS board info:
--   { "ats": { "provider": "greenhouse"|"lever"|"ashby", "token": "...",
--              "source": "url"|"probe"|"manual", "discovered_at": "ISO" } }
-- All code paths tolerate this column being absent (fall back to URL/probe
-- detection every run), so this migration can lag the deploy safely.
-- Idempotent: IF NOT EXISTS. No index needed — lookups ride the primary key,
-- and jobs(company_id, external_id) is already unique via unique_job_per_company.

alter table public.companies add column if not exists metadata jsonb;

comment on column public.companies.metadata is
  'Machine-managed metadata (e.g. cached ATS board under "ats"). Not user-visible notes.';
