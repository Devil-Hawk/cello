-- K5d: the posting as the employer wrote it, whole (blueprint 6, "What the reader keeps").
--
--   jobs.description_md       the employer's HTML for the posting, cleaned and kept as Markdown, never cut short
--   jobs.description_state    full, partial (a snippet, or past the guard), none, cleared (at the storage alert)
--   jobs.description_source   api, jsonld, detail, rendered, listing
--   jobs.apply_url            the apply link, when it differs from the posting's address
--   jobs.description_md5      now the md5 of description_md (the reader's generated md5(description) is replaced:
--                             no code can write a generated column). Null with no body; kept when a body is cleared.
--   postings.backfill         re-reads followed employers' stored roles that have no body yet, applied-to first
--   storage.alert             above 350 MB, clears the bodies of roles nobody saved or applied to (the hash stays)
--   posting_samples, T21      the weekly sample of 50 kept roles against a fresh read of the live page
--
-- person_jobs selects jobs.*, so it is dropped around the column swap and made again.

drop view if exists public.person_jobs;

alter table public.jobs add column if not exists description_md text;
alter table public.jobs add column if not exists description_state text check (description_state in ('full', 'partial', 'none', 'cleared'));
alter table public.jobs add column if not exists description_source text check (description_source in ('api', 'jsonld', 'detail', 'rendered', 'listing'));
alter table public.jobs add column if not exists apply_url text;

-- Nothing is captured yet, so every row's hash starts null; the reader's next read of an employer captures its roles.
alter table public.jobs drop column if exists description_md5;
alter table public.jobs add column description_md5 text;
update public.jobs set description_md5 = md5(description_md) where description_md is not null;

create index if not exists jobs_description_pending_idx on public.jobs (id) where description_state is null;

create or replace view public.person_jobs
with (security_invoker = true)
as
select pr.user_id as viewer_id,
       pr.visible_since,
       pr.saved_at,
       pr.hidden_reason,
       -- an expression, not a bare column: PostgREST would otherwise read this column as companies.id
       -- and offer a second path from the view to companies, making every companies(...) embed ambiguous
       coalesce(vc.id, null::uuid) as viewer_company_id,
       vc.name as viewer_company_name,
       vc.domain as viewer_company_domain,
       vc.metadata as viewer_company_metadata,
       j.*,
       pr.via as viewer_via,
       pr.role_type as viewer_role_type
  from public.jobs j
  join public.person_roles pr on pr.job_id = j.id
  left join lateral (
    select c.id, c.name, c.domain, c.metadata
      from public.companies c
     where c.user_id = pr.user_id
       and (c.id = j.company_id or (j.employer_id is not null and c.employer_id = j.employer_id))
     order by (c.id = j.company_id) desc
     limit 1
  ) vc on true;

grant select on public.person_jobs to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A shared role written with its body. A read that found no body leaves the stored one alone.
-- ---------------------------------------------------------------------------

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

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid and c.employer_id is not null)
  ) then
    raise exception 'a company in these rows has no employer' using errcode = '22023';
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

revoke execute on function public.upsert_shared_jobs(jsonb) from public, anon;
grant execute on function public.upsert_shared_jobs(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The backfill: bodies for roles stored before posting capture
-- ---------------------------------------------------------------------------

-- Roles no reader will see soon (unfollowed, or not listed for 7 days) take the plain copy they already have, marked
-- partial when that copy sits at the 20,000-character cap and may have been cut. Followed employers' roles are
-- re-read: the employer is made due at once, applied-to roles' employers first, and the next read stores the whole body.
create or replace function public.backfill_posting_bodies(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  filled integer;
  due integer;
begin
  with pick as (
    select j.id
      from public.jobs j
     where j.description_state is null
       and coalesce(j.description, '') <> ''
       and (
         j.last_seen_at is null or j.last_seen_at < now() - interval '7 days'
         or not exists (
           select 1 from public.companies c
            where c.watching and (c.id = j.company_id or (j.employer_id is not null and c.employer_id = j.employer_id))
         )
       )
     order by j.id
     limit least(greatest(p_limit, 1), 5000)
  )
  update public.jobs j
     set description_md = j.description,
         description_source = 'listing',
         description_state = case when char_length(j.description) >= 20000 then 'partial' else 'full' end,
         description_md5 = md5(j.description)
    from pick
   where j.id = pick.id;
  get diagnostics filled = row_count;

  with target as (
    select c.id, c.user_id,
           exists (
             select 1 from public.applications a join public.jobs j on j.id = a.job_id
              where j.description_state is null and (j.company_id = c.id or (j.employer_id is not null and j.employer_id = c.employer_id))
           ) as applied
      from public.companies c
     where c.watching
       and c.last_scraped_at is not null
       and exists (
         select 1 from public.jobs j
          where j.description_state is null and (j.company_id = c.id or (j.employer_id is not null and j.employer_id = c.employer_id))
       )
     order by applied desc, c.last_scraped_at
     limit 50
  ), made_due as (
    update public.companies c set last_scraped_at = null from target where c.id = target.id returning target.user_id
  )
  update public.routines r set next_due_at = now(), poked_at = null
   where r.command = 'roles.check' and r.enabled and r.user_id in (select user_id from made_due);
  get diagnostics due = row_count;

  return jsonb_build_object('filled', filled, 'people_due', due);
end;
$$;

-- The storage alert's body clearing (3.5): a body stays whole for a role someone saved or applied to, and is
-- cleared on the rest. The hash stays, so an unchanged posting is not fetched again, and so do the requirement
-- items and their quotes.
-- ponytail: "opened in the last 14 days" and "reacted to" join when the record page and reactions exist.
create or replace function public.clear_untouched_posting_bodies(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with pick as (
    select j.id
      from public.jobs j
     where j.description_md is not null
       and not exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)
       and not exists (select 1 from public.applications a where a.job_id = j.id)
     order by j.last_seen_at nulls first, j.id
     limit least(greatest(p_limit, 1), 5000)
  )
  update public.jobs j set description_md = null, description_state = 'cleared'
    from pick where j.id = pick.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.backfill_posting_bodies(integer), public.clear_untouched_posting_bodies(integer) from public, anon, authenticated;
grant execute on function public.backfill_posting_bodies(integer), public.clear_untouched_posting_bodies(integer) to service_role;

-- ---------------------------------------------------------------------------
-- T21: is the stored posting the employer's whole text?
-- ---------------------------------------------------------------------------

-- One row per role of the weekly sample: the owner's reading run re-reads the live page and records whether the
-- stored Markdown holds its text (token recall at least 0.98), why a posting is only partial, and whether any
-- body was cut without being marked.
create table if not exists public.posting_samples (
  id bigint generated always as identity primary key,
  job_id uuid references public.jobs (id) on delete cascade,
  md_ok boolean not null,
  partial_reason text,
  silent_truncation boolean not null default false,
  checked_at timestamptz not null default now()
);
create index if not exists posting_samples_checked_idx on public.posting_samples (checked_at desc);
alter table public.posting_samples enable row level security;
revoke all on public.posting_samples from public, anon, authenticated;
grant all on public.posting_samples to service_role;
grant usage, select on sequence public.posting_samples_id_seq to service_role;

create or replace function public.measure_t21()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  ok integer;
  cut integer;
  partial integer;
begin
  select count(*), count(*) filter (where md_ok), count(*) filter (where silent_truncation), count(*) filter (where partial_reason is not null)
    into n, ok, cut, partial
    from public.posting_samples where checked_at > now() - interval '8 days';
  if n = 0 then
    return query select null::numeric, null::boolean, 0, 'No weekly sample of kept roles yet.'::text;
    return;
  end if;
  return query select round(ok::numeric / n, 4), (ok::numeric / n >= 0.95 and cut = 0), n,
    format('%s of %s sampled postings are the employer''s whole text; %s are partial with a reason; %s were cut without being marked.', ok, n, partial, cut);
end;
$$;

revoke execute on function public.measure_t21() from public, anon, authenticated;
grant execute on function public.measure_t21() to service_role;

-- ---------------------------------------------------------------------------
-- Routines of the clock
-- ---------------------------------------------------------------------------

insert into public.routines (user_id, command, every, local_time, timezone, next_due_at, enabled, origin) values
  (null, 'postings.backfill', interval '10 minutes', null,    'UTC', now() + interval '10 minutes', true, 'default'),
  (null, 'storage.alert',     null,                  '05:00', 'UTC', date_trunc('day', now()) + interval '1 day 5 hours', true, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'description_md5' and is_generated = 'ALWAYS') then
    raise exception 'description_md5 must be a plain column';
  end if;
end $$;
