-- Proves public.record_job_sightings() (migration 20261006000100): a posting is
-- marked closed after two consecutive refreshes of its own source that did not
-- list it, is reopened when it comes back, and is never closed by an empty
-- list, by another source's refresh, or by an aggregator's window. Runs in one
-- transaction and rolls back, so any database is safe to point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/job_lifecycle.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as company_id;
insert into auth.users (id, email) select user_id, 'lifecycle-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'lifecycle-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select company_id, user_id, 'Lifecycle Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (company_id, title, description, url, external_id, source)
select company_id, 'stays listed',   'd', 'https://x/a', 'a', 'greenhouse' from fx union all
select company_id, 'gets delisted',  'd', 'https://x/b', 'b', 'greenhouse' from fx union all
select company_id, 'from lever',     'd', 'https://x/c', 'c', 'lever'      from fx union all
select company_id, 'from remoteok',  'd', 'https://x/d', 'd', 'remoteok'   from fx;

create function pg_temp.st(p_ext text) returns table (still_open boolean, missed integer, closed boolean) as $$
  select j.still_open, j.missed_checks, j.closed_at is not null
  from public.jobs j join fx on fx.company_id = j.company_id where j.external_id = p_ext
$$ language sql;

do $$
declare f record; r jsonb; s record;
begin
  select * into f from fx;

  -- Refresh 1 lists only "a": "b" has one miss, still open.
  r := public.record_job_sightings(f.company_id, array['a'], array['greenhouse'], 2, now() + interval '1 minute');
  assert (r->>'missed')::int = 1 and (r->>'closed')::int = 0, 'one miss must not close: ' || r;
  select * into s from pg_temp.st('b');
  assert s.still_open is not false and s.missed = 1 and not s.closed, 'b: open with 1 miss';

  -- Other sources are untouched by a greenhouse refresh.
  select * into s from pg_temp.st('c'); assert s.missed = 0, 'a lever row is not a greenhouse miss';
  select * into s from pg_temp.st('d'); assert s.missed = 0, 'an aggregator row is not a greenhouse miss';

  -- Refresh 2 still misses "b": closed.
  r := public.record_job_sightings(f.company_id, array['a'], array['greenhouse'], 2, now() + interval '2 minutes');
  assert (r->>'closed')::int = 1, 'second consecutive miss closes: ' || r;
  select * into s from pg_temp.st('b');
  assert s.still_open = false and s.closed, 'b: closed with closed_at';

  -- A closed job is not counted again.
  r := public.record_job_sightings(f.company_id, array['a'], array['greenhouse'], 2, now() + interval '3 minutes');
  assert (r->>'missed')::int = 0, 'already closed rows are not missed again: ' || r;

  -- It comes back: reopened and the miss counter resets.
  r := public.record_job_sightings(f.company_id, array['a', 'b'], array['greenhouse'], 2, now() + interval '4 minutes');
  assert (r->>'reopened')::int = 1, 'b reopened: ' || r;
  select * into s from pg_temp.st('b');
  assert s.still_open = true and s.missed = 0 and not s.closed, 'b: open, reset';

  -- An empty list (a board that failed to load) closes nothing.
  r := public.record_job_sightings(f.company_id, array[]::text[], array['greenhouse'], 2, now() + interval '5 minutes');
  assert (r->>'missed')::int = 0, 'empty list is no evidence: ' || r;
  select * into s from pg_temp.st('a'); assert s.missed = 0, 'a untouched by an empty list';

  -- A sighting newer than the refresh's own clock is not undone by it.
  update public.jobs set last_seen_at = now() + interval '30 minutes' where external_id = 'a' and company_id = f.company_id;
  r := public.record_job_sightings(f.company_id, array['b'], array['greenhouse'], 2, now() + interval '10 minutes');
  select * into s from pg_temp.st('a');
  assert s.missed = 0, 'a: seen after this refresh began, so not a miss, got ' || s.missed;

  raise notice 'ALL LIFECYCLE ASSERTIONS PASSED';
end $$;
rollback;
