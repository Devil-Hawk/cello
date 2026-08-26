-- Stop a demo profile from escalating its own privileges.
--
-- THE HOLE THIS CLOSES
--   profiles' only UPDATE policy is:
--       create policy "Users can update own profile" on public.profiles
--           for update using (auth.uid() = id);
--   `using` decides which ROWS you may update. It says nothing about which
--   COLUMNS, and (with no `with check`, Postgres reuses `using` for the new row)
--   the only thing it pins is `id`. So the holder of a demo session — who is a
--   real authenticated user on their own profile row, holding the browser's own
--   anon key — can open devtools and run:
--       update profiles set is_demo = false where id = auth.uid();
--
--   Every demo guardrail in the application keys off that flag: the $1 AI
--   budget, the refusal to send real outreach, and expiry at 72 hours. All
--   three are therefore defeated by one UPDATE, and afterwards the ex-demo can
--   raise its own spend cap through the product's own budget editor
--   (/api/settings/budget authenticates with getUser() and writes
--   preferences.budget.monthlyUsd for whoever is calling).
--
--   An application-layer check cannot fix this, because the application is
--   downstream of a flag the attacker owns, and because PostgREST hands every
--   signed-in browser a direct write path to its own row that no route handler
--   is on. The guarantee has to live where the write happens.
--
-- WHY A TRIGGER RATHER THAN `with check`
--   The rule is about the TRANSITION, not the final state: a demo profile may
--   keep is_demo = true, but must not move it to false; it may lower its spend
--   cap but not raise it. RLS `with check` sees only the proposed row, never the
--   existing one, so it cannot express "you may not change this". A BEFORE
--   UPDATE trigger sees OLD and NEW.
--
-- WHAT REMAINS ALLOWED
--   A demo user can still edit everything a demo is supposed to edit — their
--   name, their résumé text, their targeting, digest, model choice and
--   reasoning effort — because the demo has to feel like the real product. Only
--   the privilege-bearing fields enumerated below are frozen, and only for
--   profiles that are already demos.
--
-- THIS FILE IS THE BACKSTOP, NOT THE POLICY. lib/access/guardrails.ts still
-- refuses at the application layer. Both, always: the trigger catches the paths
-- that never pass through a route handler, the application catches the ones
-- that never reach a write.

-- ---------------------------------------------------------------------------
-- PRECONDITION
-- ---------------------------------------------------------------------------
-- plpgsql does not resolve column references in a function body until the
-- trigger first FIRES. Without this block, applying this migration against a
-- database that is missing `is_demo` would succeed silently and then fail every
-- single UPDATE on profiles — the owner's included — with a runtime error. That
-- is the worst outcome available here, so the dependency is checked now, at
-- apply time, where a failure is a migration that did not run rather than a
-- product that does not work.
do $$
begin
  if to_regclass('public.access_codes') is null then
    raise exception 'apply 20260803000002_access_codes.sql before this migration'
      using errcode = 'undefined_table';
  end if;

  -- Resolves every profiles column and jsonb path the trigger below reads.
  -- `where false` means no row is touched; the parser still has to prove the
  -- identifiers exist.
  perform p.is_demo,
          p.demo_expires_at,
          p.email,
          p.preferences #> '{budget,monthlyUsd}'
  from public.profiles p
  where false;
end
$$;

-- ---------------------------------------------------------------------------
-- Who is allowed past the lockdown
-- ---------------------------------------------------------------------------
-- THE EXEMPTION IS THE WHOLE SECURITY BOUNDARY, so it is a named function with
-- its reasoning attached rather than an inline expression repeated twice.
--
-- THE BOUNDARY IS SERVER-VS-CLIENT, NOT DEMO-VS-OWNER. The redemption route
-- legitimately does every one of the things forbidden below — it marks the
-- profile as a demo, sets its deadline, pins its $1 cap, provisions its model
-- key — and lib/harness/spend.ts's recordSpend() must be able to write the
-- spend ledger on every metered call. Both use the SERVICE KEY
-- (lib/harness/supabase-admin.ts createAdminClient()), which is only ever held
-- server-side. Blocking them would break the feature.
--
-- WHY NOT auth.role(). The obvious idiom has three problems, any one of which
-- is disqualifying for a check that sits in front of every profile write:
--   1. It is a SQL wrapper over `request.jwt.claim.role` / `request.jwt.claims`
--      that Supabase deprecated in 2022 and does not create in every project.
--      A missing function is not caught when this migration is applied (plpgsql
--      resolves callees lazily) — it surfaces as "function auth.role() does not
--      exist" on the first profile UPDATE, for everyone.
--   2. It reads only the JWT. A migration, a psql session, the Supabase SQL
--      editor and pg_cron have no JWT at all, so auth.role() is NULL there and
--      the owner could not repair a demo row by hand.
--   3. It says nothing about the actual database role the statement is running
--      as, which is the thing PostgREST derives from a VERIFIED signature.
--
-- WHAT THIS USES INSTEAD — the VERIFIED TOKEN FIRST, the database role only
-- when there is no token in play:
--
--   * request.jwt.claims ->> 'role' decides whenever it is present. PostgREST
--     writes this GUC itself, from claims it has already verified against the
--     project's JWT secret, at the start of the request's transaction. No
--     PostgREST client can set a GUC, and nothing rewrites it later in the
--     request.
--
--     THIS IS CHECKED BEFORE current_user, AND A CLIENT ROLE CLAIM IS FINAL —
--     the token can always REFUSE the exemption, and current_user can never
--     override that refusal. current_user is NOT a hard boundary inside a
--     request: SET ROLE is authorised against the SESSION user, and PostgREST's
--     session user is `authenticator`, which IS a member of service_role. So a
--     demo request that reached any SQL-executing primitive could flip
--     current_user to service_role while the token still says `authenticated`.
--     Checking the token first closes that; checking the role first reopens it.
--
--     MEASURED, not argued. Against PostgreSQL 16 with the order reversed, a
--     demo session calling an ordinary SECURITY DEFINER helper (current_user
--     becomes `postgres`, which is in the fallback allowlist) successfully set
--     its own provider to 'local-cli' — i.e. escaped to an UNMETERED backend.
--     With the order as written, the same call is refused. Migration
--     20260803000005 adds exactly that kind of definer RPC over preferences, so
--     this is a live pattern in this codebase, not a hypothetical.
--
--     GRANTING the exemption, unlike refusing it, needs BOTH signals — see the
--     note on the token branch below. The token is necessary, not sufficient.
--
--   * current_user, only when NO verified claims are present — a migration,
--     psql, the Supabase SQL editor, pg_cron. Those have no JWT at all, and
--     refusing them would mean the owner could not repair a demo row by hand.
--     It must be read from a SECURITY INVOKER function: inside a SECURITY
--     DEFINER function current_user is the function's OWNER, which would make
--     every caller look like `postgres` and disable the lockdown entirely. That
--     is why nothing in this file is SECURITY DEFINER except the one function
--     that genuinely needs to read another user's row.
--     `authenticator` is deliberately NOT in the allowlist: if PostgREST ever
--     failed to switch roles we want the lockdown ON, not off.
--
-- The cast is wrapped, because `''::jsonb` or any malformed claims blob raises,
-- and a raise HERE would break profile updates for everyone. It degrades to the
-- current_user branch rather than to "exempt" — verified: with the GUC set to
-- 'not-json-at-all', to '[]' and to a bare JSON scalar, this returns false for
-- an `authenticated` caller, so the lockdown stays ON.
--
-- Note for whoever tests this: a malformed claims GUC actually raises earlier,
-- in Supabase's own auth.uid() (it casts the same GUC to jsonb with no handler)
-- while RLS is being evaluated, so the statement fails before this function is
-- reached. The wrapper is still correct and still required — it is what keeps
-- THIS function from being the thing that breaks — but do not expect to observe
-- it in an end-to-end test; call the function directly to see it work.
create or replace function public.is_service_role_request()
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  raw_claims text;
  claim_role text;
begin
  -- current_setting(..., true) returns NULL for an unset GUC and cannot raise.
  raw_claims := nullif(current_setting('request.jwt.claims', true), '');

  if raw_claims is not null then
    begin
      claim_role := (raw_claims::jsonb) ->> 'role';
    exception
      when others then
        claim_role := null;
    end;
  end if;

  -- A request with a verified role claim: the token decides WHETHER an
  -- exemption is on the table at all, and the database role may only agree with
  -- it, never overrule it.
  --
  -- The second half is not redundant with the first. PostgREST derives BOTH
  -- facts from the SAME verified token — a service_role JWT is answered with
  -- `set local role service_role` — so "the token says service_role while the
  -- statement is running as a CLIENT role" is a combination PostgREST does not
  -- produce. Refusing it means possession of the claims GUC is not by itself
  -- enough to be exempt. That matters because the GUC being unforgeable is an
  -- assumption about PostgREST, not a property of Postgres: any SQL-executing
  -- primitive ever exposed to a demo session (an RPC that calls set_config, a
  -- future SECURITY DEFINER helper) would otherwise hand over the exemption in
  -- one call. Requiring the role too means such a bug is not sufficient on its
  -- own. Verified by execution: with the claim alone this returned true.
  --
  -- Deliberately a DENYLIST of the three client roles rather than an allowlist
  -- of server ones. An allowlist would refuse any deployment whose service-side
  -- role is named something this file has not heard of, and the failure mode
  -- there is "demo provisioning stops working". This form can only ever refuse
  -- MORE than the bare claim did, never less, and it cannot be surprised by a
  -- role it does not know.
  if claim_role is not null then
    return claim_role = 'service_role'
       and current_user not in ('anon', 'authenticated', 'authenticator');
  end if;

  -- No request in flight (or claims carrying no role at all): fall back to the
  -- real database role.
  return current_user in ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin');
end;
$$;

-- The lockdown trigger is SECURITY INVOKER, so the caller's own EXECUTE right
-- on this helper is what applies. Explicit rather than relying on the default
-- PUBLIC grant: if a demo session could not execute it, the trigger would error
-- instead of deciding, and the demo's profile writes would fail confusingly.
-- The function discloses only what the caller already knows — its own role.
grant execute on function public.is_service_role_request() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The lockdown
-- ---------------------------------------------------------------------------

create or replace function public.enforce_demo_profile_lockdown()
returns trigger
language plpgsql
-- NOT security definer. See is_service_role_request() above: its fallback branch
-- reads current_user, which a definer context would rewrite to this function's
-- owner — making every caller look like `postgres` and exempting all of them.
security invoker
set search_path = ''
as $$
declare
  old_cap numeric;
  new_cap numeric;
  old_spent numeric;
  new_spent numeric;
begin
  -- ORDER MATTERS, AND THIS CHECK IS FIRST ON PURPOSE.
  --
  -- A profile that is not a demo leaves this function before anything else can
  -- be evaluated — no helper call, no jsonb parsing, no cast. That is the proof
  -- that the owner's own profile updates cannot be affected by anything in this
  -- file: for `is_demo = false, demo_expires_at = null` (every real account,
  -- since is_demo is NOT NULL DEFAULT false) the body is two comparisons and a
  -- return.
  --
  -- The demo test mirrors lib/access/guardrails.ts's isDemoProfile(): EITHER
  -- signal makes it a demo. A row carrying a demo deadline is a demo even if the
  -- flag was dropped, and the application already treats it as one — the
  -- database must not disagree, or the flag becomes droppable after all.
  if coalesce(old.is_demo, false) is not true and old.demo_expires_at is null then
    return new;
  end if;

  -- Server-side callers do all of this legitimately. See the long note above
  -- for why this cannot be reached by a client.
  if public.is_service_role_request() then
    return new;
  end if;

  -- 1. A demo may never stop being a demo. This is the whole lockdown: every
  --    other guardrail in the app reads this flag.
  --
  --    Written as a TRANSITION rather than "new.is_demo must be true" so the
  --    odd row (is_demo false but demo_expires_at set) is not frozen solid —
  --    it can still be edited, it just cannot shed its deadline (guard 2).
  if coalesce(old.is_demo, false) is true and coalesce(new.is_demo, false) is not true then
    raise exception 'demo profiles cannot change is_demo'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. A demo may never move its own deadline — in either direction, and not to
  --    null. Expiry is enforced at USE time against this column
  --    (demoSessionGate), so a writable deadline is no deadline.
  if new.demo_expires_at is distinct from old.demo_expires_at then
    raise exception 'demo profiles cannot change demo_expires_at'
      using errcode = 'insufficient_privilege';
  end if;

  -- 3. A demo may never change the address on its own profile.
  --
  --    Nothing in the product writes profiles.email for a signed-in user — it
  --    is copied from auth.users by handle_new_user() and only ever backfilled
  --    by the seeder — so freezing it costs a demo nothing. It closes a real
  --    path: redemption recovers a half-created workspace by looking a profile
  --    up BY EMAIL (createOrRecoverDemoUser), so a demo able to write this
  --    column could point another code's derived address at its own row and be
  --    handed that code's workspace and audit trail.
  if new.email is distinct from old.email then
    raise exception 'demo profiles cannot change email'
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. THE SPEND LEDGER. lib/harness/spend.ts readState() is the only reader,
  --    and its defaulting is what makes this subtle:
  --        cap   = (typeof monthlyUsd === 'number' && > 0) ? monthlyUsd : $10
  --        spent = (typeof spentUsd  === 'number' && > 0) ? spentUsd   : 0
  --        a periodStart from another month resets spent to 0
  --    So DELETING monthlyUsd is not a reset, it is a 10x RAISE from the demo's
  --    $1 to DEFAULT_MONTHLY_USD; deleting spentUsd refills the allowance; and
  --    nudging periodStart does the same. A guard that only compared numbers
  --    would miss all three.
  --
  --    Every number is read through jsonb_typeof BEFORE the cast. `#>>` on a
  --    non-numeric value ('one dollar', an object, true) would raise
  --    invalid_text_representation, and a raise from a CAST rather than from a
  --    deliberate check is an error nobody can act on. jsonb guarantees that a
  --    value of type 'number' is a valid numeric literal, so this cast cannot
  --    fail. A missing path yields SQL NULL, and jsonb_typeof(null) is null, so
  --    absence is handled by the same expression.
  old_cap := case when jsonb_typeof(old.preferences #> '{budget,monthlyUsd}') = 'number'
                  then (old.preferences #>> '{budget,monthlyUsd}')::numeric end;
  new_cap := case when jsonb_typeof(new.preferences #> '{budget,monthlyUsd}') = 'number'
                  then (new.preferences #>> '{budget,monthlyUsd}')::numeric end;

  if old_cap is not null and old_cap > 0 then
    -- Removing it, or replacing it with something spend.ts will not read as a
    -- positive number, silently promotes the demo to the $10 default.
    if new_cap is null or new_cap <= 0 then
      raise exception 'demo profiles cannot remove their AI budget cap'
        using errcode = 'insufficient_privilege';
    end if;
    -- Lowering is still allowed, so /api/settings/budget keeps working for a
    -- demo the way it does for anyone else.
    if new_cap > old_cap then
      raise exception 'demo profiles cannot raise their AI budget cap'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new_cap is not null then
    -- The row had no cap spend.ts would honour, so its effective ceiling was
    -- already the product default. Any number written here could only move that
    -- ceiling, and we have nothing to compare against — refuse, and let the
    -- service key fix the row. Unreachable for a provisioned demo, which always
    -- carries monthlyUsd = 1.
    raise exception 'demo profiles cannot introduce an AI budget cap'
      using errcode = 'insufficient_privilege';
  end if;

  -- The ledger only ever goes up. coalesce+greatest mirrors readState()'s
  -- "number and > 0, else 0", so a demo cannot win by deleting the key or
  -- writing a negative.
  old_spent := case when jsonb_typeof(old.preferences #> '{budget,spentUsd}') = 'number'
                    then (old.preferences #>> '{budget,spentUsd}')::numeric end;
  new_spent := case when jsonb_typeof(new.preferences #> '{budget,spentUsd}') = 'number'
                    then (new.preferences #>> '{budget,spentUsd}')::numeric end;

  if greatest(coalesce(new_spent, 0), 0) < greatest(coalesce(old_spent, 0), 0) then
    raise exception 'demo profiles cannot reset their AI spend ledger'
      using errcode = 'insufficient_privilege';
  end if;

  -- Moving the billing period is the same reset by another name: readState()
  -- zeroes spentUsd whenever periodStart is not the current UTC month. Only
  -- recordSpend() (service key) ever writes it.
  if (new.preferences #> '{budget,periodStart}') is distinct from (old.preferences #> '{budget,periodStart}') then
    raise exception 'demo profiles cannot change their AI billing period'
      using errcode = 'insufficient_privilege';
  end if;

  -- 5. A demo may never CHANGE its API keys.
  --
  --    It legitimately holds a key — provisioned server-side at redemption, so
  --    that scoring and tailoring actually work — and it can never read that key
  --    back (the settings endpoints return only hasOpenai/hasAnthropic flags).
  --    What it must not do is swap in key material of its own, which would turn
  --    the owner's workspace into an outbound channel the owner never
  --    authorised, or clear it to force a fallback path.
  --
  --    Whole-subtree comparison, because `api_keys` also holds the search and
  --    scraper credentials. jsonb equality is semantic, not textual, so a client
  --    that rewrites the identical object with different key order or spacing
  --    does NOT trip this — that would be a false refusal with `json`, and is
  --    the reason the column's type matters here.
  if (new.preferences -> 'api_keys') is distinct from (old.preferences -> 'api_keys') then
    raise exception 'demo profiles cannot change API keys'
      using errcode = 'insufficient_privilege';
  end if;

  -- 6. A demo may never re-point the model provider. lib/harness/llm.ts only
  --    enforces the spend cap when the provider is the metered one
  --    (`metered = provider === 'openrouter' && Boolean(userId)`); a demo that
  --    switched itself to a local provider would run UNCAPPED, and
  --    localServerBaseUrl is an attacker-controlled outbound URL besides.
  if (new.preferences -> 'provider') is distinct from (old.preferences -> 'provider') then
    raise exception 'demo profiles cannot change the model provider'
      using errcode = 'insufficient_privilege';
  end if;

  -- 7. A demo may never grant itself Gmail scopes. Sending is refused in the
  --    application too (demoSendGate), but that check is downstream of flags;
  --    this one is not.
  if (new.preferences -> 'gmail_permissions') is distinct from (old.preferences -> 'gmail_permissions') then
    raise exception 'demo profiles cannot change Gmail permissions'
      using errcode = 'insufficient_privilege';
  end if;

  -- 8. …and may not reach the same grant through the back door.
  --
  --    parseGmailPermissions() falls back to INFERRING an enabled `monitor`
  --    grant from `gmail_sync` history whenever no gmail_permissions block is
  --    stored (the legacy-migration path). Guard 7 stops the block being
  --    deleted from a provisioned demo, but a row that never got one would let
  --    a written `gmail_sync` mint `monitor` from nothing. A demo signs in by
  --    server-minted magic link and therefore never has a Google
  --    provider_token, so it has no legitimate reason to write this key at all.
  if (new.preferences -> 'gmail_sync') is distinct from (old.preferences -> 'gmail_sync') then
    raise exception 'demo profiles cannot change Gmail sync state'
      using errcode = 'insufficient_privilege';
  end if;

  -- 9. Nothing may become self-arming. Both of these are already false for a
  --    provisioned demo and both are refused elsewhere — demoSendGate for
  --    sending, AUTO_SUBMIT_AVAILABLE for submitting — but "already refused
  --    elsewhere" is exactly the argument that was true of is_demo. Only the
  --    transition INTO true is blocked, so the rest of the outreach and
  --    autopilot settings stay editable and the demo still behaves like the
  --    product.
  if (new.preferences #> '{outreach,autoSend}') is not distinct from 'true'::jsonb
     and (old.preferences #> '{outreach,autoSend}') is distinct from 'true'::jsonb then
    raise exception 'demo profiles cannot enable auto-send'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.preferences #> '{autopilot,autoSubmit}') is not distinct from 'true'::jsonb
     and (old.preferences #> '{autopilot,autoSubmit}') is distinct from 'true'::jsonb then
    raise exception 'demo profiles cannot enable auto-submit'
      using errcode = 'insufficient_privilege';
  end if;

  -- 10. …and the same arming written at the TOP LEVEL of preferences, which is
  --     a different location from guard 9 and was reachable while guard 9 was
  --     not. app/(app)/queue/page.tsx reads exactly this:
  --         autoSubmit: p.autoSubmit === true || p.autoApply === true
  --     off the root of `preferences`, not out of the `autopilot` block. Both
  --     spellings are one guard because they are one OR in one expression:
  --     either key alone turns that read true.
  --
  --     NOTHING SUBMITS TODAY — lib/automation/capabilities.ts pins
  --     AUTO_SUBMIT_AVAILABLE = false and lib/harness/autopilot.ts hardcodes its
  --     own `const autoSubmit = false` independently, so the worst this key can
  --     currently do is make the queue banner claim applications are going out
  --     when they are not. It is guarded anyway, for the reason guard 9 gives:
  --     "already refused elsewhere" was the exact argument that was true of
  --     is_demo. When the submission engine lands, the day this key starts
  --     meaning something must not also be the day a demo can set it.
  if ((new.preferences #> '{autoSubmit}') is not distinct from 'true'::jsonb
      and (old.preferences #> '{autoSubmit}') is distinct from 'true'::jsonb)
     or ((new.preferences #> '{autoApply}') is not distinct from 'true'::jsonb
      and (old.preferences #> '{autoApply}') is distinct from 'true'::jsonb) then
    raise exception 'demo profiles cannot enable top-level auto-submit'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- `of (...)` lists every column the function above reads from NEW or OLD.
--
-- It is a blast-radius control, not an optimisation: an UPDATE that does not
-- mention any of these columns — the résumé upload route writing resume_text,
-- say — never enters the function at all, so a future bug in it cannot reach
-- writes it has no opinion about. It cannot weaken the lockdown, because a
-- column absent from the SET list cannot change.
--
-- KEEP THIS LIST IN SYNC WITH THE FUNCTION BODY. lib/access/lockdown.test.ts
-- fails if a guarded column is missing from it.
drop trigger if exists enforce_demo_profile_lockdown on public.profiles;
create trigger enforce_demo_profile_lockdown
  before update of is_demo, demo_expires_at, email, preferences on public.profiles
  for each row
  execute function public.enforce_demo_profile_lockdown();

-- ---------------------------------------------------------------------------
-- A demo must not be able to mint further access codes.
-- ---------------------------------------------------------------------------
-- access_codes' insert policy is `with check (auth.uid() = owner_user_id)`,
-- which a demo satisfies for itself — so demo-to-demo chaining is refused only
-- by an application check today (app/api/access-codes/route.ts, which inserts
-- with the caller's own RLS client and therefore passes through this trigger).
-- Move it to the database as well.
--
-- SECURITY DEFINER here, unlike the trigger above, and for a reason: this must
-- read a row the caller may not be able to see. Under RLS an invoker-rights
-- lookup that returns nothing is indistinguishable from "not a demo", and this
-- guard would fail OPEN. There is deliberately NO service-role exemption
-- either: no server-side path issues a code on a demo's behalf, so the
-- restriction is absolute.
create or replace function public.forbid_demo_access_code_issue()
returns trigger
language plpgsql
security definer
-- Empty rather than `public`: with SECURITY DEFINER, anything resolvable
-- through a mutable search path is resolved with the owner's rights. Every
-- name below is schema-qualified instead.
set search_path = ''
as $$
begin
  -- Same two-signal demo test as the lockdown, for the same reason.
  if exists (
    select 1 from public.profiles p
    where p.id = new.owner_user_id
      and (coalesce(p.is_demo, false) is true or p.demo_expires_at is not null)
  ) then
    raise exception 'demo profiles cannot issue access codes'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists forbid_demo_access_code_issue on public.access_codes;
create trigger forbid_demo_access_code_issue
  before insert on public.access_codes
  for each row
  execute function public.forbid_demo_access_code_issue();

-- resolveDemoContext() looks a code up by demo_user_id on every audited
-- request; only owner_user_id was indexed.
create index if not exists access_codes_demo_user_idx
  on public.access_codes (demo_user_id) where demo_user_id is not null;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "The migration applied but the guard is not actually attached" is a silent
-- failure that looks exactly like success, and this is the one control the rest
-- of the feature rests on. Prove it instead.
do $$
begin
  -- Also proves the helper's body compiles and does not raise; it is called on
  -- the first line of the lockdown's guarded path.
  if public.is_service_role_request() is null then
    raise exception 'is_service_role_request() must answer true or false, never null';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname = 'enforce_demo_profile_lockdown'
      and not tgisinternal
  ) then
    raise exception 'enforce_demo_profile_lockdown is not attached to public.profiles';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.access_codes'::regclass
      and tgname = 'forbid_demo_access_code_issue'
      and not tgisinternal
  ) then
    raise exception 'forbid_demo_access_code_issue is not attached to public.access_codes';
  end if;
end
$$;
