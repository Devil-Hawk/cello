-- What a check reports about itself, and a sighting that also counts as a
-- verification.
--
--   record_job_sightings now stamps last_verified_at too. /api/jobs/provenance
--   shows that column as "last verified"; until now only the manual verifier
--   wrote it, so a job the board listed an hour ago read as verified weeks ago.
--   Same signature and body as migration 20261006000100 otherwise.
--
--   ingestion_runs gains what the app needs to say which companies could not be
--   checked and why, instead of a bare count.

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
      -- /api/jobs/provenance shows this as "verified"; a listing is a verification.
      last_verified_at = p_seen_at,
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
      and cardinality(p_sources) > 0
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

alter table public.ingestion_runs
  add column if not exists partial_reason text check (partial_reason in ('time', 'model_limit', 'errors'));
-- At most 50 entries of {"company_id", "provider", "reason"}; reason is one of
-- board_error, fetch_failed, page_unconfirmed, model_unavailable, model_limit, time.
alter table public.ingestion_runs
  add column if not exists failed_companies jsonb not null default '[]'::jsonb;
-- Companies that were due when the check started (companies_checked is the ones it reached).
alter table public.ingestion_runs
  add column if not exists companies_total integer not null default 0;
alter table public.ingestion_runs
  add column if not exists model_calls integer not null default 0;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.ingestion_runs'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.ingestion_locks'::regclass) then
    raise exception 'row level security is off on an ingestion table';
  end if;
  if has_table_privilege('anon', 'public.ingestion_runs', 'select')
     or has_table_privilege('anon', 'public.ingestion_locks', 'select')
     or has_table_privilege('authenticated', 'public.ingestion_locks', 'select')
     or has_table_privilege('authenticated', 'public.ingestion_runs', 'insert')
     or has_table_privilege('authenticated', 'public.ingestion_runs', 'update')
     or not has_table_privilege('authenticated', 'public.ingestion_runs', 'select') then
    raise exception 'ingestion tables have the wrong privileges';
  end if;
end
$$;

notify pgrst, 'reload schema';
