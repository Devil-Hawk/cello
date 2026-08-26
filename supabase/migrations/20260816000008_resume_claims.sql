-- Step 8 of the langgraph port: the resume evidence graph. Two tables per
-- the design doc's KB section — "`resume_claims` + `claim_evidence` with
-- `claimsFor()`/`matchClaim()`: embedding similarity may *add* explainable
-- evidence, never excuse a deterministic `findUnsupportedClaims` flag" — and
-- ruling 5's user-data class (RLS + demo wipe-at-expiry, same shape as
-- `interactions`/`insights`, not the privilege-bearing trigger-deny shape).
--
-- WHAT THESE TABLES ARE FOR
--   lib/security/job-text.ts#findUnsupportedClaims is a deterministic,
--   substring-containment check: does the user's OWN resume text already
--   contain a claim a tailored document makes? That check is the hard gate
--   (binding ruling 2 — "unit detects, graph gates") and stays exactly that.
--   What it cannot do is tell the user WHERE in their history a passing
--   claim came from — "Staff engineer at Meta" might be supported by the
--   resume's own text, but a citable quote (which KB document, which
--   sentence) is worth more to a reviewer than a bare pass/fail. That
--   citation index is what these two tables hold, extracted offline by
--   scripts/extract-resume-claims.ts (owner-run, metered, never auto-run —
--   see that script's own header) from the base resume and the user's KB
--   documents, never at request time.
--
-- WHY THIS CANNOT BECOME A SECOND GATE
--   Embedding similarity is fuzzy by construction: two claims can be
--   near-identical in vector space while one is real and the other invented
--   (a fabricated "Staff engineer at Meta" sits right next to a genuine one
--   in embedding space — same words). Only CONTAINMENT — is the text
--   actually present, character-for-character, in a trusted source — is
--   fabrication-proof, which is why findUnsupportedClaims stays the only
--   thing that can flip ok:false. lib/resume/claims.ts#matchClaim's return
--   type carries no `ok` field at all (see that file's header) so there is
--   no field for a caller to even misuse to override the deterministic
--   verdict — enforced in the TypeScript shape, not by caller discipline.
--
-- RLS: 4-policy own-row CRUD, identical shape to resume_documents/kb_* in
-- 20260724000002_phaseB.sql — reusing that migration's do-block loop rather
-- than hand-duplicating four `create policy` statements per table.
--
-- claim_evidence.user_id IS DENORMALIZED (also derivable via claim_id ->
-- resume_claims.user_id) for the same reason kb_chunks.user_id is
-- denormalized against kb_documents: RLS and every list/lookup query filter
-- on one column with no join, and the do-block's policy generator that
-- follows this comment assumes every table in its array has a bare
-- `user_id` column.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

create table if not exists public.resume_claims (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,

    -- The resume version this claim was extracted from. ON DELETE CASCADE:
    -- a claim extracted from a specific resume version has no independent
    -- meaning once that version is gone (re-run the extraction script
    -- against whichever version replaces it as the base resume).
    resume_document_id uuid references public.resume_documents(id) on delete cascade,

    claim_text text not null,
    claim_kind text not null check (claim_kind in ('skill', 'employment', 'education', 'metric', 'credential')),

    -- Whole-word-normalized form of claim_text (lib/resume/claims.ts's own
    -- normalizeClaimKey — deliberately NOT despace(): see that function's
    -- comment for why despace's substring bug has no place in an exact-match
    -- lookup key). Used by matchClaim() for the cheap exact-match tier
    -- before it ever falls to embedding distance.
    normalized_key text,

    -- text-embedding-3-small (1536 dims), written by
    -- scripts/extract-resume-claims.ts via lib/harness/llm.ts#callEmbedding.
    -- NULL = not yet embedded (extraction ran with no embedding provider
    -- configured, or the embed call failed) — matchClaim() degrades to
    -- exact-key matching alone for that claim. No HNSW index on this column
    -- on purpose: unlike kb_chunks/insights, matchClaim() never queries this
    -- column through SQL — claimsFor() reads one user's full claim set (a
    -- resume realistically yields dozens of claims, not thousands) and
    -- compares in JS. ponytail: add a partial HNSW index the day a single
    -- user's claim count makes a JS linear scan measurably slow.
    embedding extensions.vector(1536),

    created_at timestamptz default now() not null
);

create index if not exists idx_resume_claims_user
    on public.resume_claims (user_id);

create index if not exists idx_resume_claims_user_key
    on public.resume_claims (user_id, normalized_key);

comment on table  public.resume_claims                    is 'One row per factual claim extracted from a user''s base resume (and cross-referenced against their KB) — the citation index behind lib/resume/claims.ts. Never a gate: see this migration''s header.';
comment on column public.resume_claims.resume_document_id is 'The resume_documents version this claim was extracted from. NULL only if that version was later deleted independent of this row (should not happen given ON DELETE CASCADE, but the FK itself is nullable per the brief).';
comment on column public.resume_claims.claim_kind         is 'skill | employment | education | metric | credential. Vocabulary enforced by CHECK, matching resume_documents.source''s TS-enforced-elsewhere precedent for free-text vocab columns.';
comment on column public.resume_claims.normalized_key     is 'lib/resume/claims.ts#normalizeClaimKey(claim_text) — whole-word normalized, used for O(1)-ish exact matching before embedding distance.';
comment on column public.resume_claims.embedding          is 'text-embedding-3-small (1536 dims), written by scripts/extract-resume-claims.ts. NULL = not yet embedded — matchClaim() falls back to exact-key matching only.';

alter table public.resume_claims enable row level security;


create table if not exists public.claim_evidence (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,

    claim_id uuid references public.resume_claims(id) on delete cascade not null,

    -- Evidence source pointers. Both nullable and independent: resume-sourced
    -- evidence (a quote from the base resume itself) carries neither; a
    -- KB-sourced quote carries kb_document_id and, when the extraction
    -- script resolved the quote to one retrieval-sized chunk, kb_chunk_id
    -- too. ON DELETE SET NULL on both — same rationale as application_
    -- drafts.resume_document_id in phaseB: the quote TEXT (below) is the
    -- durable evidence; losing the pointer loses provenance, not the fact.
    kb_document_id uuid references public.kb_documents(id) on delete set null,
    kb_chunk_id uuid references public.kb_chunks(id) on delete set null,

    -- The literal excerpt. scripts/extract-resume-claims.ts writes this row
    -- ONLY after checkTailoringContainment(sourceText, quote).ok is true —
    -- the garbage-in guard documented on that script — so every quote that
    -- reaches this table is deterministically verified present in its
    -- source, not merely asserted present by the model that proposed it.
    quote text not null,

    strength text not null check (strength in ('stated', 'demonstrated', 'inferred')),

    created_at timestamptz default now() not null
);

create index if not exists idx_claim_evidence_user
    on public.claim_evidence (user_id);

create index if not exists idx_claim_evidence_claim
    on public.claim_evidence (claim_id);

comment on table  public.claim_evidence          is 'Citable evidence for one resume_claims row — a quote plus where it came from. Written only through scripts/extract-resume-claims.ts''s containment-guarded insert path; see that script''s header.';
comment on column public.claim_evidence.quote    is 'Verbatim excerpt from the source document (base resume or a KB document). Verified via checkTailoringContainment against that source before the row was written — see this migration''s header.';
comment on column public.claim_evidence.strength is 'stated (the source asserts it directly) | demonstrated (shown by example/context, not asserted outright) | inferred (the extraction model''s inference from surrounding context — weakest tier, still containment-verified).';

alter table public.claim_evidence enable row level security;


-- ============================================================================
-- RLS policies — full per-user CRUD, identical shape to
-- 20260724000002_phaseB.sql's resume_documents/kb_* do-block (reused
-- verbatim rather than hand-duplicated; see this migration's header).
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['resume_claims', 'claim_evidence']
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s select', t)
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
        format('own %s select', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s insert', t)
    ) then
      execute format(
        'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
        format('own %s insert', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s update', t)
    ) then
      execute format(
        'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
        format('own %s update', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s delete', t)
    ) then
      execute format(
        'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
        format('own %s delete', t), t
      );
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
