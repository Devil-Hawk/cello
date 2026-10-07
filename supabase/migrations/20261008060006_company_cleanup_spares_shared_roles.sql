-- K5b follow-up: a company-keyed write never touches a shared role.
--
-- A shared role (employer_id set) keeps the company_id of the follower whose read stored it first, so a function that
-- deletes or closes "the roles of this company" reached roles other followers hold. evict_company_jobs and
-- clear_unverified_board_jobs ran as definer for any signed-in owner of that first company, and record_job_sightings
-- ran on the admin client for an unlinked read of a forged board.
--
--   1. evict_company_jobs and clear_unverified_board_jobs only ever touch roles with no employer, and only the
--      service role may call them (the store calls them on the service client).
--   2. record_job_sightings only counts rows with no employer; a shared role is stamped, missed and closed by its
--      employer (record_employer_sightings).

create or replace function public.evict_company_jobs(p_company_id uuid, p_external_ids text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; gone text[];
begin
  if p_company_id is null then
    raise exception 'company is required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_external_ids, 1), 0) = 0 then
    return '{}';
  end if;
  -- The cron (service role, or a direct psql session with no JWT) may evict for any company; a signed-in user only their own.
  if coalesce(auth.jwt()->>'role', 'service_role') <> 'service_role'
     and not exists (select 1 from public.companies c where c.id = p_company_id and c.user_id = auth.uid()) then
    raise exception 'not your company' using errcode = '42501';
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    if fk.width <> 1 then raise exception 'multi-column foreign key on jobs from %; refusing', fk.tbl; end if;
    referenced := referenced || format(' or exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  referenced := referenced || ' or exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';
  -- a shared role is its employer's, never a company's: only a role with no employer goes
  execute 'with d as (delete from public.jobs j where j.company_id = $1 and j.employer_id is null and j.external_id = any($2) and not (' || referenced || ') returning j.external_id) select coalesce(array_agg(external_id), ''{}'') from d'
    into gone using p_company_id, p_external_ids[1:200];
  return gone;
end $$;
revoke execute on function public.evict_company_jobs(uuid, text[]) from public, anon, authenticated;
grant execute on function public.evict_company_jobs(uuid, text[]) to service_role;

create or replace function public.clear_unverified_board_jobs(p_company_id uuid, p_source text)
returns table(deleted integer, closed integer)
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; n_closed integer; n_deleted integer;
begin
  if p_company_id is null or coalesce(p_source, '') = '' then
    raise exception 'company and source are required' using errcode = '22023';
  end if;
  -- The cron (service role, or a direct psql session with no JWT) may clear any company; a signed-in user only their own.
  if coalesce(auth.jwt()->>'role', 'service_role') <> 'service_role'
     and not exists (select 1 from public.companies c where c.id = p_company_id and c.user_id = auth.uid()) then
    raise exception 'not your company' using errcode = '42501';
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    if fk.width <> 1 then raise exception 'multi-column foreign key on jobs from %; refusing', fk.tbl; end if;
    referenced := referenced || format(' or exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  referenced := referenced || ' or exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';
  -- a shared role is its employer's, never a company's: only a role with no employer is closed or deleted
  execute 'update public.jobs j set still_open = false, last_verified_at = now() where j.company_id = $1 and j.employer_id is null and j.source = $2 and (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_closed = row_count;
  execute 'delete from public.jobs j where j.company_id = $1 and j.employer_id is null and j.source = $2 and not (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_deleted = row_count;
  return query select n_deleted, n_closed;
end $$;
revoke execute on function public.clear_unverified_board_jobs(uuid, text) from public, anon, authenticated;
grant execute on function public.clear_unverified_board_jobs(uuid, text) to service_role;

-- Same body as 20261006000103 with one more test in each of the three company predicates.
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
    and j.employer_id is null
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
    and j.employer_id is null
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
      and j.employer_id is null
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
