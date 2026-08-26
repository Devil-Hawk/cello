-- api_tokens: personal access tokens for the machine surfaces (MCP, A2A).
--
-- WHAT THIS IS FOR
--   A human signs in with a Supabase session and a cookie. A machine client —
--   an MCP host, an A2A caller polling a task — has neither, so it needs a
--   bearer credential it can hold and present on every request. This table is
--   that credential's ownership record: one row per issued token, hashed, with
--   the scopes it was minted for.
--
-- WHY THIS TABLE IS TREATED AS PRIVILEGE-BEARING (binding ruling 5, class 1)
--   Possession of the plaintext token IS the whole authority — validateToken()
--   (lib/access/tokens.ts) does nothing but look a hash up and hand back
--   whatever scopes the row carries, with no further ownership check of its
--   own. Same shape as graph_threads and apply_phase_tokens: a bare capability,
--   not user data, so this gets RLS + trigger deny for demo profiles + route
--   refusal, not the lighter demo-wipe-at-expiry treatment user-data tables get.
--
-- WHY NO INSERT/UPDATE POLICY FOR authenticated
--   Issuing a token means generating the plaintext, hashing it, and returning
--   the plaintext exactly once — none of that can happen inside a bare
--   PostgREST insert, so creation is a route (app/api/settings/tokens POST)
--   writing through the service-role admin client, which bypasses RLS
--   entirely. Revoking (setting revoked_at) and throttled last-seen tracking
--   are the same: server-side writes through the same client. With no
--   authenticated insert/update policy, PostgREST refuses both verbs outright
--   for a signed-in browser holding only its own JWT — default-deny, no
--   `using` expression to get wrong, same reasoning as graph_threads.
--
-- WHY SELECT AND DELETE ARE OWNER POLICIES
--   The settings list (GET) reads a caller's own tokens directly through their
--   cookie-scoped client — never the hash, never anything not already listed
--   in ../../app/api/settings/tokens/route.ts's column allowlist — and an
--   owner may always remove their own row outright, the same kill switch
--   access_codes gives.
--
-- THIS FILE IS SELF-CONTAINED, mirroring
-- 20260817000003_graph_threads_demo_lockdown.sql: it does not assume
-- 20260803000003's is_service_role_request() helper exists, and re-reads the
-- same two profiles columns (is_demo, demo_expires_at) directly.
--
-- WHY THE DENY TRIGGER HAS NO SERVICE-ROLE EXEMPTION
--   Nothing server-side has any legitimate reason to mint or touch a PAT for a
--   demo workspace — a demo session has no business calling MCP or A2A with a
--   long-lived bearer credential, and the route above already refuses is_demo
--   before it ever reaches a write. Same argument as
--   20260803000004_apply_credentials.sql's forbid_demo_apply_credentials():
--   "nothing has legitimate business writing this for a demo," so the refusal
--   is unconditional and there is no branch to get wrong.
--
-- PRECONDITION, same reasoning as every migration in this family: plpgsql
-- resolves column references lazily, at first FIRE rather than at apply time,
-- so a missing dependency would apply cleanly here and fail at runtime on
-- every api_tokens write instead of failing the migration itself.
do $$
begin
  perform p.is_demo, p.demo_expires_at
  from public.profiles p
  where false;
end
$$;

create table if not exists public.api_tokens (
    id uuid primary key default gen_random_uuid(),

    -- Deleting the person deletes their tokens.
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- The holder's own label: "laptop MCP", "resume bot". Never shown back
    -- with the secret — this is what tells two tokens apart in the list.
    name text not null,

    -- SHA-256 hex of the plaintext, same discipline as access_codes.code_hash.
    -- The plaintext exists in exactly one place: the create route's response.
    token_hash text not null unique,

    -- 'mcp' | 'a2a' | others as the machine surfaces that read this land.
    -- Vocabulary lives in TS (lib/access/tokens.ts), not a lookup table —
    -- same CHECK-not-FK idiom graph_threads.surface uses, for the same
    -- reason: the set is small, closed, and versioned with the code that
    -- interprets it, not with a migration.
    scopes text[] not null,

    -- NULL = no expiry. A route may still let a caller set one; the column
    -- exists so validateToken() can refuse the expired case exactly like
    -- accessCodeUsability does.
    expires_at timestamptz,

    -- Set once, by revokeToken() (lib/access/tokens.ts), through the
    -- service-role client. NULL = still live. Kept as a soft marker rather
    -- than a delete so validateToken() can tell "revoked" apart from
    -- "never existed" for whoever is holding the bearer value.
    revoked_at timestamptz,

    -- Touched by validateToken() on successful use, throttled to about once a
    -- minute (lib/access/tokens.ts) so a hot polling loop is not a write per
    -- request.
    last_used_at timestamptz,

    created_at timestamptz not null default now(),

    constraint api_tokens_name_present check (btrim(name) <> ''),
    constraint api_tokens_scopes_present check (array_length(scopes, 1) > 0)
);

-- Every settings-page list read.
create index if not exists api_tokens_user_idx
    on public.api_tokens (user_id, created_at desc);

-- validateToken() looks a bearer up by hash on every authenticated request to
-- a machine surface — the hot path this table exists to serve.
create index if not exists api_tokens_hash_idx
    on public.api_tokens (token_hash);

comment on table public.api_tokens is
  'Personal access tokens for MCP/A2A auth. Privilege-bearing (binding ruling 5): possession of the plaintext is the whole authority, so this is RLS + trigger-deny + route-refusal, not demo-wipe-at-expiry. Hash-only storage; created/revoked/touched ONLY through the service-role admin client (lib/access/tokens.ts), never by a bare PostgREST write.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- SELECT and DELETE only, own rows only. See the file header for why insert
-- and update deliberately have no policy at all rather than a `false` one.

alter table public.api_tokens enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'api_tokens'
      and policyname = 'own api_tokens select'
  ) then
    create policy "own api_tokens select"
      on public.api_tokens for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'api_tokens'
      and policyname = 'own api_tokens delete'
  ) then
    create policy "own api_tokens delete"
      on public.api_tokens for delete
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The demo lockdown, at the write itself
-- ---------------------------------------------------------------------------
-- RLS is not enough on its own: the service key bypasses policies entirely,
-- and this codebase legitimately holds one
-- (lib/harness/supabase-admin.ts createAdminClient()). This trigger runs for
-- every writer regardless.

create or replace function public.forbid_demo_api_tokens()
returns trigger
language plpgsql
-- See the file header: nothing server-side has legitimate business minting or
-- touching a PAT for a demo workspace, so there is no exemption branch to get
-- wrong. SECURITY INVOKER because reading public.profiles here needs no rights
-- beyond the caller's own — the same reasoning
-- 20260817000003_graph_threads_demo_lockdown.sql gives for its trigger.
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
    raise exception 'demo profiles cannot create or modify access tokens'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists forbid_demo_api_tokens on public.api_tokens;
create trigger forbid_demo_api_tokens
  before insert or update on public.api_tokens
  for each row
  execute function public.forbid_demo_api_tokens();

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "Applied, but the guard is not attached" looks exactly like success and
-- would leave a bearer-credential table with no demo fence beyond RLS.
do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.api_tokens'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.api_tokens';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'api_tokens') < 2 then
    raise exception 'public.api_tokens is missing its owner select/delete policies';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.api_tokens'::regclass
      and tgname = 'forbid_demo_api_tokens'
      and not tgisinternal
  ) then
    raise exception 'forbid_demo_api_tokens is not attached to public.api_tokens';
  end if;
end
$$;
