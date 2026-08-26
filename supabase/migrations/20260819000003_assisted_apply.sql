-- Assisted apply: the browser fills, a human reads, only a human click can
-- submit. Two additive pieces:
--
--   1. apply_phase_tokens — the fill-phase / submit-phase authorization
--      apply_credentials never presented to GitHub. This table is what the
--      app hands to the browser-runner workflow: not a credential itself,
--      but proof that THIS EXACT (draft, phase) may be released, exactly
--      once, inside a short window.
--   2. application_drafts gets three new columns: fill_state, screenshots
--      (both what the browser-runner reported back from a fill), and
--      review_confirmed_at (stamped when a human reviews the filled answers
--      — see ruling 8: the submit bundle additionally requires this to be
--      fresh). 'filling' joins the status vocabulary as a TS-only value —
--      see the note below on why no CHECK constraint is added.
--
-- WHY apply_phase_tokens IS PRIVILEGE-BEARING (binding ruling 5, class 1)
--   Same shape as api_tokens and graph_threads: possession of an unconsumed,
--   unexpired row for (draft_id, phase) is the WHOLE authority — the bundle
--   route (app/api/apply/bundle) does nothing but look one up and, if it
--   atomically consumes, release a credential and (for phase='submit') an
--   authorization to write a receipt. No further per-request ownership check
--   stands behind it once the row is consumed. So: RLS + trigger deny for
--   demo profiles + route refusal, not the lighter demo-wipe-at-expiry
--   treatment user-data tables get.
--
-- WHY THE TOKEN'S PLAINTEXT NEVER LEAVES THIS DATABASE
--   Every other bearer credential in this codebase (api_tokens, apply_phase_
--   tokens' obvious sibling) hands its plaintext to a CALLER, who presents it
--   back later. That shape does not fit here: the workflow_dispatch that
--   starts the browser-runner job can only carry `inputs` that GitHub prints
--   in the run's own logs in plain text (draft_id, phase — see
--   .github/workflows/browser-apply.yml's comment) — there is no dispatch
--   input a secret could travel through without being logged. So the token
--   this table stores is generated, hashed and stored, and its PLAINTEXT IS
--   NEVER RETURNED TO ANY CALLER, not even the route that minted it. The
--   runner authenticates the OTHER factor (BROWSER_RUNNER_SECRET, a static
--   transport-level shared secret baked into the workflow's own environment,
--   never a dispatch input) and simply names the (draft_id, phase) it wants;
--   app/api/apply/bundle looks up the newest unconsumed, unexpired row for
--   that pair and atomically consumes IT, never asking the runner to prove
--   it holds a value it was never given. token_hash is kept anyway — for the
--   same audit shape ruling 8 names, and so a future caller that DOES want to
--   hand out the plaintext (a different transport with a real secret channel)
--   costs nothing but a new mint site, not a schema change.
--
-- WHY expires_at HAS NO DEFAULT
--   15 minutes is short enough that a caller forgetting to set it should fail
--   the insert, not silently get a token that outlives its purpose — the same
--   reasoning access_codes.expires_at documents. lib/ats-apply/phase-tokens.ts
--   is the one writer and always computes it explicitly.
--
-- WHY application_drafts.status GETS NO CHECK CONSTRAINT FOR 'filling'
--   20260717000001_harness_tables.sql never added one for this column — the
--   vocabulary (pending_review | approved | submitted | rejected | failed) is
--   enforced in TS only (components/queue/draft-card.tsx's DraftRow['status']
--   union, app/api/drafts/*), matching this repo's established CHECK-not-FK-
--   for-small-closed-vocabularies idiom for a column that ALREADY had no
--   constraint. Adding one now would be new discipline smuggled into an
--   unrelated migration; 'filling' simply joins the same TS union.
--
-- WHY SCREENSHOTS ARE A jsonb COLUMN OF DATA URLS, NOT SUPABASE STORAGE
--   Read first, decided second, recorded here per the brief: this repo has
--   NO Storage bucket anywhere in supabase/migrations/ today — no policy
--   idiom, no signed-upload-url plumbing, nothing to extend. It DOES already
--   have a sanctioned, working pattern for exactly this shape of data —
--   20260729000001_application_receipts.sql's confirmation_attachment_url,
--   a size-capped `data:image/...;base64,...` URL written straight from the
--   caller, validated by lib/applications/receipts.ts's MAX_ATTACHMENT_BYTES
--   (4MB) and its data-URL regex. apps/web/app/api/apply/state/route.ts
--   reuses that exact regex/cap (exported from receipts.ts) for
--   `screenshots`, so a few per-page phone-sized screenshots land well
--   inside jsonb's storage and the 1GB Postgres row/toast ceiling nobody here
--   is near. That comment there also names the upgrade path verbatim: "a
--   future move to real object storage can populate the SAME column with an
--   https: URL — no migration, no read-side change." The same is true here.
--
-- PRECONDITION, same reasoning as every migration in this family: plpgsql
-- resolves column references lazily, at first FIRE rather than at apply
-- time, so a missing dependency would apply cleanly here and then fail at
-- runtime on every apply_phase_tokens write instead of failing the
-- migration itself.
do $$
begin
  if to_regclass('public.application_drafts') is null then
    raise exception 'apply 20260717000001_harness_tables.sql before this migration'
      using errcode = 'undefined_table';
  end if;

  perform p.is_demo, p.demo_expires_at
  from public.profiles p
  where false;
end
$$;

-- ---------------------------------------------------------------------------
-- apply_phase_tokens
-- ---------------------------------------------------------------------------

create table if not exists public.apply_phase_tokens (
    id uuid primary key default gen_random_uuid(),

    draft_id uuid not null references public.application_drafts(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- Which half of the two-phase flow this authorizes. FILL never carries
    -- submit-eligibility; SUBMIT additionally requires the draft to be
    -- 'approved' with a fresh review_confirmed_at (see app/api/apply/bundle).
    phase text not null check (phase in ('fill', 'submit')),

    -- SHA-256 of a server-generated value never returned to any caller — see
    -- the file header for why this column is an audit artifact rather than a
    -- bearer secret in THIS table specifically.
    token_hash text not null unique,

    issued_at timestamptz not null default now(),

    -- <= 15 minutes from issuance, enforced by lib/ats-apply/phase-tokens.ts
    -- at mint time (ruling 8). No default — see file header.
    expires_at timestamptz not null,

    -- NULL = still live. Set exactly once, by the atomic
    -- `update ... where consumed_at is null returning` in
    -- lib/ats-apply/phase-tokens.ts#consumePhaseToken — the single-use
    -- guarantee ruling 8 requires.
    consumed_at timestamptz
);

-- app/api/apply/bundle's hot path: newest unconsumed, unexpired row for
-- (draft_id, phase).
create index if not exists apply_phase_tokens_draft_phase_idx
    on public.apply_phase_tokens (draft_id, phase, issued_at desc);

comment on table public.apply_phase_tokens is
  'Fill/submit phase authorization for assisted apply (binding ruling 8). Privilege-bearing (ruling 5): an unconsumed row for (draft_id, phase) is the whole authority. Written and consumed ONLY through the service-role admin client (lib/ats-apply/phase-tokens.ts) — RLS gives `authenticated` no policy on any verb.';
comment on column public.apply_phase_tokens.phase is '''fill'' or ''submit''. A submit-phase bundle additionally requires application_drafts.status = ''approved'' and a fresh review_confirmed_at — see app/api/apply/bundle/route.ts.';
comment on column public.apply_phase_tokens.token_hash is 'SHA-256 of a value generated and hashed server-side, never returned to any caller for this table — see the migration header for why possession is proven by (draft_id, phase) lookup, not by presenting the plaintext.';

-- ---------------------------------------------------------------------------
-- RLS — none for `authenticated`, on any verb
-- ---------------------------------------------------------------------------
-- Every read and write is invokeGraphForUser-shaped: the app's own routes
-- (app/api/apply/prepare, /bundle, /state, /confirm) always go through the
-- service-role admin client, which bypasses RLS entirely — policies are
-- irrelevant to that path. What RLS has to prevent is a signed-in browser,
-- holding only the anon key and its own JWT, reaching this table directly
-- over PostgREST. Unlike api_tokens (which gives the settings page a reason
-- to SELECT a caller's own rows) or graph_threads (same, for the run/
-- conversation UI), NOTHING in this product ever shows a user their own
-- apply_phase_tokens row — there is no list view, no detail view, nothing to
-- read. So this table gets NO POLICY AT ALL for `authenticated`, on every
-- verb: with RLS enabled and no policy for a verb, PostgREST refuses that
-- verb outright for that role — default-deny, no `using` expression to get
-- wrong, for select AND insert AND update AND delete alike.

alter table public.apply_phase_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- The demo lockdown, at the write itself
-- ---------------------------------------------------------------------------
-- RLS is not enough on its own: the service key bypasses policies entirely,
-- and this codebase legitimately holds one
-- (lib/harness/supabase-admin.ts createAdminClient()). This trigger runs for
-- every writer regardless. No service-role exemption, same argument as
-- forbid_demo_api_tokens: nothing server-side has any legitimate reason to
-- mint a fill/submit authorization for a demo workspace — app/api/apply/
-- prepare and app/api/apply/confirm both refuse is_demo before they ever
-- reach a write, and this is the backstop for anything that forgets.

create or replace function public.forbid_demo_apply_phase_tokens()
returns trigger
language plpgsql
-- SECURITY INVOKER: the only writer that can ever reach this function's body
-- is the service role (RLS already refuses every other writer before a row
-- would exist to fire the trigger on), and the service role bypasses RLS on
-- public.profiles the same way it bypasses RLS on public.apply_phase_tokens
-- — so an invoker-rights read already sees every row and DEFINER buys
-- nothing here. Same reasoning as forbid_demo_graph_threads.
security invoker
set search_path = ''
as $$
begin
  -- Same two-signal demo test as guardrails.ts isDemoProfile() and every
  -- other lockdown migration in this family: EITHER the flag or a demo
  -- deadline makes it a demo, so a row that shed the flag but kept the
  -- deadline is still caught.
  if exists (
    select 1 from public.profiles p
    where p.id = new.user_id
      and (coalesce(p.is_demo, false) is true or p.demo_expires_at is not null)
  ) then
    raise exception 'demo profiles cannot create or modify apply phase tokens'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists forbid_demo_apply_phase_tokens on public.apply_phase_tokens;
create trigger forbid_demo_apply_phase_tokens
  before insert or update on public.apply_phase_tokens
  for each row
  execute function public.forbid_demo_apply_phase_tokens();

-- ---------------------------------------------------------------------------
-- application_drafts: assisted-apply columns
-- ---------------------------------------------------------------------------
-- Additive, nullable, no default — matching 20260724000002_phaseB.sql's
-- resume_document_id and 20260818000003_outreach_reply_outcome.sql's
-- reviewed_at: a single ALTER TABLE ADD COLUMN IF NOT EXISTS per column, no
-- backfill needed since every existing row simply never went through this
-- phase.

alter table public.application_drafts
  add column if not exists fill_state jsonb,
  add column if not exists screenshots jsonb,
  add column if not exists review_confirmed_at timestamptz;

comment on column public.application_drafts.fill_state is 'Per-field answers the browser-runner captured during the fill phase (packages/scrapers/src/apply_fill.py), written by PATCH app/api/apply/state. NULL until a fill has completed.';
comment on column public.application_drafts.screenshots is 'Array of {page, dataUrl, capturedAt} — one screenshot per page the fill run reached. Size-capped data: URLs (see file header); NULL until a fill has completed.';
comment on column public.application_drafts.review_confirmed_at is 'Stamped when a human confirms the reviewed fill/answers (ruling 8). The submit bundle (app/api/apply/bundle) additionally requires this to be within AUTHORIZATION_MAX_AGE_MS of now, on top of status = ''approved''.';

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "Applied, but the guard is not attached" looks exactly like success and
-- would leave a capability-bearing table with no demo fence beyond RLS.
do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.apply_phase_tokens'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.apply_phase_tokens';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'apply_phase_tokens'
  ) then
    raise exception 'public.apply_phase_tokens must have NO policies for authenticated — service-role only';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.apply_phase_tokens'::regclass
      and tgname = 'forbid_demo_apply_phase_tokens'
      and not tgisinternal
  ) then
    raise exception 'forbid_demo_apply_phase_tokens is not attached to public.apply_phase_tokens';
  end if;

  perform 1 from public.application_drafts where false and fill_state is null and screenshots is null
    and review_confirmed_at is null;
end
$$;
