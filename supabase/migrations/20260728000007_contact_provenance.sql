-- Contact provenance: source / confidence / verified / basis for contacts the
-- product SOURCED automatically (dossier text, job-posting text, a learned
-- email-address pattern, or an opt-in Hunter/Apollo lookup) as opposed to a
-- contact the user typed in by hand.
--
-- Additive + nullable, matching this repo's migration convention (see
-- 20260724000002_phaseB.sql's header): every existing row (all manually
-- entered today) reads as source=NULL, confidence=NULL, verified=false,
-- basis=NULL — which is the honest state for a row with no recorded
-- provenance, not a guess.
--
-- WHY verified DEFAULTS FALSE AND STAYS FALSE UNLESS A PROVIDER CONFIRMS IT:
-- lib/contacts/sources.ts derives plausible contacts (a name mentioned in a
-- dossier/posting, or an email guessed from a learned pattern) and NEVER sets
-- verified=true for those — only Hunter's email-verifier actually confirms
-- deliverability. Presenting an inferred address as confirmed would be a
-- product defect; this column makes "how do we know" a first-class, queryable
-- fact instead of something buried in prose.

alter table public.contacts add column if not exists source text;
alter table public.contacts add column if not exists confidence real;
alter table public.contacts add column if not exists verified boolean not null default false;
alter table public.contacts add column if not exists basis text;

comment on column public.contacts.source is
  'How this contact was found: dossier|posting|pattern|hunter|apollo. NULL = manually entered by the user (no automated provenance). Vocabulary lives in TS (lib/contacts/sources.ts ContactSource), not a CHECK, so a new provider ships without a migration.';
comment on column public.contacts.confidence is
  '0..1 confidence the sourcing pipeline assigned to this contact. NULL = not scored (e.g. manual entry).';
comment on column public.contacts.verified is
  'TRUE only when a provider affirmatively confirmed deliverability (e.g. Hunter''s email-verifier returning "deliverable"). An address that is merely inferred, pattern-guessed, or quoted from a job posting is verified=false however high its confidence — "plausible" and "confirmed" are never conflated. Existing rows all default false, which is correct: nothing about them was ever verified.';
comment on column public.contacts.basis is
  'Short, human-readable explanation of how this contact was derived (e.g. "mentioned in job posting text", "pattern inferred from a known-good address at this domain — INFERRED, not verified"). Never states a fabricated shared history or connection the candidate cannot support.';

-- Primary lookup pattern for the sourcing pipeline: "what do we already know
-- at this company" (dedupe + pattern-anchor discovery). idx_contacts_user_id
-- already exists but doesn't cover company_id.
create index if not exists idx_contacts_user_company on public.contacts (user_id, company_id);

notify pgrst, 'reload schema';
