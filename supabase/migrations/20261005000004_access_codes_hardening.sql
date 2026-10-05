-- Access codes: the database enforces what the API route only asked nicely for.
--
-- The owner-scoped RLS policies on public.access_codes check only
-- `auth.uid() = owner_user_id`, so any signed-in user can talk to PostgREST
-- directly and skip the route's rules: mint codes with an expiry in 2099, mint
-- past the 25-live-code cap, un-revoke a code, extend one, hand it to another
-- demo, or delete one (which cascades to its audit events). The app's own flows
-- never do any of that: the route inserts with a 72 hour expiry under the cap,
-- revoke only sets revoked_at, and redemption bookkeeping runs with the service
-- role, which is exempt here exactly as it is in the profiles lockdown.
--
-- Triggers are SECURITY INVOKER with an empty search_path for the reason spelled
-- out on is_service_role_request(): that helper reads current_user, and a
-- definer context would make every caller look like the function owner.
--
-- Idempotent: create or replace, drop-if-exists, and a postcondition at the end.

-- ---------------------------------------------------------------------------
-- Insert: clamp what the caller asked for, refuse a flood
-- ---------------------------------------------------------------------------
create or replace function public.enforce_access_code_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Mirrors ACCESS_CODE_TTL_HOURS (apps/web/lib/access/codes.ts).
  ttl constant interval := interval '72 hours';
  live_cap constant integer := 25;   -- MAX_LIVE_CODES in app/api/access-codes/route.ts
  daily_cap constant integer := 100; -- counts revoked rows too, so mint/revoke cannot loop forever
  live_count integer;
  recent_count integer;
begin
  if public.is_service_role_request() then
    return new;
  end if;

  -- A new code is brand new: whatever lifecycle columns the caller sent are
  -- discarded, so a code cannot be born pre-redeemed, already revoked, or
  -- already attached to a demo workspace.
  new.created_at := now();
  new.expires_at := least(new.expires_at, now() + ttl);
  new.revoked_at := null;
  new.first_redeemed_at := null;
  new.last_used_at := null;
  new.redemption_count := 0;
  new.demo_user_id := null;

  -- Serialise concurrent mints for one owner so two parallel inserts cannot
  -- both read 24 and write 26.
  perform pg_advisory_xact_lock(hashtextextended('access_codes:' || new.owner_user_id::text, 0));

  select count(*) into live_count
  from public.access_codes c
  where c.owner_user_id = new.owner_user_id
    and c.revoked_at is null
    and c.expires_at > now();
  if live_count >= live_cap then
    raise exception 'access code limit reached: % live codes', live_cap
      using errcode = 'check_violation';
  end if;

  select count(*) into recent_count
  from public.access_codes c
  where c.owner_user_id = new.owner_user_id
    and c.created_at > now() - interval '24 hours';
  if recent_count >= daily_cap then
    raise exception 'access code limit reached: % codes in 24 hours', daily_cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Update: an owner may switch a code off and shorten it, nothing else
-- ---------------------------------------------------------------------------
create or replace function public.enforce_access_code_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if public.is_service_role_request() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.code_hash is distinct from old.code_hash
     or new.code_prefix is distinct from old.code_prefix
     or new.owner_user_id is distinct from old.owner_user_id
     or new.demo_user_id is distinct from old.demo_user_id
     or new.created_at is distinct from old.created_at
     or new.first_redeemed_at is distinct from old.first_redeemed_at
     or new.last_used_at is distinct from old.last_used_at
     or new.redemption_count is distinct from old.redemption_count then
    raise exception 'access codes are immutable except for label, revocation and a shorter expiry'
      using errcode = 'insufficient_privilege';
  end if;

  -- null -> not null is a revoke. Anything else is a resurrection or a rewrite
  -- of the record of when access stopped.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked access code cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  if new.expires_at > old.expires_at then
    raise exception 'an access code cannot be extended'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- Trigger functions run without a caller EXECUTE check, so nobody needs a grant.
revoke execute on function public.enforce_access_code_insert() from public, anon, authenticated;
revoke execute on function public.enforce_access_code_update() from public, anon, authenticated;

drop trigger if exists enforce_access_code_insert on public.access_codes;
create trigger enforce_access_code_insert
  before insert on public.access_codes
  for each row
  execute function public.enforce_access_code_insert();

drop trigger if exists enforce_access_code_update on public.access_codes;
create trigger enforce_access_code_update
  before update on public.access_codes
  for each row
  execute function public.enforce_access_code_update();

-- ---------------------------------------------------------------------------
-- Delete: nobody deletes codes
-- ---------------------------------------------------------------------------
-- Revoke, don't delete: deleting a code cascades to access_code_events, which
-- is the owner's audit trail. No app code path deletes from access_codes
-- (every .from('access_codes') in apps/web is a select, insert or update), and
-- account deletion reaches the rows through the owner FK cascade, which needs
-- neither a policy nor a grant.
drop policy if exists "owners delete their access codes" on public.access_codes;
revoke delete on public.access_codes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.access_codes'::regclass
      and tgname = 'enforce_access_code_insert' and not tgisinternal
  ) then
    raise exception 'enforce_access_code_insert is not attached to public.access_codes';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.access_codes'::regclass
      and tgname = 'enforce_access_code_update' and not tgisinternal
  ) then
    raise exception 'enforce_access_code_update is not attached to public.access_codes';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'access_codes' and cmd = 'DELETE'
  ) then
    raise exception 'a DELETE policy still exists on public.access_codes';
  end if;
end
$$;
