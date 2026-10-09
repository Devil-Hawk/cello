-- K7: the register and the measures computed from the database (migration 20261008045000).
--
-- Proves every measure of 13.1 is seeded as watch, run_measure('T5') writes a failing row when a
-- person's last successful check is 8 hours old and a passing one when it is fresh, T4 counts the
-- followed employers that cannot be read, the known failures are pinned, and a measure with no
-- function cannot be run. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/clock_measures.sql

\set ON_ERROR_STOP 1
begin;

-- The register.
do $$
declare ids text[];
begin
  if (select count(*) from public.measures) <> 68 then
    raise exception 'expected 68 measures, got %', (select count(*) from public.measures);
  end if;
  if exists (select 1 from public.measures where state <> 'watch') then raise exception 'every measure must start as watch'; end if;
  if (select count(*) from public.measures where layer = 'true') <> 33
     or (select count(*) from public.measures where layer = 'step') <> 26
     or (select count(*) from public.measures where layer = 'person') <> 9 then
    raise exception 'wrong layer counts';
  end if;
  if (select gates from public.measures where id = 'T5') <> array['K4'] then raise exception 'T5 must gate K4'; end if;
  if (select gates from public.measures where id = 'S2') <> array['K5c', 'K15b'] then raise exception 'S2 must gate K5c and K15b'; end if;
end $$;

-- The known failures of 13.4 are pinned.
do $$ begin
  if (select count(*) from public.measure_runs where note like 'Pinned 2026-10-05:%' and measure_id in ('S4', 'S1', 'T5') and passed = false) <> 3 then
    raise exception 'S4, S1 and T5 must each carry a pinned failing run';
  end if;
end $$;

-- T5: hours since the last successful role check.
create temp table fx as select gen_random_uuid() as a;
grant select on fx to public;
insert into auth.users (id, email) select a, 'measure-a@example.invalid' from fx;
delete from public.routines where command = 'roles.check' and user_id <> (select a from fx);
delete from public.job_heartbeats where job = 'roles.check';

select public.finish_heartbeat('roles.check', a, true, '{}'::jsonb, null, 100, now() + interval '6 hours') from fx;
update public.job_heartbeats set succeeded_at = now() - interval '8 hours' where job = 'roles.check';

create temp table runs (k text, measure_id text, value numeric, passed boolean, sample_n integer, note text);
insert into runs select 'stale', measure_id, value, passed, sample_n, note from public.run_measure('T5');
update public.job_heartbeats set succeeded_at = now() - interval '1 hour' where job = 'roles.check';
insert into runs select 'fresh', measure_id, value, passed, sample_n, note from public.run_measure('T5');

do $$
declare s record; f record;
begin
  select * into s from runs where k = 'stale';
  select * into f from runs where k = 'fresh';
  if s.passed is not false or s.value < 7.9 or s.value > 8.1 then raise exception 'T5 must fail at 8 hours, got % %', s.value, s.passed; end if;
  if f.passed is not true or f.value > 1.1 then raise exception 'T5 must pass at 1 hour, got % %', f.value, f.passed; end if;
  if (select count(*) from public.measure_runs where measure_id = 'T5' and note not like 'Pinned%') <> 2 then
    raise exception 'each run must write a measure_runs row';
  end if;
end $$;

-- A person who has never had a successful check counts from when their routine was created.
update public.job_heartbeats set succeeded_at = null where job = 'roles.check';
update public.routines set created_at = now() - interval '9 hours' where command = 'roles.check' and user_id = (select a from fx);
do $$ begin
  if (select passed from public.measure_t5()) is not false then raise exception 'a person never checked, nine hours on, must fail T5'; end if;
end $$;

-- T4: followed employers that cannot be read.
insert into public.companies (user_id, name, career_url, metadata)
select a, 'Readable', 'https://readable.example.invalid/jobs', '{"source_check": {"readable": true, "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb from fx
union all select a, 'Unreadable', 'https://unreadable.example.invalid/jobs', '{"source_check": {"readable": false, "reason": "bot_check", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb from fx
union all select a, 'Browser', 'https://browser.example.invalid/jobs', '{"source_check": {"readable": false, "reason": "reading", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb from fx
union all select a, 'A lead', 'https://lead.example.invalid/jobs', '{"suggested": true, "source_check": {"readable": false, "reason": "robots", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb from fx;
do $$
declare t record;
begin
  select * into t from public.measure_t4();
  if t.sample_n <> 3 then raise exception 'a lead is not a followed employer: expected 3, got %', t.sample_n; end if;
  if t.value <> 33.33 or t.passed is not false then raise exception 'one of three unreadable is 33.33 percent and fails, got % %', t.value, t.passed; end if;
end $$;

-- Every measure of the true layer that has a function runs, and one that cannot run is a failing row, not a gap.
do $$
declare n integer; ids text[];
begin
  select count(*), array_agg(measure_id order by measure_id) into n, ids from public.run_true_measures();
  -- K4's measures and every later package's: the ones with a function run, in id order
  if not (ids @> array['T18', 'T4', 'T5', 'T8']) or exists (select 1 from unnest(ids) i where i not in (select id from public.measures where layer = 'true')) then
    raise exception 'run_true_measures ran %', ids;
  end if;
end $$;

-- A measure with no function cannot be run by name.
do $$
begin
  begin
    perform public.run_measure('T1');
    raise exception 'run_measure(T1) must refuse: it has no function yet';
  exception when undefined_function then
    null;
  end;
end $$;

-- T8 reports the database size against 350 MB.
do $$
declare t record;
begin
  select * into t from public.measure_t8();
  if t.value is null or t.passed is not true then raise exception 'a small database must pass T8, got % %', t.value, t.passed; end if;
end $$;

rollback;
