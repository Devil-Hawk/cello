-- Access codes: redemption, minting and revocation move into Postgres.
--
-- WHY
--   * The redemption limiter was an in-memory Map per serverless instance, so the
--     limit was per instance and reset on a cold start. note_redeem_attempt keeps
--     it in a table, one atomic upsert per attempt, keyed by an HMAC of the client
--     address (the route never sends the raw address) plus a global bucket.
--   * Redemption was a lookup, a JS check and a conditional claim across several
--     round trips. redeem_access_code locks the code row and decides in one
--     transaction, so concurrent redemptions cannot both pass the checks or both
--     create the demo: exactly one caller is told to provision (under a 2 minute
--     lease), the rest are told to retry.
--   * Owners could change their own codes straight over the Data API (extend,
--     un-revoke is blocked by a trigger, but revoking never touched the demo
--     profile). Every write to access_codes now goes through a service-role
--     function that also ends the demo session in the same transaction.
--
-- All functions: SECURITY INVOKER, empty search_path, executable by service_role
-- only. Idempotent.

-- ---------------------------------------------------------------------------
-- The cross-instance redemption limiter
-- ---------------------------------------------------------------------------
create table if not exists public.access_redeem_attempts (
  bucket text not null check (char_length(bucket) <= 64),
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket, window_start)
);

alter table public.access_redeem_attempts enable row level security;
revoke all on public.access_redeem_attempts from public, anon, authenticated;
grant all on public.access_redeem_attempts to service_role;

-- 12 attempts per client and 240 overall in each 10 minute window (the numbers
-- the in-memory limiter had). A fixed window allows a 2x burst across a window
-- boundary; that is accepted for a throttle on a ~59 bit code.
create or replace function public.note_redeem_attempt(p_client text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600);
  client_hits integer;
  global_hits integer;
begin
  if p_client is null or char_length(p_client) not between 1 and 60 then
    raise exception 'a client key is required' using errcode = '22023';
  end if;

  -- One statement: both counters move whether or not the attempt is allowed.
  with bumped as (
    insert into public.access_redeem_attempts as a (bucket, window_start, hits)
    values ('c:' || p_client, w, 1), ('global', w, 1)
    on conflict (bucket, window_start) do update set hits = a.hits + 1
    returning a.bucket, a.hits
  )
  select max(hits) filter (where bucket <> 'global'), max(hits) filter (where bucket = 'global')
    into client_hits, global_hits
  from bumped;

  return client_hits <= 12 and global_hits <= 240;
end;
$$;

create or replace function public.prune_redeem_attempts()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.access_redeem_attempts where window_start < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end;
$$;

select cron.schedule('redeem-attempts-prune', '41 * * * *', 'select public.prune_redeem_attempts()');

-- ---------------------------------------------------------------------------
-- Redemption
-- ---------------------------------------------------------------------------
alter table public.access_codes add column if not exists provisioning_until timestamptz;

-- p_hashes holds every form the typed code can be stored as: the keyed hash and
-- the legacy bare SHA-256 (rows are at most 72 hours old, so legacy acceptance
-- ends by itself). Returns
--   {status:'refused'}                              unknown code
--   {status:'refused', code_id, reason}             revoked | expired | used
--   {status:'busy'}                                 another request is provisioning
--   {status:'provision', code_id, owner_user_id, expires_at}
--   {status:'existing', code_id, owner_user_id, demo_user_id, expires_at}
-- 'used' means the code was redeemed and its workspace has since been deleted
-- (demo_user_id is nulled by the profile's on delete set null): without this a
-- deleted demo would let the same code mint a fresh allowance.
create or replace function public.redeem_access_code(p_hashes text[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c public.access_codes;
begin
  select * into c
  from public.access_codes
  where code_hash = any(p_hashes)
  order by created_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('status', 'refused');
  end if;

  if c.revoked_at is not null then
    return jsonb_build_object('status', 'refused', 'code_id', c.id, 'reason', 'revoked');
  end if;
  if c.expires_at <= now() then
    return jsonb_build_object('status', 'refused', 'code_id', c.id, 'reason', 'expired');
  end if;

  if c.demo_user_id is null then
    if c.first_redeemed_at is not null then
      return jsonb_build_object('status', 'refused', 'code_id', c.id, 'reason', 'used');
    end if;
    if c.provisioning_until is not null and c.provisioning_until > now() then
      return jsonb_build_object('status', 'busy');
    end if;
    update public.access_codes set provisioning_until = now() + interval '2 minutes' where id = c.id;
    return jsonb_build_object('status', 'provision', 'code_id', c.id,
                              'owner_user_id', c.owner_user_id, 'expires_at', c.expires_at);
  end if;

  update public.access_codes
  set redemption_count = redemption_count + 1,
      last_used_at = now(),
      first_redeemed_at = coalesce(first_redeemed_at, now())
  where id = c.id;

  return jsonb_build_object('status', 'existing', 'code_id', c.id, 'owner_user_id', c.owner_user_id,
                            'demo_user_id', c.demo_user_id, 'expires_at', c.expires_at);
end;
$$;

-- The one caller told to provision calls this once the workspace is ready.
-- False means the code stopped being redeemable in the meantime (revoked or
-- expired), and the caller refuses.
create or replace function public.finish_access_code_provisioning(p_code_id uuid, p_demo_user_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c public.access_codes;
begin
  select * into c from public.access_codes where id = p_code_id for update;
  if not found or c.revoked_at is not null or c.expires_at <= now() then
    return false;
  end if;
  -- Already finished for this same user (a slow first caller after the lease
  -- lapsed): nothing more to count.
  if c.demo_user_id is not null then
    return c.demo_user_id = p_demo_user_id;
  end if;

  update public.access_codes
  set demo_user_id = p_demo_user_id,
      provisioning_until = null,
      redemption_count = redemption_count + 1,
      last_used_at = now(),
      first_redeemed_at = coalesce(first_redeemed_at, now())
  where id = p_code_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Minting and revoking
-- ---------------------------------------------------------------------------
create or replace function public.mint_access_code(
  p_owner_id uuid,
  p_code_hash text,
  p_code_prefix text,
  p_label text,
  p_expires_at timestamptz
)
returns setof public.access_codes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  live_cap constant integer := 25;
  daily_cap constant integer := 100;
  live_count integer;
  recent_count integer;
  owner_is_demo boolean;
begin
  select (coalesce(p.is_demo, false) or p.demo_expires_at is not null)
    into owner_is_demo
  from public.profiles p where p.id = p_owner_id;
  -- Fail closed: an unreadable owner cannot be shown not to be a demo.
  if owner_is_demo is null or owner_is_demo then
    raise exception 'demo profiles cannot issue access codes' using errcode = 'insufficient_privilege';
  end if;

  if p_code_hash is null or p_code_hash !~ '^h1:[0-9a-f]{64}$' then
    raise exception 'an access code must be stored as a keyed hash' using errcode = '22023';
  end if;
  if p_code_prefix is null or char_length(p_code_prefix) not between 1 and 8 then
    raise exception 'invalid code prefix' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'an access code must expire in the future' using errcode = '22023';
  end if;

  -- Serialise concurrent mints for one owner (same key the insert trigger used).
  perform pg_advisory_xact_lock(hashtextextended('access_codes:' || p_owner_id::text, 0));

  select count(*) into live_count
  from public.access_codes c
  where c.owner_user_id = p_owner_id and c.revoked_at is null and c.expires_at > now();
  if live_count >= live_cap then
    raise exception 'access code limit reached: % live codes', live_cap using errcode = 'check_violation';
  end if;

  select count(*) into recent_count
  from public.access_codes c
  where c.owner_user_id = p_owner_id and c.created_at > now() - interval '24 hours';
  if recent_count >= daily_cap then
    raise exception 'access code limit reached: % codes in 24 hours', daily_cap using errcode = 'check_violation';
  end if;

  return query
  insert into public.access_codes (owner_user_id, code_hash, code_prefix, label, expires_at)
  values (p_owner_id, p_code_hash, p_code_prefix, p_label, least(p_expires_at, now() + interval '72 hours'))
  returning *;
end;
$$;

-- Turns a code off AND ends the demo session it opened, in one transaction.
-- Returns {found, revoked, demo_user_id}: found is false for an id that is not
-- this owner's (nothing is learned about other owners' codes); revoked is false
-- when it was already off, in which case the demo is still pulled to now() so a
-- retry after a partial failure elsewhere still finishes the job.
create or replace function public.revoke_access_code(p_code_id uuid, p_owner_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  demo uuid;
  was_revoked boolean := false;
  owned boolean := false;
begin
  update public.access_codes
  set revoked_at = now()
  where id = p_code_id and owner_user_id = p_owner_id and revoked_at is null
  returning demo_user_id into demo;
  was_revoked := found;

  if not was_revoked then
    select true, c.demo_user_id into owned, demo
    from public.access_codes c where c.id = p_code_id and c.owner_user_id = p_owner_id;
    if owned is not true then
      return jsonb_build_object('found', false, 'revoked', false, 'demo_user_id', null);
    end if;
  end if;

  if demo is not null then
    -- Only ever a demo profile, never the owner's own.
    update public.profiles
    set demo_expires_at = least(coalesce(demo_expires_at, now()), now())
    where id = demo and is_demo = true;
  end if;

  return jsonb_build_object('found', true, 'revoked', was_revoked, 'demo_user_id', demo);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: no signed-in user writes access_codes any more
-- ---------------------------------------------------------------------------
drop policy if exists "owners create their access codes" on public.access_codes;
drop policy if exists "owners update their access codes" on public.access_codes;
revoke insert, update on public.access_codes from authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.note_redeem_attempt(text)',
    'public.prune_redeem_attempts()',
    'public.redeem_access_code(text[])',
    'public.finish_access_code_provisioning(uuid, uuid)',
    'public.mint_access_code(uuid, text, text, text, timestamptz)',
    'public.revoke_access_code(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('authenticated', 'public.access_codes', 'insert')
     or has_table_privilege('authenticated', 'public.access_codes', 'update')
     or has_table_privilege('authenticated', 'public.access_codes', 'delete') then
    raise exception 'authenticated must not write public.access_codes';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'access_codes' and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'a write policy remains on public.access_codes';
  end if;
  if has_function_privilege('authenticated', 'public.redeem_access_code(text[])', 'execute')
     or has_function_privilege('anon', 'public.redeem_access_code(text[])', 'execute')
     or has_function_privilege('authenticated', 'public.mint_access_code(uuid, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.revoke_access_code(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.note_redeem_attempt(text)', 'execute') then
    raise exception 'access code functions must be executable by service_role only';
  end if;
  if exists (
    select 1 from pg_proc
    where oid in ('public.redeem_access_code(text[])'::regprocedure,
                  'public.mint_access_code(uuid, text, text, text, timestamptz)'::regprocedure,
                  'public.revoke_access_code(uuid, uuid)'::regprocedure,
                  'public.note_redeem_attempt(text)'::regprocedure)
      and prosecdef
  ) then
    raise exception 'access code functions must not be security definer';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.access_redeem_attempts'::regclass) then
    raise exception 'RLS is off on public.access_redeem_attempts';
  end if;
end
$$;
