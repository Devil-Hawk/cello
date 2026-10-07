-- K5b follow-up: the employer of a role is the one its read was made for, never what a person's company says later.
--
--   1. A role gets an employer only through upsert_shared_jobs. The insert trigger no longer takes it from the company:
--      a person who linked their company between the service-role read of their own board and its write turned that
--      board's rows into shared ones.
--   2. upsert_shared_jobs refuses rows whose employer is not the company's now (the read was made for another one), and
--      for a board employer rows whose source is not the board's provider. The company rows are locked until it commits.
--   3. A row with no employer never replaces a shared row of the same company and posting (the own-role upsert would
--      otherwise rewrite a shared role's title, body and address for every follower after the person unlinked).

create or replace function public.jobs_set_employer_posting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.posting_key is null then
    new.posting_key := coalesce(nullif(new.external_id, ''), md5(new.url));
  end if;
  -- skipped, not updated: the conflict action of an upsert never runs for a row this returns null for
  if new.employer_id is null and new.company_id is not null and new.external_id is not null
     and exists (select 1 from public.jobs j where j.company_id = new.company_id and j.external_id = new.external_id and j.employer_id is not null) then
    return null;
  end if;
  return new;
end;
$$;

create or replace function public.upsert_shared_jobs(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if (select auth.uid()) is not null and exists (
    select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid and c.user_id = (select auth.uid()))
  ) then
    raise exception 'not your company' using errcode = 'insufficient_privilege';
  end if;

  -- The companies stay as they are until this write commits (a person's update of one waits).
  perform 1 from public.companies c
   where c.id in (select (r ->> 'company_id')::uuid from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r)
     for share;

  -- The employer a read was made for is the one the company has now, and a board employer's roles are its board's.
  if exists (
    select 1 from jsonb_populate_recordset(null::public.jobs, coalesce(p_rows, '[]'::jsonb)) r
      left join public.companies c on c.id = r.company_id
      left join public.company_directory d on d.id = c.employer_id
     where c.employer_id is null
        or r.employer_id is distinct from c.employer_id
        or (d.ats_provider is not null and r.source is distinct from d.ats_provider)
  ) then
    raise exception 'these rows are not their company''s employer''s' using errcode = '22023';
  end if;

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
    source, source_tier, last_seen_at, requirements, requirements_extracted_at,
    title_norm, dept_norm, role_type, type_origin, type_prov,
    description_md, description_state, description_source, apply_url, description_md5
  )
  select r.company_id, c.employer_id, coalesce(nullif(r.external_id, ''), md5(r.url)), r.external_id, r.title, r.description, r.url,
         r.location, r.salary_range, r.posted_at, coalesce(r.is_new, true), coalesce(r.discovered_at, now()), r.job_function,
         r.seniority, r.language, r.country, r.is_remote, r.job_type, r.quality_score, r.source, r.source_tier,
         coalesce(r.last_seen_at, now()), r.requirements, r.requirements_extracted_at,
         r.title_norm, r.dept_norm, r.role_type, r.type_origin, r.type_prov,
         r.description_md, r.description_state, r.description_source, r.apply_url, r.description_md5
    from jsonb_populate_recordset(null::public.jobs, coalesce(p_rows, '[]'::jsonb)) r
    join public.companies c on c.id = r.company_id
  on conflict (employer_id, posting_key) do update
    set title = excluded.title, description = excluded.description, url = excluded.url, location = excluded.location,
        salary_range = excluded.salary_range, posted_at = excluded.posted_at, job_function = excluded.job_function,
        seniority = excluded.seniority, language = excluded.language, country = excluded.country,
        is_remote = excluded.is_remote, job_type = excluded.job_type, quality_score = excluded.quality_score,
        source = excluded.source, source_tier = excluded.source_tier, last_seen_at = excluded.last_seen_at,
        requirements = excluded.requirements, requirements_extracted_at = excluded.requirements_extracted_at,
        title_norm = excluded.title_norm, dept_norm = excluded.dept_norm,
        role_type = case when public.jobs.type_origin = 'model' then public.jobs.role_type else excluded.role_type end,
        type_origin = case when public.jobs.type_origin = 'model' then public.jobs.type_origin else excluded.type_origin end,
        type_prov = case when public.jobs.type_origin = 'model' then public.jobs.type_prov else excluded.type_prov end,
        description_md = coalesce(excluded.description_md, public.jobs.description_md),
        description_md5 = case when excluded.description_md is not null then excluded.description_md5 else public.jobs.description_md5 end,
        description_state = case when excluded.description_md is not null then excluded.description_state else public.jobs.description_state end,
        description_source = case when excluded.description_md is not null then excluded.description_source else public.jobs.description_source end,
        apply_url = coalesce(excluded.apply_url, public.jobs.apply_url);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.upsert_shared_jobs(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_shared_jobs(jsonb) to service_role;
