-- companies/measures (feature 1, PR 6): the Companies measures on the scorecard, and the route timings that one of them reads.
--
-- WHY
--   Directive 24: every capability has a named measure, a bar and a place the owner sees the number (pnpm scorecard).
--   Part 1 section 1.11 names T34 to T36 and S1 for Companies. The register already holds S1 (requirements, 20261008045000),
--   so the route-timing measure is T37: a true-layer row, run every day by run_true_measures().
--   T34 (the search ladder) is run by scripts/directory-coverage.ts --find --record when the find route lands (a later PR).
--
-- WHAT
--   route_timings   one row per call of a Companies route (lib/companies/route-timing.ts); service role only.
--   measure_t35()   browser reads of the last 7 days from render_jobs: queued, done with a verified employer, done with none, failed by class. Report.
--   measure_t36()   "Not this company" reports of the last 30 days and where each employer stands now. Report.
--   measure_t37()   share of add and follow calls of the last 7 days that end inside their bar: 60 s and 8 s, 95 percent.
--   T12             a static row: the numbers on the Companies pages and in the scorecard name their columns in the pull request.
--
-- The clock's prune deletes route_timings older than 30 days (lib/clock/routines/prune.ts).

-- ---------------------------------------------------------------------------
-- route_timings
-- ---------------------------------------------------------------------------

create table if not exists public.route_timings (
  id bigint generated always as identity primary key,
  route text not null,
  ms integer not null check (ms >= 0),
  ok boolean not null,
  at timestamptz not null default now()
);

create index if not exists route_timings_route_idx on public.route_timings (route, at);

alter table public.route_timings enable row level security;
revoke all on public.route_timings from public, anon, authenticated;
grant all on public.route_timings to service_role;
grant usage, select on sequence public.route_timings_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- The register rows (lib/measures/register.ts holds the same rows; a test keeps the two equal)
-- ---------------------------------------------------------------------------

insert into public.measures (id, layer, name, bar, direction, source, gates) values
  ('T34', 'true', 'directory search by name: the owner''s named set through the full search ladder, the right employer among the candidates with the rung that found it, every miss named with its reason', '11 of 11 named; 8 of 10 unseeded startups', 'higher', 'measure_runs from scripts/directory-coverage.ts --find --record', array['K6', 'PG11']::text[]),
  ('T35', 'true', 'browser reads of an employer''s careers page: queued, done with a verified employer, done with none, failed by class, per 7 days', 'reported; no bar until a month of numbers', 'reported', 'render_jobs', array['PG11']::text[]),
  ('T36', 'true', '"Not this company" reports and what the re-check found: where each reported employer stands now, per 30 days', 'reported', 'reported', 'employer_reports and company_directory', array['K6']::text[]),
  ('T37', 'true', 'Companies route timings: share of add calls ending or handing off within 60 s, and of follow calls with their first read ending or handing off within 8 s, per 7 days', '95 percent within each bar', 'higher', 'route_timings', array['K6']::text[])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- T4: followed employers that cannot be read. Replaces the seed's version, which read companies.metadata only: the sweep
-- records its failures on company_directory (cannot_read_reason), so a board the sweep gave up on never reached metadata.
-- ---------------------------------------------------------------------------

update public.measures set source = 'companies and company_directory (cannot_read_reason)' where id = 'T4';

create or replace function public.measure_t4()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_followed integer;
  n_cannot integer;
  n_no_reason integer;
  n_reading integer;
begin
  select count(*),
         count(*) filter (where d.cannot_read_reason is not null
                             or (c.metadata->'source_check'->>'readable' = 'false' and coalesce(c.metadata->'source_check'->>'reason', '') <> 'reading')),
         count(*) filter (where d.cannot_read_reason is null
                             and c.metadata->'source_check'->>'readable' = 'false' and coalesce(c.metadata->'source_check'->>'reason', '') = ''),
         count(*) filter (where c.metadata->'source_check'->>'reason' = 'reading')
    into n_followed, n_cannot, n_no_reason, n_reading
    from public.companies c
    left join public.company_directory d on d.id = c.employer_id
   where c.watching
     and (c.metadata->>'suggested' is null or c.metadata->>'suggested' <> 'true')
     and (nullif(btrim(coalesce(c.career_url, '')), '') is not null or c.metadata ? 'ats');
  if n_followed = 0 then
    return query select null::numeric, null::boolean, 0, 'No followed employers yet.'::text;
    return;
  end if;
  return query select
    round(100.0 * n_cannot / n_followed, 2),
    (100.0 * n_cannot / n_followed) < 5 and n_no_reason = 0,
    n_followed,
    format('%s of %s followed employers cannot be read; %s without a reason; %s waiting for a browser read.', n_cannot, n_followed, n_no_reason, n_reading);
end;
$$;

-- Self-check: three followed employers, two of them unreadable (one by the sweep's reason, one only in metadata) and one
-- readable, must fail the bar. The rows are made in a block that always rolls back. No profile, no seed: the check says so.
do $$
declare
  uid uuid;
  e1 uuid;
  e2 uuid;
  e3 uuid;
  r record;
begin
  select id into uid from public.profiles limit 1;
  if uid is null then
    raise notice 'measure_t4 self-check skipped: no profile owns the seeded companies';
    return;
  end if;
  begin
    -- the owner's own followed companies are set aside inside the block and come back on rollback
    update public.companies set watching = false;
    insert into public.company_directory (name, name_norm, source, cannot_read_reason, verified_at, careers_url) values ('Self check unreadable', 'self check unreadable', 'seed', 'cannot_read', now(), 'https://unreadable.example/careers') returning id into e1;
    insert into public.company_directory (name, name_norm, source, verified_at, careers_url) values ('Self check readable', 'self check readable', 'seed', now(), 'https://readable.example/careers') returning id into e2;
    insert into public.company_directory (name, name_norm, source, cannot_read_reason, verified_at, careers_url) values ('Self check stale', 'self check stale', 'seed', 'stale', now(), 'https://stale.example/careers') returning id into e3;
    insert into public.companies (user_id, name, career_url, employer_id, metadata) values
      (uid, 'Self check unreadable', 'https://unreadable.example/careers', e1, '{}'),
      (uid, 'Self check readable', 'https://readable.example/careers', e2, '{}'),
      (uid, 'Self check stale', 'https://stale.example/careers', e3, '{}');
    insert into public.companies (user_id, name, career_url, employer_id, metadata, watching) values
      (uid, 'Self check not followed', 'https://stale.example/careers', e3, '{}', false);
    select * into r from public.measure_t4();
    if round(r.value, 2) <> 66.67 or r.passed or r.sample_n <> 3 then
      raise exception 'measure_t4: 2 of 3 followed employers unreadable must fail, got % % %', r.value, r.passed, r.sample_n;
    end if;
    raise exception 'measure_t4 self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'measure_t4 self-check passed' then raise; end if;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- T35: browser reads
-- ---------------------------------------------------------------------------

create or replace function public.measure_t35()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_queued integer;
  n_proven integer;
  n_none integer;
  n_searched integer;
  n_unwaited integer;
  n_failed integer;
  n_total integer;
  by_class text;
begin
  -- Counted from the job and the candidate it was for, never from the job's own settled word: two racing posts can leave
  -- "retry" on a job whose employer is verified. A web search answers with domains, and a read with nobody waiting has no candidate.
  select count(*) filter (where j.state in ('queued', 'claimed')),
         count(*) filter (where j.kind = 'careers_page' and j.state = 'done' and c.state = 'verified'),
         count(*) filter (where j.kind = 'careers_page' and j.state = 'done' and c.id is not null and c.state <> 'verified'),
         count(*) filter (where j.kind = 'web_search' and j.state = 'done' and j.result ? 'domains'),
         count(*) filter (where j.kind = 'careers_page' and j.state = 'done' and j.candidate_id is null),
         count(*) filter (where j.state = 'failed'),
         count(*)
    into n_queued, n_proven, n_none, n_searched, n_unwaited, n_failed, n_total
    from public.render_jobs j
    left join public.directory_candidates c on c.id = j.candidate_id
   where j.created_at > now() - interval '7 days';

  select string_agg(format('%s %s', f.n, f.failure), ', ' order by f.n desc, f.failure) into by_class
    from (
      select coalesce(failure, 'no reason') as failure, count(*) as n
        from public.render_jobs
       where state = 'failed' and created_at > now() - interval '7 days'
       group by 1
    ) f;

  if n_total = 0 then
    return query select null::numeric, null::boolean, 0, 'No browser read in the last 7 days.'::text;
    return;
  end if;
  return query select
    n_proven::numeric,
    null::boolean,
    n_total,
    format('In the last 7 days: %s queued, %s done with a verified employer, %s done with none, %s web searches answered, %s reads with nobody waiting, %s failed%s. Reported; no bar yet.',
      n_queued, n_proven, n_none, n_searched, n_unwaited, n_failed, coalesce(' (' || by_class || ')', ''));
end;
$$;

-- Self-check: the review's case, two verified, one none, one web search, one failed and one queued (with one read nobody waited
-- for). The existing jobs are set aside inside the block and come back on rollback.
do $$
declare
  c_ok1 uuid;
  c_ok2 uuid;
  c_bad uuid;
  r record;
begin
  begin
    delete from public.render_jobs;
    insert into public.directory_candidates (name, name_norm, source, state) values
      ('Self check verified one', 'self check verified one', 'person', 'verified') returning id into c_ok1;
    insert into public.directory_candidates (name, name_norm, source, state) values
      ('Self check verified two', 'self check verified two', 'person', 'verified') returning id into c_ok2;
    insert into public.directory_candidates (name, name_norm, source, state) values
      ('Self check no board', 'self check no board', 'person', 'failed') returning id into c_bad;
    insert into public.render_jobs (kind, candidate_id, url, state, result) values
      ('careers_page', c_ok1, 'https://ok1.example/careers', 'done', '{"settled": "verified"}'),
      ('careers_page', c_ok2, 'https://ok2.example/careers', 'done', '{"settled": "retry"}'),
      ('careers_page', c_bad, 'https://bad.example/careers', 'done', '{"settled": "failed", "reason": "no_board"}'),
      ('web_search', null, null, 'done', '{"domains": ["search.example"]}'),
      ('careers_page', null, 'https://loose.example/careers', 'done', '{"rung": "a"}'),
      ('careers_page', c_bad, 'https://timeout.example/careers', 'failed', null),
      ('careers_page', c_bad, 'https://queued.example/careers', 'queued', null);
    update public.render_jobs set failure = 'Timeout' where state = 'failed';
    select * into r from public.measure_t35();
    if r.value <> 2 or r.sample_n <> 7 or r.note not like '%, 1 done with none,%' or r.note not like '%1 web searches answered, 1 reads with nobody waiting, 1 failed (1 Timeout)%' then
      raise exception 'measure_t35: expected 2 verified, 1 none, 1 search, 1 nobody waiting, 1 failed, 1 queued, got % % %', r.value, r.sample_n, r.note;
    end if;
    raise exception 'measure_t35 self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'measure_t35 self-check passed' then raise; end if;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- T36: "Not this company" reports
-- ---------------------------------------------------------------------------

create or replace function public.measure_t36()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  n_proven integer;
  n_left integer;
  n_waiting integer;
  n_pending integer;
  reasons text;
begin
  -- A report does not check anything itself: it sets the board's verified_at back so the next sweep (every 30 minutes, see
  -- lib/clock/routines/directory-sweep.ts) proves it again, and it clears cannot_read_reason. So for each report:
  --   left      the sweep recorded a cannot-read reason after the report (updated_at is stamped by every read)
  --   re-proven verified_at is later than the report
  --   pending   neither yet, and the report is younger than one sweep
  --   waiting   neither yet. A site-only employer has no board for the sweep to read, so it waits here by design.
  select count(*),
         count(*) filter (where d.cannot_read_reason is null and d.verified_at > r.created_at),
         count(*) filter (where d.cannot_read_reason is not null and d.updated_at > r.created_at),
         count(*) filter (where not (d.cannot_read_reason is not null and d.updated_at > r.created_at)
                            and not (d.cannot_read_reason is null and d.verified_at > r.created_at)
                            and r.created_at <= now() - interval '30 minutes'),
         count(*) filter (where not (d.cannot_read_reason is not null and d.updated_at > r.created_at)
                            and not (d.cannot_read_reason is null and d.verified_at > r.created_at)
                            and r.created_at > now() - interval '30 minutes')
    into n, n_proven, n_left, n_waiting, n_pending
    from public.employer_reports r
    join public.company_directory d on d.id = r.employer_id
   where r.created_at > now() - interval '30 days';

  select string_agg(format('%s %s', x.n, x.reason), ', ' order by x.n desc, x.reason) into reasons
    from (
      select d.cannot_read_reason as reason, count(*) as n
        from public.employer_reports r
        join public.company_directory d on d.id = r.employer_id
       where r.created_at > now() - interval '30 days' and d.cannot_read_reason is not null and d.updated_at > r.created_at
       group by 1
    ) x;

  if n = 0 then
    return query select null::numeric, null::boolean, 0, 'No "Not this company" report in the last 30 days.'::text;
    return;
  end if;
  return query select
    n::numeric,
    null::boolean,
    n,
    format('%s "Not this company" reports in the last 30 days, and how many of those employers have since been re-proven or left the rotation: re-proven %s, left %s%s, waiting for the re-check %s, pending until the next sweep %s. Reported; no bar yet.',
      n, n_proven, n_left, coalesce(' (' || reasons || ')', ''), n_waiting, n_pending);
end;
$$;

-- Self-check: one report per state (re-proven, left, waiting, pending). The owner's reports are set aside inside the block.
do $$
declare
  uid uuid;
  e_proven uuid;
  e_left uuid;
  e_waiting uuid;
  e_pending uuid;
  r record;
begin
  select id into uid from public.profiles limit 1;
  if uid is null then
    raise notice 'measure_t36 self-check skipped: no profile owns the seeded reports';
    return;
  end if;
  begin
    delete from public.employer_reports;
    insert into public.company_directory (name, name_norm, source, verified_at, updated_at) values ('Self check proven', 'self check proven', 'seed', now() - interval '1 hour', now()) returning id into e_proven;
    insert into public.company_directory (name, name_norm, source, cannot_read_reason, updated_at, verified_at) values ('Self check left', 'self check left', 'seed', 'cannot_read', now() - interval '1 hour', now() - interval '3 days') returning id into e_left;
    insert into public.company_directory (name, name_norm, source, verified_at) values ('Self check waiting', 'self check waiting', 'seed', now() - interval '3 days') returning id into e_waiting;
    insert into public.company_directory (name, name_norm, source, verified_at) values ('Self check pending', 'self check pending', 'seed', now() - interval '3 days') returning id into e_pending;
    insert into public.employer_reports (user_id, employer_id, created_at) values
      (uid, e_proven, now() - interval '2 hours'),
      (uid, e_left, now() - interval '2 hours'),
      (uid, e_waiting, now() - interval '2 hours'),
      (uid, e_pending, now() - interval '5 minutes');
    select * into r from public.measure_t36();
    if r.value <> 4 or r.sample_n <> 4 or r.note not like '%re-proven 1, left 1 (1 cannot_read), waiting for the re-check 1, pending until the next sweep 1.%' then
      raise exception 'measure_t36: expected one report in each state, got % % %', r.value, r.sample_n, r.note;
    end if;
    raise exception 'measure_t36 self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'measure_t36 self-check passed' then raise; end if;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- T37: route timings for add and follow
-- ---------------------------------------------------------------------------

create or replace function public.measure_t37()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  worst numeric := null;
  total integer := 0;
  parts text := '';
begin
  for r in
    select b.route, b.bar_ms, count(t.ms) as n,
           count(t.ms) filter (where t.ms <= b.bar_ms) as within,
           percentile_cont(0.95) within group (order by t.ms) as p95
      from (values ('add', 60000), ('follow', 8000)) as b (route, bar_ms)
      left join public.route_timings t on t.route = b.route and t.at > now() - interval '7 days'
     group by b.route, b.bar_ms
     order by b.route
  loop
    total := total + r.n;
    if r.n = 0 then
      parts := parts || format('%s: no calls in the last 7 days. ', r.route);
    else
      worst := least(coalesce(worst, 1), r.within::numeric / r.n);
      parts := parts || format('%s: %s of %s within %s ms, p95 %s ms. ', r.route, r.within, r.n, r.bar_ms, round(r.p95::numeric));
    end if;
  end loop;

  if total = 0 then
    return query select null::numeric, null::boolean, 0, 'No add or follow call in the last 7 days.'::text;
    return;
  end if;
  return query select
    round(100 * worst, 1),
    case when worst is null then null else worst >= 0.95 end,
    total,
    trim(parts) || ' The bar is 95 percent within each bar.';
end;
$$;

revoke all on function public.measure_t35(), public.measure_t36(), public.measure_t37() from public, anon, authenticated;
grant execute on function public.measure_t35(), public.measure_t36(), public.measure_t37() to service_role;

-- T12 is a static row: the review of this pull request traced every number to its column.
insert into public.measure_runs (measure_id, value, passed, sample_n, note)
select 'T12', null, true, null, 'Checked in review of the companies/measures pull request: every number on the Companies pages and the scorecard names its column in that pull request body.'
where not exists (select 1 from public.measure_runs where measure_id = 'T12');

-- ---------------------------------------------------------------------------
-- Self-check: the functions return one row each; T37 counts a bar, and the rows are made in a block that always rolls back.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  if to_regclass('public.route_timings') is null then raise exception 'route_timings is missing'; end if;
  if (select count(*) from public.measures where id in ('T34', 'T35', 'T36', 'T37')) <> 4 then raise exception 'the Companies measures must be in the register'; end if;
  if has_table_privilege('authenticated', 'public.route_timings', 'select') or has_table_privilege('anon', 'public.route_timings', 'select') then
    raise exception 'route_timings must not be readable by client roles';
  end if;
  if has_function_privilege('anon', 'public.measure_t37()', 'execute') or has_function_privilege('authenticated', 'public.measure_t37()', 'execute') then
    raise exception 'measure_t37 must not be executable by client roles';
  end if;
  if (select count(*) from public.measure_t35()) <> 1 or (select count(*) from public.measure_t36()) <> 1 or (select count(*) from public.measure_t37()) <> 1 then
    raise exception 'each Companies measure must return one row';
  end if;

  begin
    -- one add within 60 s, one add over it, one follow within 8 s: adds 50 percent, follows 100 percent, so the worst is 50
    insert into public.route_timings (route, ms, ok) values ('add', 1000, true), ('add', 90000, true), ('follow', 2000, true);
    select * into r from public.measure_t37();
    if r.value <> 50 or r.passed or r.sample_n <> 3 then
      raise exception 'measure_t37: the worst bar share must be 50 and not pass, got % % %', r.value, r.passed, r.sample_n;
    end if;
    raise exception 'companies_measures self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'companies_measures self-check passed' then raise; end if;
  end;
  if exists (select 1 from public.route_timings) then raise exception 'the self-check left route timings behind'; end if;
end
$$;

notify pgrst, 'reload schema';
