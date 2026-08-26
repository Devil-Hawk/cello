-- Demo access codes.
--
-- WHAT THIS IS FOR
--   The owner hands someone a short code. That code signs them into an
--   ISOLATED demo workspace — never the owner's account — where every feature
--   works for real against seeded data. The code stops working after 72 hours,
--   and the owner can see exactly what was done with it.
--
-- WHY A SEPARATE WORKSPACE RATHER THAN A GUEST SESSION ON THE OWNER'S ACCOUNT
--   Every table in this schema is scoped by user_id and protected by RLS on
--   auth.uid(). A guest session sharing the owner's rows would mean either
--   loosening those policies or bypassing them with the service key on every
--   read — and it would expose a real job search: the résumé, the contacts,
--   Gmail-derived interview signal, who they have applied to. A demo needs none
--   of that. Giving each code its own real auth user means RLS keeps the demo
--   separate with the policies that already exist, and "all the other features
--   work perfectly" comes for free rather than being re-implemented behind a
--   read-only shim.
--
-- SAFETY PROPERTIES THIS SCHEMA CARRIES
--   * The code itself is never stored. Only a SHA-256 hash, so a leak of this
--     table does not hand anyone a working code.
--   * Expiry is a column, not a cron job: validation compares against now(), so
--     a code is dead the moment it expires even if nothing swept it up.
--   * Revocation is immediate and independent of expiry.
--   * Every event is retained after the code expires — the owner asked to see
--     what someone did with a particular code, and that question is usually
--     asked AFTER the code has lapsed.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- access_codes
-- ---------------------------------------------------------------------------

create table if not exists public.access_codes (
    id uuid primary key default gen_random_uuid(),

    -- Who issued it. Deleting the owner removes their codes.
    owner_user_id uuid not null references public.profiles(id) on delete cascade,

    -- SHA-256 of the plaintext code, hex encoded. Never the code itself.
    code_hash text not null unique,

    -- First few characters, retained so the owner can tell codes apart in a
    -- list without the full secret being recoverable.
    code_prefix text not null,

    -- Free-text note from the owner: "for the Acme interview", "投resume demo".
    label text,

    -- The demo workspace this code signs into. Null until first redemption —
    -- the workspace is created lazily so an unused code costs nothing.
    demo_user_id uuid references public.profiles(id) on delete set null,

    created_at timestamptz not null default now(),
    -- 72 hours after issue by default; the app sets this explicitly.
    expires_at timestamptz not null,
    revoked_at timestamptz,

    -- Redemption bookkeeping.
    first_redeemed_at timestamptz,
    last_used_at timestamptz,
    redemption_count integer not null default 0,

    -- Belt and braces: a code cannot be created already-expired.
    constraint access_codes_expiry_after_creation check (expires_at > created_at)
);

create index if not exists access_codes_owner_idx
    on public.access_codes (owner_user_id, created_at desc);

-- Redemption looks a code up by hash on every sign-in attempt.
create index if not exists access_codes_hash_idx
    on public.access_codes (code_hash);

-- ---------------------------------------------------------------------------
-- access_code_events — the audit trail
-- ---------------------------------------------------------------------------

create table if not exists public.access_code_events (
    id uuid primary key default gen_random_uuid(),

    -- Kept even after the code row is gone would be ideal, but a dangling audit
    -- trail nobody can attribute is worse than no trail. Cascade, and rely on
    -- codes being retained rather than deleted (revoke, don't delete).
    code_id uuid not null references public.access_codes(id) on delete cascade,

    occurred_at timestamptz not null default now(),

    -- 'redeemed' | 'page_view' | 'action' | 'denied'
    kind text not null,

    -- What they did, in the app's own vocabulary: 'jobs.score_batch',
    -- 'resume.tailor', 'outreach.draft', 'copilot.run'. Human-readable on
    -- purpose — this is read by a person, not queried by a machine.
    action text not null,

    -- Route or object touched, when meaningful.
    target text,

    -- Small structured extras. Must never carry anything sensitive.
    detail jsonb not null default '{}'::jsonb,

    -- Coarse client attribution. Deliberately NOT a full IP: the owner needs to
    -- distinguish two people sharing a code, not to track anyone.
    client_hint text
);

create index if not exists access_code_events_code_idx
    on public.access_code_events (code_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Demo workspace marking on profiles
-- ---------------------------------------------------------------------------

-- A demo profile must be identifiable from the profile alone, because the
-- guardrails that key off it (a tiny AI budget, no real outreach sending) run
-- deep inside request handling where the access code is not in scope.
alter table public.profiles
    add column if not exists is_demo boolean not null default false;

alter table public.profiles
    add column if not exists demo_expires_at timestamptz;

create index if not exists profiles_demo_idx
    on public.profiles (is_demo) where is_demo;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.access_codes enable row level security;
alter table public.access_code_events enable row level security;

-- Owners manage their own codes. A demo user must never see the codes table:
-- it would let them enumerate or extend their own access.
drop policy if exists "owners read their access codes" on public.access_codes;
create policy "owners read their access codes"
    on public.access_codes for select
    using (auth.uid() = owner_user_id);

drop policy if exists "owners create their access codes" on public.access_codes;
create policy "owners create their access codes"
    on public.access_codes for insert
    with check (auth.uid() = owner_user_id);

drop policy if exists "owners update their access codes" on public.access_codes;
create policy "owners update their access codes"
    on public.access_codes for update
    using (auth.uid() = owner_user_id)
    with check (auth.uid() = owner_user_id);

drop policy if exists "owners delete their access codes" on public.access_codes;
create policy "owners delete their access codes"
    on public.access_codes for delete
    using (auth.uid() = owner_user_id);

-- Events are readable only by the owner of the code they belong to. There is
-- deliberately NO insert policy: events are written server-side with the
-- service key, so a demo session cannot forge or suppress its own audit trail.
drop policy if exists "owners read events for their codes" on public.access_code_events;
create policy "owners read events for their codes"
    on public.access_code_events for select
    using (
        exists (
            select 1 from public.access_codes c
            where c.id = access_code_events.code_id
              and c.owner_user_id = auth.uid()
        )
    );
