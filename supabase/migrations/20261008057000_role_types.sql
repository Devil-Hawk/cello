-- K5c: role types (blueprint 6.1, 3.3). Expand only: code that does not know these columns still works.
--
--   role_types           the taxonomy, written only by `pnpm role-types:sync` from lib/jobs/role-types
--   title_types          one judgement per (normalised title, department), shared by every employer and person
--   role_type_synonyms   a person's own word for a title (a correction, or a title they typed and accepted)
--   employer_stats       counters by employer, role type and level; created here, written by the directory (K6)
--   instance_flags       the owner's switches; one row so far, role_types_live, off
--   jobs                 title_norm, dept_norm, role_type, type_origin, type_prov
--   person_roles         via, and role_type (the person's correction)
--   set_person_role_type the correction, applied at once to every role of theirs with that title
--   measure_t19, t20     how titles were typed; what the type step would keep and drop beside the old filter

-- ---------------------------------------------------------------------------
-- role_types
-- ---------------------------------------------------------------------------

create table if not exists public.role_types (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{0,62}$'),
  label text not null check (char_length(label) between 1 and 80),
  -- a job_function value (lib/jobs/classify.ts)
  family text not null,
  related text[] not null default '{}',
  taxonomy_version integer not null check (taxonomy_version >= 1),
  -- a retired type has a replacement; people who chose it are moved to it
  retired_at timestamptz,
  replaced_by text references public.role_types (id)
);

alter table public.role_types enable row level security;
revoke all on public.role_types from public, anon, authenticated;
grant select on public.role_types to authenticated;
grant all on public.role_types to service_role;
drop policy if exists role_types_select on public.role_types;
create policy role_types_select on public.role_types for select to authenticated using (true);

-- The taxonomy at version 1, so the types a read writes onto roles exist the moment the code that writes them
-- is deployed. `pnpm role-types:sync` keeps the table equal to lib/jobs/role-types from here on (a test fails
-- when this seed and the module differ).
insert into public.role_types (id, label, family, related, taxonomy_version) values
  ('forward-deployed-engineer', 'Forward Deployed Engineer', 'engineering', '{solutions-engineer,ai-engineer}', 1),
  ('ai-engineer', 'AI Engineer', 'engineering', '{ml-engineer,forward-deployed-engineer,product-engineer}', 1),
  ('ml-engineer', 'ML Engineer', 'data', '{ai-engineer,applied-scientist,research-engineer}', 1),
  ('applied-scientist', 'Applied Scientist', 'data', '{ml-engineer,research-scientist,data-scientist}', 1),
  ('research-engineer', 'Research Engineer', 'engineering', '{research-scientist,ml-engineer}', 1),
  ('research-scientist', 'Research Scientist', 'data', '{applied-scientist,research-engineer}', 1),
  ('data-scientist', 'Data Scientist', 'data', '{applied-scientist,data-analyst}', 1),
  ('data-engineer', 'Data Engineer', 'data', '{analytics-engineer,platform-engineer}', 1),
  ('analytics-engineer', 'Analytics Engineer', 'data', '{data-engineer,data-analyst}', 1),
  ('data-analyst', 'Data Analyst', 'data', '{analytics-engineer,data-scientist}', 1),
  ('backend-engineer', 'Backend Engineer', 'engineering', '{software-engineer,platform-engineer}', 1),
  ('fullstack-engineer', 'Full-stack Engineer', 'engineering', '{backend-engineer,frontend-engineer,product-engineer}', 1),
  ('frontend-engineer', 'Frontend Engineer', 'engineering', '{fullstack-engineer,mobile-engineer}', 1),
  ('mobile-engineer', 'Mobile Engineer', 'engineering', '{frontend-engineer}', 1),
  ('platform-engineer', 'Platform or Infrastructure Engineer', 'engineering', '{backend-engineer,security-engineer}', 1),
  ('security-engineer', 'Security Engineer', 'engineering', '{platform-engineer}', 1),
  ('solutions-engineer', 'Solutions Engineer', 'engineering', '{forward-deployed-engineer,developer-relations}', 1),
  ('product-engineer', 'Product Engineer', 'engineering', '{fullstack-engineer,ai-engineer}', 1),
  ('developer-relations', 'Developer Relations', 'engineering', '{solutions-engineer}', 1),
  ('software-engineer', 'Software Engineer', 'engineering', '{backend-engineer,fullstack-engineer}', 1),
  ('embedded-engineer', 'Embedded or Firmware Engineer', 'engineering', '{software-engineer}', 1),
  ('quality-engineer', 'Test or Quality Engineer', 'engineering', '{software-engineer}', 1),
  ('engineering-manager', 'Engineering Manager', 'engineering', '{software-engineer}', 1),
  ('product-manager', 'Product Manager', 'product', '{}', 1),
  ('designer', 'Designer', 'design', '{frontend-engineer}', 1),
  ('other-sales', 'Sales', 'sales', '{}', 1),
  ('other-marketing', 'Marketing', 'marketing', '{}', 1),
  ('other-support', 'Support', 'support', '{}', 1),
  ('other-operations', 'Operations', 'operations', '{}', 1),
  ('other-finance', 'Finance', 'finance', '{}', 1),
  ('other-hr', 'People', 'hr', '{}', 1),
  ('other-legal', 'Legal', 'legal', '{}', 1),
  ('other', 'Other', 'other', '{}', 1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- title_types
-- ---------------------------------------------------------------------------

create table if not exists public.title_types (
  title_norm text not null check (char_length(title_norm) <= 160),
  -- the normalised department for a title that names no particular job, else the empty string
  dept_norm text not null default '' check (char_length(dept_norm) <= 100),
  role_type text references public.role_types (id),
  origin text not null check (origin in ('code', 'model')),
  prov jsonb,
  taxonomy_version integer not null,
  status text not null check (status in ('typed', 'pending', 'none')),
  n_seen integer not null default 0 check (n_seen >= 0),
  typed_at timestamptz,
  primary key (title_norm, dept_norm)
);

alter table public.title_types enable row level security;
revoke all on public.title_types from public, anon, authenticated;
grant all on public.title_types to service_role;

-- ---------------------------------------------------------------------------
-- role_type_synonyms
-- ---------------------------------------------------------------------------

create table if not exists public.role_type_synonyms (
  user_id uuid not null references public.profiles (id) on delete cascade,
  title_norm text not null check (char_length(title_norm) <= 160),
  role_type text not null references public.role_types (id),
  source text not null check (source in ('correction', 'typed')),
  created_at timestamptz not null default now(),
  primary key (user_id, title_norm)
);

alter table public.role_type_synonyms enable row level security;
revoke all on public.role_type_synonyms from public, anon, authenticated;
grant select, insert, update, delete on public.role_type_synonyms to authenticated;
grant all on public.role_type_synonyms to service_role;
drop policy if exists role_type_synonyms_own on public.role_type_synonyms;
create policy role_type_synonyms_own on public.role_type_synonyms for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- employer_stats
-- ---------------------------------------------------------------------------

create table if not exists public.employer_stats (
  id bigint generated always as identity primary key,
  employer_id uuid not null references public.company_directory (id) on delete cascade,
  -- null for titles not yet typed: one row per employer and level
  role_type text references public.role_types (id),
  seniority text,
  type_origin text check (type_origin in ('code', 'model')),
  open_count integer not null default 0 check (open_count >= 0),
  opened_30d integer not null default 0 check (opened_30d >= 0),
  opened_90d integer not null default 0 check (opened_90d >= 0),
  closed_count integer not null default 0 check (closed_count >= 0),
  median_lifetime_days numeric,
  stated_pay jsonb,
  read_at timestamptz,
  unique nulls not distinct (employer_id, role_type, seniority)
);

alter table public.employer_stats enable row level security;
revoke all on public.employer_stats from public, anon, authenticated;
grant all on public.employer_stats to service_role;
grant usage, select on sequence public.employer_stats_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- instance_flags
-- ---------------------------------------------------------------------------

create table if not exists public.instance_flags (
  key text primary key check (char_length(key) between 1 and 80),
  "on" boolean not null default false,
  set_by text,
  set_at timestamptz not null default now(),
  note text
);

alter table public.instance_flags enable row level security;
revoke all on public.instance_flags from public, anon, authenticated;
grant all on public.instance_flags to service_role;

insert into public.instance_flags (key, "on", note)
values ('role_types_live', false, 'off: the old title filter decides what is kept, and the type step is counted beside it (T20)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- jobs and person_roles
-- ---------------------------------------------------------------------------

alter table public.jobs add column if not exists title_norm text;
alter table public.jobs add column if not exists dept_norm text;
alter table public.jobs add column if not exists role_type text references public.role_types (id);
alter table public.jobs add column if not exists type_origin text check (type_origin in ('code', 'model'));
alter table public.jobs add column if not exists type_prov jsonb;

create index if not exists jobs_title_norm_idx on public.jobs (title_norm) where title_norm is not null;
create index if not exists jobs_role_type_idx on public.jobs (role_type) where role_type is not null;

alter table public.person_roles add column if not exists via text check (via in ('check', 'link', 'company'));
alter table public.person_roles add column if not exists role_type text references public.role_types (id);

-- A person's roles as one view, with the new columns at the end (a view grows only at its end).
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

-- A shared role written with its type. Replaces the contract migration's function: a row a model typed
-- (K15b) keeps its type, since code never overrules a model.
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
    title_norm, dept_norm, role_type, type_origin, type_prov
  )
  select r.company_id, c.employer_id, coalesce(nullif(r.external_id, ''), md5(r.url)), r.external_id, r.title, r.description, r.url,
         r.location, r.salary_range, r.posted_at, coalesce(r.is_new, true), coalesce(r.discovered_at, now()), r.job_function,
         r.seniority, r.language, r.country, r.is_remote, r.job_type, r.quality_score, r.source, r.source_tier,
         coalesce(r.last_seen_at, now()), r.requirements, r.requirements_extracted_at,
         r.title_norm, r.dept_norm, r.role_type, r.type_origin, r.type_prov
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
        type_prov = case when public.jobs.type_origin = 'model' then public.jobs.type_prov else excluded.type_prov end;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.upsert_shared_jobs(jsonb) from public, anon;
grant execute on function public.upsert_shared_jobs(jsonb) to authenticated, service_role;

-- The directory match reads each role's type too, to judge it by the person's chosen types.
drop function if exists public.directory_roles_for(uuid, timestamptz, integer);
create function public.directory_roles_for(p_user uuid, p_since timestamptz default null, p_limit integer default 2000)
returns table (
  id uuid, title text, job_function text, seniority text, country text, language text,
  is_remote boolean, posted_at timestamptz, employer_name text, title_norm text, role_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.job_function, j.seniority, j.country, j.language, j.is_remote, j.posted_at, d.name, j.title_norm, j.role_type
    from public.jobs j
    join public.company_directory d on d.id = j.employer_id
   where j.still_open is not false
     and (j.posted_at is null or j.posted_at > now() - interval '180 days')
     and (p_since is null or j.discovered_at > p_since)
     and not exists (select 1 from public.person_roles pr where pr.user_id = p_user and pr.job_id = j.id)
   order by j.discovered_at desc
   limit least(greatest(p_limit, 1), 5000)
$$;
revoke execute on function public.directory_roles_for(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.directory_roles_for(uuid, timestamptz, integer) to service_role;

-- Keeping a role records how it came to the person: a check read it, or they pasted a link.
drop function if exists public.sync_person_roles(uuid, uuid, text[], integer, text[]);
create function public.sync_person_roles(
  p_user uuid,
  p_company uuid,
  p_external_ids text[],
  p_targets_version integer default 0,
  p_hidden text[] default '{}',
  p_via text default 'check'
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
  if p_via not in ('check', 'link', 'company') then
    raise exception 'unknown way a role came' using errcode = '22023';
  end if;
  insert into public.person_roles (user_id, job_id, targets_version, hidden_reason, checked_at, via)
  select distinct on (j.external_id) p_user, j.id, p_targets_version, case when j.external_id = any (p_hidden) then 'unclassified' end, now(), p_via
    from public.jobs j
    join public.companies c on c.id = p_company and c.user_id = p_user
   where (j.company_id = p_company or (c.employer_id is not null and j.employer_id = c.employer_id))
     and j.external_id = any (p_external_ids)
   order by j.external_id, (j.company_id = p_company) desc, j.discovered_at nulls last, j.id
  on conflict (user_id, job_id) do update
    set targets_version = excluded.targets_version,
        checked_at = now(),
        via = coalesce(public.person_roles.via, excluded.via),
        -- the person's own "not for me" is never undone by a check
        hidden_reason = case when public.person_roles.hidden_reason = 'not_for_me' then 'not_for_me' else excluded.hidden_reason end;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.sync_person_roles(uuid, uuid, text[], integer, text[], text) from public, anon;
grant execute on function public.sync_person_roles(uuid, uuid, text[], integer, text[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The person's correction
-- ---------------------------------------------------------------------------

-- Change type: the person's word for this role's title, applied at once to every role of theirs with the
-- same title. p_type null says "none of the types". A correction never touches title_types or anyone else's
-- roles. A role the person's chosen types now include is shown; one they do not is left as it is.
create or replace function public.set_person_role_type(p_user uuid, p_job uuid, p_type text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  norm text;
  n integer;
  chosen text[];
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user then
    raise exception 'not your roles' using errcode = 'insufficient_privilege';
  end if;
  if p_type is not null and not exists (select 1 from public.role_types t where t.id = p_type and t.retired_at is null) then
    raise exception 'unknown role type' using errcode = '22023';
  end if;
  select j.title_norm into norm
    from public.jobs j join public.person_roles pr on pr.job_id = j.id and pr.user_id = p_user
   where j.id = p_job;
  if norm is null or norm = '' then
    raise exception 'this role has no title to correct' using errcode = '22023';
  end if;

  if p_type is null then
    delete from public.role_type_synonyms where user_id = p_user and title_norm = norm;
  else
    insert into public.role_type_synonyms (user_id, title_norm, role_type, source)
    values (p_user, norm, p_type, 'correction')
    on conflict (user_id, title_norm) do update set role_type = excluded.role_type, source = 'correction', created_at = now();
  end if;

  select coalesce(array(select jsonb_array_elements_text(coalesce(pf.preferences -> 'targeting' -> 'role_types', '[]'::jsonb))), '{}')
    into chosen from public.profiles pf where pf.id = p_user;

  update public.person_roles pr
     set role_type = p_type,
         hidden_reason = case when pr.hidden_reason = 'unclassified' and p_type = any (chosen) then null else pr.hidden_reason end
    from public.jobs j
   where j.id = pr.job_id and pr.user_id = p_user and j.title_norm = norm;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.set_person_role_type(uuid, uuid, text) from public, anon;
grant execute on function public.set_person_role_type(uuid, uuid, text) to authenticated, service_role;

-- Type a batch of stored roles by what code decided (rows: id, title_norm, dept_norm, role_type, type_origin,
-- type_prov). A role a model typed is left as it is; so is a title_types row a model answered.
create or replace function public.apply_title_types(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.jobs j
     set title_norm = r.title_norm, dept_norm = r.dept_norm, role_type = r.role_type, type_origin = r.type_origin, type_prov = r.type_prov
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(id uuid, title_norm text, dept_norm text, role_type text, type_origin text, type_prov jsonb)
   where j.id = r.id and j.type_origin is distinct from 'model';
  get diagnostics n = row_count;

  insert into public.title_types (title_norm, dept_norm, role_type, origin, prov, taxonomy_version, status, n_seen, typed_at)
  select r.title_norm, r.dept_norm, max(r.role_type), 'code', (array_agg(r.type_prov))[1],
         coalesce(max((r.type_prov ->> 'taxonomy_version')::integer), 1),
         case when max(r.role_type) is null then 'pending' else 'typed' end,
         count(*)::integer, case when max(r.role_type) is null then null else now() end
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(id uuid, title_norm text, dept_norm text, role_type text, type_origin text, type_prov jsonb)
   where r.title_norm <> ''
   group by r.title_norm, r.dept_norm
  on conflict (title_norm, dept_norm) do update
    set role_type = case when public.title_types.origin = 'code' then excluded.role_type else public.title_types.role_type end,
        prov = case when public.title_types.origin = 'code' then excluded.prov else public.title_types.prov end,
        taxonomy_version = case when public.title_types.origin = 'code' then excluded.taxonomy_version else public.title_types.taxonomy_version end,
        status = case when public.title_types.origin = 'code' then excluded.status else public.title_types.status end,
        typed_at = case when public.title_types.origin = 'code' then excluded.typed_at else public.title_types.typed_at end,
        n_seen = public.title_types.n_seen + excluded.n_seen;
  return n;
end;
$$;
revoke execute on function public.apply_title_types(jsonb) from public, anon, authenticated;
grant execute on function public.apply_title_types(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- The routine that types stored roles and maps old targets (enabled by 20261008057001)
-- ---------------------------------------------------------------------------

insert into public.routines (user_id, command, every, timezone, next_due_at, enabled, origin)
values (null, 'roles.retype', interval '10 minutes', 'UTC', now() + interval '10 minutes', false, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

-- ---------------------------------------------------------------------------
-- Measures
-- ---------------------------------------------------------------------------

-- T19 (reported): how new titles were typed, and what is still untyped.
create or replace function public.measure_t19()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer;
  untyped integer;
  by_model integer;
  t_code integer;
  t_model integer;
  t_none integer;
begin
  select count(*), count(*) filter (where role_type is null), count(*) filter (where type_origin = 'model')
    into total, untyped, by_model from public.jobs;
  select count(*) filter (where origin = 'code' and status = 'typed'),
         count(*) filter (where origin = 'model' and status = 'typed'),
         count(*) filter (where status in ('none', 'pending'))
    into t_code, t_model, t_none
    from public.title_types where coalesce(typed_at, now()) > now() - interval '7 days';
  return query select
    case when total > 0 then round(untyped::numeric / total, 4) end,
    null::boolean,
    total,
    format('%s of %s stored roles are untyped and %s needed a model. Titles typed this week: %s by code, %s by a model, %s not yet.',
           untyped, total, by_model, t_code, t_model, t_none);
end;
$$;

-- T20 (reported): while role_types_live is off, what the type step would keep that the old filter drops, and the reverse.
create or replace function public.measure_t20()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  keeps integer;
  drops integer;
  people integer;
begin
  select coalesce(sum(n) filter (where kind = 'shadow_keep'), 0), coalesce(sum(n) filter (where kind = 'shadow_drop'), 0), count(distinct user_id)
    into keeps, drops, people
    from public.person_counts where kind in ('shadow_keep', 'shadow_drop') and day > (now() at time zone 'utc')::date - 7;
  return query select (keeps + drops)::numeric, null::boolean, people,
    format('In the last 7 days the type step would keep %s roles the old filter dropped, and drop %s the old filter kept (%s people).', keeps, drops, people);
end;
$$;

revoke execute on function public.measure_t19(), public.measure_t20() from public, anon, authenticated;
grant execute on function public.measure_t19(), public.measure_t20() to service_role;

do $$
begin
  if (select "on" from public.instance_flags where key = 'role_types_live') then
    raise exception 'role_types_live must start off';
  end if;
end $$;
