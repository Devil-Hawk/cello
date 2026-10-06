-- K4: heartbeats, the meter and who may read the clock's tables (migration 20261008040000).
--
-- Proves a heartbeat keeps its last success through a failure, one row per routine and person,
-- the meter adds up, a person reads their own routines and the instance's and nobody else's,
-- and anon and signed-in sessions cannot write. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/clock_heartbeats.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as a, gen_random_uuid() as b;
grant select on fx to public;
insert into auth.users (id, email) select a, 'hb-a@example.invalid' from fx union all select b, 'hb-b@example.invalid' from fx;

delete from public.clock_meter;

-- A success writes its times and counts; the meter adds its duration.
select public.start_heartbeat('roles.check', a) from fx;
select public.finish_heartbeat('roles.check', a, true, '{"boards": 3, "kept": 12}'::jsonb, null, 1500, now() + interval '6 hours') from fx;
select public.finish_heartbeat('roles.check', b, true, '{"boards": 1}'::jsonb, null, 500, now() + interval '6 hours') from fx;
select public.finish_heartbeat('owner.health', null, true, '{}'::jsonb, null, 250, now() + interval '1 day');

do $$
declare h record; f record;
begin
  select * into f from fx;
  select * into h from public.job_heartbeats where job = 'roles.check' and user_id = f.a;
  if h.succeeded_at is null or h.next_due_at is null or h.failure is not null then raise exception 'a success must write succeeded_at and next_due_at'; end if;
  if (h.found->>'kept')::int <> 12 then raise exception 'found was not kept'; end if;
  if (select count(*) from public.job_heartbeats where job = 'roles.check') <> 2 then raise exception 'one row per person'; end if;
  if (select count(*) from public.job_heartbeats where job = 'owner.health' and user_id is null) <> 1 then raise exception 'one row for the instance'; end if;
  if (select duration_ms from public.clock_meter where month = date_trunc('month', now())::date) <> 2250 then
    raise exception 'the meter should hold 2250 ms, got %', (select duration_ms from public.clock_meter);
  end if;
end $$;

-- A failure keeps the last success and the due time that was promised.
create temp table hb_before as select succeeded_at, next_due_at, found from public.job_heartbeats where job = 'roles.check' and user_id = (select a from fx);
select public.finish_heartbeat('roles.check', a, false, '{}'::jsonb, 'the board did not answer', 100, null) from fx;
do $$
declare h record; b record;
begin
  select * into h from public.job_heartbeats where job = 'roles.check' and user_id = (select a from fx);
  select * into b from hb_before;
  if h.failure is null then raise exception 'a failure must be recorded'; end if;
  if h.succeeded_at is distinct from b.succeeded_at or h.next_due_at is distinct from b.next_due_at or h.found is distinct from b.found then
    raise exception 'a failure must keep the last success, the due time and the counts';
  end if;
  if (select duration_ms from public.clock_meter where month = date_trunc('month', now())::date) <> 2350 then
    raise exception 'a failed slice still costs time';
  end if;
end $$;

-- Reading: a person sees their own rows and the instance's, never another person's.
do $$
declare f record; n_own int; n_other int; n_inst int; n_hb_other int;
begin
  select * into f from fx;
  perform set_config('request.jwt.claims', json_build_object('sub', f.a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  -- the person's other routines (the daily summary) are theirs to read too; this check names the roles.check one
  select count(*) into n_own from public.routines where user_id = f.a and command = 'roles.check';
  select count(*) into n_other from public.routines where user_id = f.b;
  select count(*) into n_inst from public.routines where user_id is null;
  select count(*) into n_hb_other from public.job_heartbeats where user_id = f.b;
  reset role;
  if n_own <> 1 then raise exception 'a person must read their own roles.check routine, got %', n_own; end if;
  if n_other <> 0 or n_hb_other <> 0 then raise exception 'a person read another person''s clock rows'; end if;
  if n_inst < 5 then raise exception 'a person must read the instance routines'; end if;
end $$;

-- Writing: no client role can.
create function pg_temp.must_be_denied(r text, q text) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  begin
    execute q;
  exception when insufficient_privilege then
    reset role;
    return;
  end;
  reset role;
  raise exception 'expected 42501 for role %, but it ran: %', r, q;
end $$;

select pg_temp.must_be_denied('anon', 'select 1 from public.routines');
select pg_temp.must_be_denied('anon', 'select 1 from public.job_heartbeats');
select pg_temp.must_be_denied('anon', 'select 1 from public.measure_runs');
select pg_temp.must_be_denied('authenticated', $q$update public.routines set enabled = false$q$);
select pg_temp.must_be_denied('authenticated', $q$insert into public.routines (command) values ('x')$q$);
select pg_temp.must_be_denied('authenticated', $q$delete from public.job_heartbeats$q$);
select pg_temp.must_be_denied('authenticated', 'select 1 from public.measure_runs');
select pg_temp.must_be_denied('authenticated', 'select public.finish_heartbeat(''x'', null, true)');

rollback;
