-- Stop the browser from ever holding the whole profiles.preferences column.
--
-- THE HOLE THIS CLOSES
--   preferences is one jsonb column carrying EVERYTHING: budget, targeting,
--   digest, model choice — and also api_keys (ciphertext, but still key
--   material) and autopilot.atsKeys (an ATS BOARD PASSWORD, and per a
--   secret-handling audit of this codebase, never encrypted by any writer).
--   PostgREST has no jsonb-path projection: `select('preferences')` returns
--   the ENTIRE column or none of it. Several 'use client' components need
--   only a handful of harmless fields (a budget summary, a gmail sync
--   timestamp, a match threshold) and were fetching the whole blob to get
--   them, which put the ATS password and every provider's key ciphertext into
--   ordinary browser JS memory — reachable by devtools, a malicious extension,
--   a dependency, or any future XSS — on every dashboard/jobs/queue/onboarding
--   page load. See apps/web/lib/preferences/client-safe.ts for the
--   application-layer half of this fix (those call sites now read through the
--   function this migration adds instead of the raw column).
--
-- WHY REVOKE FROM anon BUT NOT authenticated
--   The obvious full fix is to revoke column-level SELECT/UPDATE from BOTH
--   anon and authenticated and force every reader through a narrow function.
--   That is NOT what this migration does, and the omission is deliberate, not
--   an oversight — verified by reading every call site, not assumed:
--
--     grep -rn "from('profiles')" apps/web | grep -v node_modules
--
--   turns up upwards of twenty request handlers — app/api/settings/keys,
--   .../providers, .../budget, .../targeting, .../model,
--   .../application-identity, .../search, .../sources, app/api/gmail/permissions,
--   app/api/digest, and more — that read or write preferences through
--   lib/supabase/server.ts's createClient(), which is the SAME anon key plus
--   the caller's own JWT that a browser holds, forwarded through Next.js
--   rather than issued by it. PostgREST cannot tell those two apart: both
--   resolve to the `authenticated` role, with no server/browser distinction at
--   the database. Revoking authenticated's column grant would not just close
--   the leak, it would 500 every one of those routes — "a migration that
--   locks the owner out of their own settings is a worse bug than the leak."
--   None of those files are this change's to fix.
--
--   anon has no such cost. Nothing legitimate ever reads or writes a profile
--   before sign-in — handle_new_user() (20240131000002) inserts a fresh row
--   via a SECURITY DEFINER trigger that never touches preferences, and every
--   read/write path above requires a signed-in session. Revoking anon's grant
--   is pure hardening: it removes the column even from a bug that let an
--   unauthenticated request past RLS, for zero behavioural cost today.
--
-- WHAT REMAINS OPEN, STATED PLAINLY (do not infer more than this closes)
--   authenticated keeps its raw table-level SELECT and UPDATE on preferences,
--   unchanged. That means:
--     * A signed-in browser can still call PostgREST directly (outside this
--       app's own JS) and read the full column, secrets included — the
--       function below only helps callers who choose to use it.
--     * preferences remains browser-WRITABLE by the owner via the raw column,
--       including preferences.provider. Nothing in this migration stops a
--       write of preferences.provider = {active:"local-server",
--       localServerBaseUrl:"https://attacker"} — closing that needs the
--       ~20 routes above moved off the user-scoped client (service key, or a
--       write-side equivalent of the function below), which is a
--       coordinated, cross-file change this migration does not make.
--   The one write this migration DOES fully move off the raw column is
--   onboarding's own (set_onboarding_preferences below) — a narrow function
--   that can set exactly matchThreshold and onboardedAt and nothing else,
--   because that write lives in this task's owned files and could be fixed
--   for real rather than just narrowed on the read side.
--
-- ---------------------------------------------------------------------------
-- PRECONDITION
-- ---------------------------------------------------------------------------
-- Same reasoning as 20260803000003/20260803000004: prove the column this
-- migration keys off actually exists before REVOKE and the functions below
-- are defined against it, so a mismatched database fails HERE with a clear
-- error rather than at the first profile read after the migration "succeeds".
do $$
begin
  perform p.preferences from public.profiles p where false;
end
$$;

-- ---------------------------------------------------------------------------
-- Column-level lockdown for the one role with zero legitimate readers
-- ---------------------------------------------------------------------------
-- REVOKE is naturally idempotent (revoking a privilege the role never had is
-- not an error), so this is safe to re-run and safe on a database where it
-- already applied.
revoke select (preferences), update (preferences) on public.profiles from anon;

-- ---------------------------------------------------------------------------
-- get_client_safe_preferences() — the narrow read channel
-- ---------------------------------------------------------------------------
-- Returns exactly the fields a signed-in client is ever allowed to see, built
-- with jsonb_build_object so the return value is a fixed, enumerable set of
-- keys — NOT `preferences` with some keys removed, which would silently
-- start leaking again the moment someone adds a new secret-bearing key to
-- that column and forgets this function exists. Anything not named below can
-- never come back from this function, full stop:
--
--   budget.{spentUsd,monthlyUsd,periodStart}  — read-only summary; the
--     lib/harness/spend.ts ledger these describe is written only by the
--     admin client and the demo lockdown trigger (20260803000003) freezes a
--     demo's cap/spend against exactly this kind of writeback misuse.
--   gmail_sync.lastSyncDate  — ONLY the timestamp. gmail_sync also carries
--     scannedEmailIds (up to 5000 Gmail message ids, see
--     app/api/gmail/sync/route.ts) — bulky and not a secret, but not needed
--     by any client component either, so it is not forwarded.
--   autoSubmit, autoApply, outreach.{autoSend,dailyCap}  — capability flags
--     the queue page's policy banner reports back to the user; never a
--     credential.
--   matchThreshold  — the onboarding/dashboard threshold control.
--   targeting  — the WHOLE subtree, deliberately: lib/targeting.ts documents
--     this as the one place that defines "the jobs I care about" (function,
--     seniority, country, language, score, exclusion facets) and every field
--     in it is designed to be read back to the user's own UI. It has never
--     held credential material — see resolveTargeting()'s own contract.
--
-- Excluded, explicitly, by omission: api_keys (every provider's key
-- ciphertext), autopilot.atsKeys (unencrypted board passwords per the audit
-- that opened this migration), provider (a switch that can redirect the
-- user's own LLM calls to an attacker host), gmail_permissions (OAuth scope
-- state), and anything else this list does not name.
--
-- SECURITY DEFINER, and why: authenticated keeps its own table-level SELECT
-- on preferences today (see the note above), so this function does not
-- strictly need elevated rights to read the caller's own row RIGHT NOW — but
-- the day someone finishes the job and revokes authenticated's grant too,
-- an INVOKER version of this function would go dark for every caller at the
-- same moment. DEFINER decouples "can this function read preferences" from
-- "does the calling role have the raw grant", which is the whole point of
-- routing reads through a narrow function instead of the column.
--
-- What makes DEFINER safe here, unlike a careless one: NO PARAMETERS. There
-- is no argument through which a caller can name another user's id — the
-- function can only ever read auth.uid()'s own row, the same verified claim
-- PostgREST itself resolves the caller's identity from, so this cannot be
-- turned into a cross-user read the way a `get_preferences(user_id)` shaped
-- function could be.
create or replace function public.get_client_safe_preferences()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'budget', jsonb_build_object(
      'spentUsd', p.preferences #> '{budget,spentUsd}',
      'monthlyUsd', p.preferences #> '{budget,monthlyUsd}',
      'periodStart', p.preferences #> '{budget,periodStart}'
    ),
    'gmail_sync', jsonb_build_object(
      'lastSyncDate', p.preferences #> '{gmail_sync,lastSyncDate}'
    ),
    'autoSubmit', p.preferences -> 'autoSubmit',
    'autoApply', p.preferences -> 'autoApply',
    'outreach', jsonb_build_object(
      'autoSend', p.preferences #> '{outreach,autoSend}',
      'dailyCap', p.preferences #> '{outreach,dailyCap}'
    ),
    'matchThreshold', p.preferences -> 'matchThreshold',
    'targeting', p.preferences -> 'targeting',
    -- onboardedAt — a timestamp, never a secret.
    --
    -- Added because app/(app)/layout.tsx needs exactly this one value to
    -- decide whether to send a brand-new user to the onboarding wizard, and
    -- WITHOUT it that layout has to read the raw preferences column. That
    -- layout wraps the ENTIRE (app) route group, so it is the single worst
    -- place in the product to do that: it ships api_keys and
    -- autopilot.atsKeys to the browser on every authenticated page load, not
    -- just on the pages that were already fixed. A safe projection that omits
    -- the one field its most frequent caller needs does not get adopted, and
    -- an unadopted projection protects nothing.
    'onboardedAt', p.preferences -> 'onboardedAt'
  )
  from public.profiles p
  where p.id = auth.uid();
$$;

-- Explicit rather than relying on a default PUBLIC grant, same reasoning as
-- 20260803000003's is_service_role_request(): if a caller could not execute
-- this, the client call fails loudly instead of silently returning nothing.
-- anon is deliberately NOT granted this — auth.uid() is null without a
-- session, so it would only ever return null for anon anyway, but the grant
-- itself should not exist for a role with no legitimate call to make.
grant execute on function public.get_client_safe_preferences() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- set_onboarding_preferences() — the narrow write channel for THIS task
-- ---------------------------------------------------------------------------
-- app/(app)/onboarding/page.tsx used to read the FULL preferences column just
-- to spread it back unchanged around two fields it actually meant to set —
-- the exact same over-read as the dashboard/queue leak, just on the write
-- path's setup step. A merge that only needs to touch two keys should never
-- see the other ones. This function does the merge IN Postgres with `||`,
-- so the ciphertext/atsKeys neighbours never travel to the browser in either
-- direction for this call.
--
-- Two scalar arguments, not a jsonb patch: a `jsonb patch` parameter would
-- put back exactly the hazard this migration removes — a client-controlled
-- blob merged into preferences with no per-key allowlist, one `provider` key
-- away from the hijack described above. A fixed argument list is the
-- allowlist; there is no key this function can be made to write that is not
-- named in its signature.
create or replace function public.set_onboarding_preferences(
  p_match_threshold numeric,
  p_onboarded_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'set_onboarding_preferences requires a signed-in caller'
      using errcode = 'insufficient_privilege';
  end if;

  -- Same 0-100 clamp resolveTargeting() applies to minScore — the onboarding
  -- UI only ever sends 50/70/85, but this is the actual trust boundary, not
  -- the React component, so it is enforced again here.
  --
  -- to_jsonb(timestamptz) renders Postgres's own text format ("2026-08-03
  -- 12:00:00+00"), not JS's `Date#toISOString()` format — fine here because
  -- app/(app)/layout.tsx's only reader of onboardedAt tests it for truthiness
  -- (`!prefs.onboardedAt`), never parses it as a date.
  update public.profiles
  set preferences = preferences
                     || jsonb_build_object(
                          'matchThreshold', greatest(0, least(100, p_match_threshold))
                        )
                     || jsonb_build_object('onboardedAt', to_jsonb(p_onboarded_at))
  where id = auth.uid();
end;
$$;

grant execute on function public.set_onboarding_preferences(numeric, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "The migration applied but the grant/function is not actually there" would
-- look identical to success. Prove all three pieces landed.
do $$
begin
  if has_column_privilege('anon', 'public.profiles', 'preferences', 'SELECT') then
    raise exception 'anon must not retain SELECT on profiles.preferences';
  end if;

  if has_column_privilege('anon', 'public.profiles', 'preferences', 'UPDATE') then
    raise exception 'anon must not retain UPDATE on profiles.preferences';
  end if;

  if not has_function_privilege('authenticated', 'public.get_client_safe_preferences()', 'EXECUTE') then
    raise exception 'authenticated must be able to execute get_client_safe_preferences()';
  end if;

  if not has_function_privilege(
    'authenticated', 'public.set_onboarding_preferences(numeric, timestamptz)', 'EXECUTE'
  ) then
    raise exception 'authenticated must be able to execute set_onboarding_preferences()';
  end if;

  -- Outside a PostgREST request there is no request.jwt.claims, so auth.uid()
  -- is null, the WHERE clause matches no row, and a scalar-returning SQL
  -- function whose query matches no row returns NULL — not the migration
  -- runner's own arbitrary row. Same "prove the guard actually guards" spirit
  -- as 20260803000003's is_service_role_request() check.
  if public.get_client_safe_preferences() is not null then
    raise exception 'get_client_safe_preferences() must not fabricate a row with no caller identity';
  end if;
end
$$;
