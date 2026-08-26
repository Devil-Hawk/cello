-- Employer-board credentials the user ALREADY HOLDS.
--
-- WHAT THIS IS FOR
--   Many employer boards — Workday above all — will not accept an application
--   without an account on that specific employer's tenant. The user already has
--   those accounts. This table holds the sign-in they type in once, encrypted,
--   so the apply engine can authenticate AS THEM on a board they already belong
--   to instead of making them sign in 200 times a week.
--
--   OUT OF SCOPE, DELIBERATELY AND PERMANENTLY: creating accounts on third-party
--   sites, solving CAPTCHAs, or evading a site that has decided to refuse
--   automation. When a board needs a new account or throws a challenge, the
--   application becomes a prefilled handoff for the human. Nothing in this
--   schema is shaped to support anything else.
--
-- WHY THIS IS NOT "JUST ANOTHER API KEY TABLE"
--   An API key is scoped to one product and can be rotated in thirty seconds.
--   A board password is, in practice, a person's ACTUAL password — frequently
--   the same one they use for their email — and rotating it means remembering
--   every place it was reused. The blast radius of losing one row here is a
--   person's life, not one integration. Three consequences run through this
--   file:
--
--     1. THERE IS NO PLAINTEXT COLUMN, and the database refuses to store
--        anything that is not ciphertext (see the check constraint). "We
--        forgot to encrypt on one code path" is the single most common way
--        this class of table leaks, and it is checked here rather than
--        trusted to the application.
--     2. NOTHING READS THE SECRET BACK TO A HUMAN. The application never
--        selects encrypted_secret except on the server path that is about to
--        authenticate (lib/apply/vault.ts resolveCredentialFor); the list view
--        selects label/username/host only. This file cannot enforce that on
--        its own, but see the RLS note about why a leak of the row is still
--        not a leak of the password.
--     3. A DEMO PROFILE MAY NEVER TOUCH THIS TABLE AT ALL — not read, not
--        write, not for its own rows. Refused in the policy AND in a trigger
--        AND in lib/apply/vault.ts, for the reasons 20260803000003 spells out
--        about which of those an attacker gets to stand downstream of.
--
-- WHAT ENCRYPTION AT REST DOES AND DOES NOT BUY
--   lib/crypto.ts encrypts with aes-256-gcm under API_ENCRYPTION_KEY, which
--   lives in the deployment's environment and NOT in this database. So a dump
--   of this table alone yields nothing. Anyone holding BOTH the database and
--   that env var can read every password in it — which is the honest thing the
--   settings card says out loud, and the reason it recommends a dedicated
--   job-search account over a reused password.
--
--   lib/crypto.ts also SILENTLY FALLS BACK to a key derived from
--   NEXT_PUBLIC_SUPABASE_URL when API_ENCRYPTION_KEY is unset. That value ships
--   to every browser, so under the fallback "encrypted" means "obfuscated with
--   a published key". lib/apply/vault.ts detects that state and REFUSES TO
--   WRITE rather than producing a row that looks safe and is not. The check
--   constraint below cannot tell the two apart — both produce well-formed
--   ciphertext — which is exactly why the refusal has to live in the writer.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- PRECONDITION
-- ---------------------------------------------------------------------------
-- Same reasoning as 20260803000003: plpgsql resolves column references lazily,
-- so a missing dependency would apply cleanly here and then fail at runtime on
-- every insert. The demo columns arrive with 20260803000002 and the guard
-- function below reads both of them.
do $$
begin
  perform p.is_demo, p.demo_expires_at
  from public.profiles p
  where false;
end
$$;

-- ---------------------------------------------------------------------------
-- apply_credentials
-- ---------------------------------------------------------------------------

create table if not exists public.apply_credentials (
    id uuid primary key default gen_random_uuid(),

    -- Whose credential. Deleting the person deletes their vault.
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- THE BOARD IDENTITY, and the thing resolution matches on.
    --
    -- Stored as a bare, normalised host: lowercase, no scheme, no port, no
    -- path, no trailing dot ('acme.wd5.myworkdayjobs.com').
    --
    -- MATCHING IS EXACT, NEVER BY SUFFIX, and this column's shape is what makes
    -- that possible. Every Workday customer is a subdomain of the SAME apex —
    -- see lib/ats/workday.ts: {tenant}.wd{N}.myworkdayjobs.com — so a resolver
    -- that walked up to the registrable domain would answer "the user has a
    -- credential for myworkdayjobs.com" and hand employer A's password to
    -- employer B's sign-in form. The host is the whole identity precisely
    -- because it is the only part that distinguishes them.
    host text not null,

    -- Optional ATS family ('workday', 'greenhouse', …), for the case where the
    -- caller knows the provider but not the exact host. Never sufficient on its
    -- own to pick between two employers on the same provider — see
    -- lib/apply/vault.ts for how a provider-only lookup is resolved and why it
    -- refuses when it is ambiguous.
    provider text,

    -- The user's own name for this account: "Acme careers", "Workday — Beta".
    label text not null,

    -- The username or email they sign in with. Stored in the clear ON PURPOSE:
    -- the settings list has to show WHICH account is stored, and a person who
    -- cannot tell their two accounts apart will delete the wrong one. It is
    -- PII, not a secret — the secret is the next column, and only that one.
    username text not null,

    -- lib/crypto.ts encrypt() output, always: base64(iv):base64(authTag):base64(ct).
    --
    -- THERE IS NO PLAINTEXT COLUMN AND THERE NEVER WILL BE. The check below is
    -- structural, not cosmetic: aes-256-gcm here uses a 16-byte IV and a
    -- 16-byte auth tag, each of which base64-encodes to exactly 22 alphabet
    -- characters followed by '=='. A password typed by a human cannot match
    -- that by accident, so an INSERT that forgot to encrypt fails loudly at
    -- the database instead of silently storing a password in the clear.
    --
    -- The ciphertext segment is deliberately permissive ([...]{4,} over the
    -- full base64 alphabet including '='): Node emits it as two concatenated
    -- chunks (cipher.update + cipher.final) and pinning its internal shape
    -- would turn a Node encoding detail into a failed save. All the
    -- discriminating power is in the two fixed-width segments.
    --
    -- If lib/crypto.ts ever changes IV or tag length this constraint starts
    -- rejecting writes. That is the correct direction to fail: a save that
    -- errors is recoverable, a password stored under an unexpected scheme is
    -- not.
    encrypted_secret text not null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Stamped by lib/apply/vault.ts every time the secret is actually decrypted
    -- for an authentication attempt. It is the only visibility the owner gets
    -- into what their vault is being used for, so it is written on RESOLVE, not
    -- on a successful sign-in — "this password left the database" is the event
    -- worth recording, and it happens whether or not the board then accepted it.
    last_used_at timestamptz,

    constraint apply_credentials_secret_is_encrypted check (
        encrypted_secret ~ '^[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/=]{4,}$'
    ),
    -- Normalisation is the application's job (lib/apply/vault.ts normalizeHost),
    -- but a host that skipped it would silently never match on resolve, so the
    -- database refuses the shapes that could only be a normalisation bug.
    constraint apply_credentials_host_normalised check (
        host = lower(host)
        and host <> ''
        and host not like '%/%'
        and host not like '%:%'
        and host not like '%.'
        and length(host) <= 253
    ),
    constraint apply_credentials_label_present check (btrim(label) <> ''),
    constraint apply_credentials_username_present check (btrim(username) <> ''),
    constraint apply_credentials_provider_normalised check (
        provider is null or (provider = lower(provider) and btrim(provider) <> '')
    ),

    -- ONE ROW PER BOARD IDENTITY. Two accounts on the same host is a real case
    -- (a personal address and a university one), so the username is part of the
    -- key rather than the host alone — and re-saving the same account is then
    -- an update of that row rather than a second copy of the same password.
    constraint apply_credentials_one_per_identity unique (user_id, host, username)
);

-- Resolution is always "this user, this host".
create index if not exists apply_credentials_user_host_idx
    on public.apply_credentials (user_id, host);

-- Provider-only lookups, which are rarer and always narrowed by user first.
create index if not exists apply_credentials_user_provider_idx
    on public.apply_credentials (user_id, provider) where provider is not null;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
-- public.update_updated_at() already exists (20240131000002); reuse it rather
-- than defining a second one that could drift.
drop trigger if exists apply_credentials_updated_at on public.apply_credentials;
create trigger apply_credentials_updated_at
    before update on public.apply_credentials
    for each row execute procedure public.update_updated_at();

-- ---------------------------------------------------------------------------
-- Is the caller a demo workspace?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, and this is the one place in this file that needs to be.
--
-- The policies below have to answer "is this profile a demo?" from inside an
-- RLS check. An invoker-rights subquery against public.profiles is itself
-- subject to profiles' own RLS, and a row that RLS hides is indistinguishable
-- from a row that says `is_demo = false`. That difference decides whether a
-- demo session can read a vault of passwords, so it cannot be left to whichever
-- policy happens to be in force on another table.
--
-- FAILS CLOSED: a profile that cannot be found at all answers TRUE ("treat as a
-- demo"), so an unresolvable caller is denied rather than admitted. The FK on
-- user_id means this is unreachable for a real row; it is the answer for
-- auth.uid() being null (an unauthenticated request), where denying is right.
--
-- Same two-signal test as lib/access/guardrails.ts isDemoProfile(): EITHER the
-- flag or a demo deadline makes it a demo. A row that shed the flag but kept
-- the deadline must not become a normal account, here least of all.
create or replace function public.profile_is_demo(target uuid)
returns boolean
language sql
stable
security definer
-- Empty search_path: under SECURITY DEFINER anything resolvable through a
-- mutable path resolves with the OWNER's rights. Every name below is
-- schema-qualified.
set search_path = ''
as $$
    select not exists (
        select 1
        from public.profiles p
        where p.id = target
          and coalesce(p.is_demo, false) is false
          and p.demo_expires_at is null
    );
$$;

-- The policies are SECURITY INVOKER, so the caller needs EXECUTE. It discloses
-- only whether the caller's own workspace is a demo — something the caller
-- already knows.
grant execute on function public.profile_is_demo(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Owner-scoped on every verb, exactly like access_codes, PLUS a demo exclusion
-- on every verb including SELECT.
--
-- WHY SELECT IS FENCED TOO, when a demo's own rows can never exist: a policy
-- that only fenced writes would be one accidental service-key insert away from
-- a readable demo vault, and "a demo can list credentials" is a metadata leak
-- (which employers this person has accounts with) even before any secret is
-- involved. The restriction costs a demo nothing — the feature is not part of
-- the demo — so there is no reason for it to be anything but absolute.

alter table public.apply_credentials enable row level security;

drop policy if exists "owners read their apply credentials" on public.apply_credentials;
create policy "owners read their apply credentials"
    on public.apply_credentials for select
    using (auth.uid() = user_id and not public.profile_is_demo(auth.uid()));

drop policy if exists "owners create their apply credentials" on public.apply_credentials;
create policy "owners create their apply credentials"
    on public.apply_credentials for insert
    with check (auth.uid() = user_id and not public.profile_is_demo(auth.uid()));

drop policy if exists "owners update their apply credentials" on public.apply_credentials;
create policy "owners update their apply credentials"
    on public.apply_credentials for update
    using (auth.uid() = user_id and not public.profile_is_demo(auth.uid()))
    with check (auth.uid() = user_id and not public.profile_is_demo(auth.uid()));

-- Deletion is the user's only way to take a password back out of this system,
-- so it is never gated on anything but ownership and the demo exclusion.
drop policy if exists "owners delete their apply credentials" on public.apply_credentials;
create policy "owners delete their apply credentials"
    on public.apply_credentials for delete
    using (auth.uid() = user_id and not public.profile_is_demo(auth.uid()));

-- ---------------------------------------------------------------------------
-- The demo lockdown, at the write itself
-- ---------------------------------------------------------------------------
-- RLS is not enough on its own: the service key bypasses policies entirely, and
-- this codebase legitimately holds one (lib/harness/supabase-admin.ts). This
-- trigger runs for every writer.
--
-- THERE IS DELIBERATELY NO SERVICE-ROLE EXEMPTION, unlike
-- 20260803000003's profile lockdown. That file had to exempt the server because
-- redemption genuinely provisions demo profiles. Nothing — no route, no cron,
-- no seeder — has any business writing an employer password onto a demo
-- workspace, so the refusal is unconditional and there is no branch to get
-- wrong.
create or replace function public.forbid_demo_apply_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.profile_is_demo(new.user_id) then
    raise exception 'demo workspaces cannot store employer credentials'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists forbid_demo_apply_credentials on public.apply_credentials;
create trigger forbid_demo_apply_credentials
  before insert or update on public.apply_credentials
  for each row
  execute function public.forbid_demo_apply_credentials();

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "Applied, but the guard is not attached" looks exactly like success and would
-- leave a table of passwords with no demo fence and possibly no RLS at all.
-- Prove it instead — the same belt-and-braces 20260803000003 ends with.
do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.apply_credentials'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.apply_credentials';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'apply_credentials') < 4 then
    raise exception 'public.apply_credentials is missing owner-scoped policies';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.apply_credentials'::regclass
      and tgname = 'forbid_demo_apply_credentials'
      and not tgisinternal
  ) then
    raise exception 'forbid_demo_apply_credentials is not attached to public.apply_credentials';
  end if;

  -- The guard must answer, and must answer TRUE for an unknown profile — the
  -- fail-closed direction every policy above depends on.
  if public.profile_is_demo('00000000-0000-0000-0000-000000000000'::uuid) is not true then
    raise exception 'profile_is_demo() must fail closed for an unknown profile';
  end if;
end
$$;
