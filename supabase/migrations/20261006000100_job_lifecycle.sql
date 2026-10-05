-- Job lifecycle: when a posting was last seen, whether it is still open, and the
-- requirements read out of its description once at ingest.
--
-- Until now a job row only ever got older. discovered_at was the one clock, so
-- the daily prune deleted 45-day-old rows that were still listed (and the next
-- scrape re-inserted them without their match score), and a posting the
-- employer had taken down stayed on the list forever.
--
--   last_seen_at   every refresh that sees the posting stamps it. The prune and
--                  the closed check both read this, never discovered_at.
--   missed_checks  consecutive refreshes of the posting's own source that did
--                  not list it. Reset to 0 when it is seen again.
--   still_open     false once missed_checks reaches 2. An existing column that
--                  nothing wrote on the ingest path; null still means "unknown".
--   closed_at      when it was marked closed.
--   requirements   structured read of the description (see lib/jobs/requirements.ts).

alter table public.jobs add column if not exists last_seen_at timestamptz;
alter table public.jobs add column if not exists missed_checks integer not null default 0;
alter table public.jobs add column if not exists closed_at timestamptz;
alter table public.jobs add column if not exists requirements jsonb;
alter table public.jobs add column if not exists requirements_extracted_at timestamptz;

-- Existing rows: the best evidence we have of "seen" is the last verification,
-- else the day they were found.
update public.jobs set last_seen_at = coalesce(last_verified_at, discovered_at) where last_seen_at is null;
alter table public.jobs alter column last_seen_at set default now();
alter table public.jobs alter column last_seen_at set not null;

create index if not exists idx_jobs_last_seen_at on public.jobs (last_seen_at);
-- The requirements pass looks for rows that still have a description to read.
create index if not exists idx_jobs_requirements_todo on public.jobs (company_id)
  where requirements is null and description <> '';

-- ---------------------------------------------------------------------------
-- record_job_sightings: one call per company refresh.
--
-- p_external_ids  every external_id the source listed this time.
-- p_sources       the jobs.source values that belong to the channel that was
--                 just read (['greenhouse'] for the Greenhouse board,
--                 ['scraper'] for the page reader). Only those rows can be
--                 "missed". Aggregator rows are never closed by a miss: an
--                 aggregator returns a window of listings chosen by a query,
--                 not the employer's full list, so absence from it means
--                 nothing. Rows with no source (written before the column
--                 existed) count as this channel's.
-- p_close_after   consecutive misses before a job is marked closed.
--
-- SECURITY INVOKER on purpose: the in-app refresh calls this with the user's
-- own session, and row level security on jobs then limits it to their rows.
-- The scheduled ingest calls it as service_role.
-- ---------------------------------------------------------------------------
create or replace function public.record_job_sightings(
  p_company_id uuid,
  p_external_ids text[],
  p_sources text[],
  p_close_after integer default 2,
  p_seen_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_seen integer := 0;
  v_reopened integer := 0;
  v_missed integer := 0;
  v_closed integer := 0;
begin
  -- An empty list is indistinguishable from a board that failed to load, so it
  -- is never evidence that anything closed.
  if coalesce(cardinality(p_external_ids), 0) = 0 then
    return jsonb_build_object('seen', 0, 'reopened', 0, 'missed', 0, 'closed', 0);
  end if;

  select count(*) into v_reopened
  from public.jobs j
  where j.company_id = p_company_id
    and j.external_id = any(p_external_ids)
    and j.still_open is false;

  update public.jobs j
  set last_seen_at = p_seen_at,
      missed_checks = 0,
      still_open = true,
      closed_at = null
  where j.company_id = p_company_id
    and j.external_id = any(p_external_ids);
  get diagnostics v_seen = row_count;

  -- last_seen_at < p_seen_at keeps a posting that something else saw after this
  -- refresh began (an aggregator listing, a refresh that finished first) from
  -- being counted as missed by a read that is older than that sighting.
  with missed as (
    update public.jobs j
    set missed_checks = j.missed_checks + 1,
        still_open = case when j.missed_checks + 1 >= p_close_after then false else j.still_open end,
        closed_at = case when j.missed_checks + 1 >= p_close_after and j.still_open is not false
                         then p_seen_at else j.closed_at end
    where j.company_id = p_company_id
      and (j.external_id is null or j.external_id <> all(p_external_ids))
      and (j.source is null or j.source = any(p_sources))
      and j.still_open is not false
      and j.last_seen_at < p_seen_at
    returning j.still_open
  )
  select count(*), count(*) filter (where still_open is false) into v_missed, v_closed from missed;

  return jsonb_build_object('seen', v_seen, 'reopened', v_reopened, 'missed', v_missed, 'closed', v_closed);
end;
$$;

revoke all on function public.record_job_sightings(uuid, text[], text[], integer, timestamptz) from public, anon;
grant execute on function public.record_job_sightings(uuid, text[], text[], integer, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Prune on last seen, not on first found.
--
-- A posting that is still listed gets last_seen_at bumped by every refresh, so
-- it is never pruned and never loses its match score. One nobody has seen for
-- 45 days is gone from its source (it was also marked closed after two misses)
-- and nothing will read it again unless something references it. Same
-- reference guard as before.
-- ---------------------------------------------------------------------------
create or replace function public.prune_stale_rows()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- How long an unreferenced posting is kept after a source last listed it.
  job_ttl constant interval := '45 days';
  -- Spans are the run journal; checkpoints are only read to resume a thread.
  run_ttl constant interval := '30 days';
  keep_referenced text := '';
  fk record;
  jobs_deleted bigint;
  spans_deleted bigint;
  checkpoints_deleted bigint := 0;
begin
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
  loop
    keep_referenced := keep_referenced
      || format(' and not exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;

  execute 'delete from public.jobs j where j.last_seen_at < now() - $1' || keep_referenced
    using job_ttl;
  get diagnostics jobs_deleted = row_count;

  delete from public.trace_spans where start_time < now() - run_ttl;
  get diagnostics spans_deleted = row_count;

  if to_regclass('langgraph.checkpoints') is not null then
    execute $q$
      with stale as (
        select thread_id::text as id from public.graph_threads
        where coalesce(last_invoked_at, created_at) < now() - $1
      ), w as (
        delete from langgraph.checkpoint_writes where thread_id in (select id from stale)
      ), b as (
        delete from langgraph.checkpoint_blobs where thread_id in (select id from stale)
      )
      delete from langgraph.checkpoints where thread_id in (select id from stale)
    $q$ using run_ttl;
    get diagnostics checkpoints_deleted = row_count;
  end if;

  return jsonb_build_object(
    'jobs', jobs_deleted, 'trace_spans', spans_deleted, 'checkpoints', checkpoints_deleted
  );
end;
$$;

revoke execute on function public.prune_stale_rows() from public, anon, authenticated;
