-- Job provenance: the two per-job facts that genuinely cannot be derived from
-- existing columns — "when was this specific posting last reconfirmed alive"
-- and "did that check find it still open".
--
-- WHY ONLY THESE TWO COLUMNS
-- apps/web/lib/sources/provenance.ts computes everything else (which
-- source/adapter, official ATS vs aggregator vs the aggregator masquerading
-- as an employer, whether the description is complete, whether automatic
-- application is supported) at READ time from jobs.source, jobs.url,
-- jobs.description and companies.domain — those already exist and adding
-- columns for them would just be a slower, staler copy of a computation.
--
-- last_verified_at / still_open are different: traced through
-- lib/ats/index.ts refreshCompany(), a refresh only INSERTS newly-discovered
-- jobs and never touches a job already on file — "Existing rows are left
-- untouched (preserves discovered_at/is_new/match data)" per that function's
-- own docstring. So for every row in this database today there is no signal
-- beyond discovered_at for "did anyone check this posting is still there".
-- That is an honest gap, not something to backfill with a guess — every
-- existing row correctly reads as last_verified_at = NULL, still_open = NULL
-- ("never explicitly reverified") until a future reverification pass writes
-- into these columns. This migration only opens the seam; it does not
-- populate it — see the header of lib/sources/provenance.ts for the read-side
-- contract (VerificationBasis: 'reverified' | 'discovery-only' | 'unknown').
--
-- Additive + nullable, matching this repo's convention (see
-- 20260728000007_contact_provenance.sql / 20260724000002_phaseB.sql headers):
-- `add column if not exists`, no default, no backfill, re-runnable, and safe
-- to apply against a live table without a rewrite.

alter table public.jobs add column if not exists last_verified_at timestamptz;
alter table public.jobs add column if not exists still_open boolean;

comment on column public.jobs.last_verified_at is
  'When a source was last re-checked and this specific posting was confirmed present. NULL = never reverified since discovery (the common case today — no write path populates this yet). Read via lib/sources/provenance.ts computeJobProvenance().';
comment on column public.jobs.still_open is
  'TRUE = last reverification found the posting still live. FALSE = last reverification found it gone (closed/expired). NULL = never explicitly checked either way — NOT the same as "closed", and must not be presented as such.';

-- Provenance reads/sorts on "is this stale" (last_verified_at) and "is this
-- still open" (still_open) together in the common case — surfacing jobs that
-- were verified open, then filtering/sorting by staleness.
create index if not exists idx_jobs_last_verified_at
  on public.jobs (last_verified_at desc nulls last);

notify pgrst, 'reload schema';
