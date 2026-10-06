-- K5b, the contract: a role is one row per posting, shared by everyone it fits, and a person reads it
-- through their person_roles row. Apply only after the code that reads person_jobs is deployed (the
-- read sweep): until then the old company-owner reads would lose the role a second follower now shares.
--
--   1. the fold: per-person copies of one posting become one row, every owner keeps a person_roles row,
--      applications move to the survivor
--   2. one row per (employer, posting): a unique index, and upsert_shared_jobs to write it
--   3. reading: the old company-owner select policy goes; jobs.company_id may be null
--   4. sync_person_roles gives a person the shared row stored under another follower's company
--   5. prune by the window rule: 30 days outside followed employers, 180 days at them
--   6. company_directory is readable by every signed-in person (employer facts, no personal column)
--
-- Not done here (named in the pull request): the own-company insert and update policies on jobs stay,
-- because signed-in routes still write through them (the scraper trigger, the match score, a shared
-- mail thread). They go when the scoring package moves those writes to the service role.

do $$
begin
  if to_regclass('public.person_jobs') is null then
    raise exception 'person_jobs is missing: apply 20261008050001 and deploy the read sweep first';
  end if;
end $$;

-- 1. The fold --------------------------------------------------------------------------------------

select public.fold_shared_postings();

do $$
begin
  -- a second pass picks up what the first one could not move in one step
  perform public.fold_shared_postings();
  if exists (
    select 1 from public.jobs where employer_id is not null and posting_key is not null
     group by employer_id, posting_key having count(*) > 1
  ) then
    raise exception 'copies of one posting remain after the fold; resolve them before the unique index';
  end if;
end $$;

-- 2. One row per posting ---------------------------------------------------------------------------

-- A role without an employer or a posting key never collides: nulls are distinct.
create unique index if not exists jobs_employer_posting_key on public.jobs (employer_id, posting_key);
drop index if exists public.jobs_employer_posting_idx;

-- Write the roles a read of one employer found. The first follower's company stays on the row;
-- a second follower's read of the same posting updates it and never inserts a copy.
create or replace function public.upsert_shared_jobs(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  -- A signed-in person may write only rows of their own companies; the service role writes any.
  if (select auth.uid()) is not null and exists (
    select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid and c.user_id = (select auth.uid()))
  ) then
    raise exception 'not your company' using errcode = 'insufficient_privilege';
  end if;

  -- a company without an employer has no shared row to write: the caller writes it by (company, external id)
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid and c.employer_id is not null)
  ) then
    raise exception 'a company in these rows has no employer' using errcode = '22023';
  end if;

  -- a copy stored before its company had an employer joins the shared row when nobody else holds the key
  update public.jobs j
     set employer_id = c.employer_id, posting_key = coalesce(nullif(j.external_id, ''), md5(j.url))
    from jsonb_populate_recordset(null::public.jobs, coalesce(p_rows, '[]'::jsonb)) r
    join public.companies c on c.id = r.company_id
   where j.company_id = r.company_id and j.external_id = r.external_id and j.employer_id is null
     and not exists (
       select 1 from public.jobs d
        where d.employer_id = c.employer_id and d.posting_key = coalesce(nullif(j.external_id, ''), md5(j.url))
     );

  insert into public.jobs (
    company_id, employer_id, posting_key, external_id, title, description, url, location, salary_range, posted_at,
    is_new, discovered_at, job_function, seniority, language, country, is_remote, job_type, quality_score,
    source, source_tier, last_seen_at, requirements, requirements_extracted_at
  )
  select r.company_id, c.employer_id, coalesce(nullif(r.external_id, ''), md5(r.url)), r.external_id, r.title, r.description, r.url,
         r.location, r.salary_range, r.posted_at, coalesce(r.is_new, true), coalesce(r.discovered_at, now()), r.job_function,
         r.seniority, r.language, r.country, r.is_remote, r.job_type, r.quality_score, r.source, r.source_tier,
         coalesce(r.last_seen_at, now()), r.requirements, r.requirements_extracted_at
    from jsonb_populate_recordset(null::public.jobs, coalesce(p_rows, '[]'::jsonb)) r
    join public.companies c on c.id = r.company_id
  on conflict (employer_id, posting_key) do update
    set title = excluded.title, description = excluded.description, url = excluded.url, location = excluded.location,
        salary_range = excluded.salary_range, posted_at = excluded.posted_at, job_function = excluded.job_function,
        seniority = excluded.seniority, language = excluded.language, country = excluded.country,
        is_remote = excluded.is_remote, job_type = excluded.job_type, quality_score = excluded.quality_score,
        source = excluded.source, source_tier = excluded.source_tier, last_seen_at = excluded.last_seen_at,
        requirements = excluded.requirements, requirements_extracted_at = excluded.requirements_extracted_at;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.upsert_shared_jobs(jsonb) from public, anon;
grant execute on function public.upsert_shared_jobs(jsonb) to authenticated, service_role;

-- 3. Reading ---------------------------------------------------------------------------------------

drop policy if exists "Users can view jobs for own companies" on public.jobs;
alter table public.jobs alter column company_id drop not null;

-- 4. A person's roles at an employer include the ones another follower stored ------------------------

create or replace function public.sync_person_roles(
  p_user uuid,
  p_company uuid,
  p_external_ids text[],
  p_targets_version integer default 0,
  p_hidden text[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user then
    raise exception 'not your roles' using errcode = 'insufficient_privilege';
  end if;
  insert into public.person_roles (user_id, job_id, targets_version, hidden_reason, checked_at)
  select p_user, j.id, p_targets_version, case when j.external_id = any (p_hidden) then 'unclassified' end, now()
    from public.jobs j
    join public.companies c on c.id = p_company and c.user_id = p_user
   where (j.company_id = p_company or (c.employer_id is not null and j.employer_id = c.employer_id))
     and j.external_id = any (p_external_ids)
  on conflict (user_id, job_id) do update
    set targets_version = excluded.targets_version,
        checked_at = now(),
        -- the person's own "not for me" is never undone by a check
        hidden_reason = case when public.person_roles.hidden_reason = 'not_for_me' then 'not_for_me' else excluded.hidden_reason end;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 5. Prune by the window rule ------------------------------------------------------------------------

create or replace function public.prune_stale_rows()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- A role no source has listed for this long is gone, whoever follows its employer.
  job_ttl constant interval := '45 days';
  -- A role closed this long ago is gone: the reader needs a few days of it to see a repost.
  closed_ttl constant interval := '7 days';
  -- The window: a role older than this is not an open role. At an employer someone follows it is 180
  -- days (lib/jobs/freshness.ts ROLE_MAX_AGE_DAYS); anywhere else in the directory it is 30.
  followed_window constant interval := '180 days';
  directory_window constant interval := '30 days';
  -- Spans are the run journal; checkpoints are only read to resume a thread.
  run_ttl constant interval := '30 days';
  keep_referenced text := '';
  fk record;
  jobs_deleted bigint;
  spans_deleted bigint;
  checkpoints_deleted bigint := 0;
  seen_deleted bigint;
  counts_deleted bigint;
begin
  -- A role anything points at stays, however old: most of those foreign keys cascade, so deleting
  -- the role would delete the application, draft or kit with it. They are read from the catalog on
  -- every run. person_roles points at every role a person can see, so it is left out of the list;
  -- a role someone saved stays by its own test.
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    keep_referenced := keep_referenced
      || format(' and not exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  keep_referenced := keep_referenced
    || ' and not exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';

  execute $q$
    delete from public.jobs j
     where (
       j.last_seen_at < now() - $1
       or (j.still_open = false and j.last_seen_at < now() - $2)
       or coalesce(j.posted_at, j.discovered_at) < now() - case
            when exists (
              select 1 from public.companies c
               where c.watching and (c.id = j.company_id or (j.employer_id is not null and c.employer_id = j.employer_id))
            ) then $3 else $4 end
     )
  $q$ || keep_referenced
    using job_ttl, closed_ttl, followed_window, directory_window;
  get diagnostics jobs_deleted = row_count;

  delete from public.trace_spans where start_time < now() - run_ttl;
  get diagnostics spans_deleted = row_count;

  delete from public.seen_postings where last_seen_at < now() - interval '30 days';
  get diagnostics seen_deleted = row_count;

  delete from public.person_counts where day < (now() at time zone 'utc')::date - 90;
  get diagnostics counts_deleted = row_count;

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
    'jobs', jobs_deleted, 'trace_spans', spans_deleted, 'checkpoints', checkpoints_deleted,
    'seen_postings', seen_deleted, 'person_counts', counts_deleted
  );
end;
$$;

-- 6. Employer facts --------------------------------------------------------------------------------

-- The directory holds what is true of an employer for everyone: name, domain, board, open count. Nothing
-- in it is personal, and Companies lists every employer for every signed-in person.
grant select on public.company_directory to authenticated;
drop policy if exists company_directory_select on public.company_directory;
create policy company_directory_select on public.company_directory for select to authenticated using (true);

-- A live read of an employer's roles leaves "of N open" on its directory row.
create or replace function public.set_employer_open_count(p_employer uuid, p_count integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.company_directory
     set open_count = greatest(p_count, 0), open_count_at = now()
   where id = p_employer;
$$;

revoke execute on function public.set_employer_open_count(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_employer_open_count(uuid, integer) to service_role;

do $$
begin
  if exists (select 1 from pg_policy where polrelid = 'public.jobs'::regclass and polname = 'Users can view jobs for own companies') then
    raise exception 'the company-owner read of jobs must be gone';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.jobs'::regclass and polname = 'jobs via person_roles') then
    raise exception 'jobs must be readable through person_roles';
  end if;
end $$;
