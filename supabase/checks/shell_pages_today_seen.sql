-- Proves migration 20261024950000: touch_today_seen() returns the time before
-- the call (null the first time), stamps the time of the call, leaves another
-- person's row alone, and cannot be run by anon. One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/shell_pages_today_seen.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as me, gen_random_uuid() as other;
insert into auth.users (id, email) select me, 'today-seen-me@example.invalid' from fx;
insert into auth.users (id, email) select other, 'today-seen-other@example.invalid' from fx;
insert into public.profiles (id, email) select me, 'today-seen-me@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select other, 'today-seen-other@example.invalid' from fx on conflict (id) do nothing;

-- The person calls it twice. What each call returned is kept in settings, so the
-- rows can be read afterwards with full rights (RLS would hide another person's row).
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', me)::text, true) from fx;
set local role authenticated;
select set_config('chk.first', coalesce(public.touch_today_seen()::text, 'null'), true);
select set_config('chk.second', coalesce(public.touch_today_seen()::text, 'null'), true);
reset role;

do $$
declare f record; stamped timestamptz; theirs timestamptz;
begin
  select * into f from fx;

  if current_setting('chk.first') <> 'null' then
    raise exception 'the first call returned %, expected null', current_setting('chk.first');
  end if;

  select today_seen_at into stamped from public.profiles where id = f.me;
  if stamped is null then raise exception 'the calls did not stamp the time'; end if;

  -- Both calls ran in this transaction, so now() is one value: the second call
  -- must hand back the time the first one stamped.
  if current_setting('chk.second')::timestamptz is distinct from stamped then
    raise exception 'the second call returned %, expected the first call''s time %', current_setting('chk.second'), stamped;
  end if;

  select today_seen_at into theirs from public.profiles where id = f.other;
  if theirs is not null then raise exception 'another person''s row was touched'; end if;
end $$;

set local role anon;
do $$
begin
  begin
    perform public.touch_today_seen();
    raise exception 'anon ran touch_today_seen()';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

\echo shell_pages_today_seen: ok
rollback;
