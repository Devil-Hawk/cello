-- K6: the directory (blueprint 3.3 and part 6, "Verified directory and sweep", directive 31).
--
--   directory_candidates      what Cello knows but has not verified: the seed waiting for its turn, failed checks
--                             waiting for their next try. Written only by directory.seed and companies.verify;
--                             never listed and never counted.
--   search_company_directory / list_company_directory
--                             verified employers only, on the name_norm trigram index (and domain, and board token)
--   directory_candidates_due / directory_boards_due
--                             the order of a sweep slice: candidates first, then boards by next_read_at
--   upsert_directory_candidates, directory_progress
--   bump_employer_stats       the counters of every listing a read saw, by role type and level
--   upsert_employer_jobs      a role the sweep keeps for someone who does not follow its employer (company_id null)
--   T11, T26                  the measures the directory feeds
--   directory.sweep, directory.seed, suggestions.refresh   routine rows, off until 20261008060002

do $$
begin
  if (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'company_id') = 'NO' then
    raise exception 'apply the K5b contract (20261008055000) first: jobs.company_id must be nullable';
  end if;
  if to_regclass('public.jobs_employer_posting_key') is null then
    raise exception 'apply the K5b contract (20261008055000) first: jobs needs its one row per posting';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------

create table if not exists public.directory_candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  name_norm text not null,
  -- the YC website; null for a board-only row
  domain text check (domain is null or domain = lower(domain)),
  ats_provider text references public.ats_providers (id),
  -- null for a YC row with no board
  ats_token text check (ats_token ~ '^[A-Za-z0-9._-]{1,128}$'),
  source text not null check (source in ('kalil', 'yc')),
  state text not null default 'pending' check (state in ('pending', 'verified', 'failed')),
  employer_id uuid references public.company_directory (id) on delete set null,
  fail_reason text check (fail_reason in ('not_linked', 'other_owner', 'stale', 'no_board', 'cannot_read', 'not_employer_site')),
  failed_reads integer not null default 0,
  checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  seen_in_seed_at timestamptz not null default now(),
  -- what the YC list says about the company: the vocabulary of "Suggested for you" (lib/companies/similarity.ts)
  tags text[] not null default '{}',
  one_liner text check (char_length(one_liner) <= 300),
  batch text,
  team_size integer,
  regions text[] not null default '{}',
  locations text check (char_length(locations) <= 500),
  profile_url text check (profile_url ~ '^https://'),
  unique (ats_provider, ats_token)
);

create unique index if not exists directory_candidates_domain_key on public.directory_candidates (domain) where domain is not null;
create index if not exists directory_candidates_name_trgm on public.directory_candidates using gin (name_norm gin_trgm_ops);
create index if not exists directory_candidates_next_idx on public.directory_candidates (next_check_at) where state in ('pending', 'failed');

alter table public.directory_candidates enable row level security;
revoke all on public.directory_candidates from public, anon, authenticated;
grant all on public.directory_candidates to service_role;

-- A board that did not answer is counted; at 3 it leaves the rotation (part 6, re-verification).
alter table public.company_directory add column if not exists failed_reads integer not null default 0;

-- The seed's entries, only new or changed ones written. A changed name sends a verified or failed entry back to
-- pending so the verifier looks at it again. Rows with a board are keyed by it, rows without by their website.
create or replace function public.upsert_directory_candidates(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  k integer;
begin
  insert into public.directory_candidates (name, name_norm, domain, ats_provider, ats_token, source, tags, one_liner, batch, team_size, regions, locations, profile_url)
  select r.name, r.name_norm, null, r.ats_provider, r.ats_token, r.source, coalesce(r.tags, '{}'), r.one_liner, r.batch, r.team_size, coalesce(r.regions, '{}'), r.locations, r.profile_url
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(name text, name_norm text, domain text, ats_provider text, ats_token text, source text, tags text[], one_liner text, batch text, team_size integer, regions text[], locations text, profile_url text)
   where r.ats_provider is not null
  on conflict (ats_provider, ats_token) do update
     set seen_in_seed_at = now(),
         name = excluded.name,
         name_norm = excluded.name_norm,
         state = case when public.directory_candidates.name_norm is distinct from excluded.name_norm then 'pending' else public.directory_candidates.state end,
         next_check_at = case when public.directory_candidates.name_norm is distinct from excluded.name_norm then now() else public.directory_candidates.next_check_at end
   where public.directory_candidates.name_norm is distinct from excluded.name_norm
      or public.directory_candidates.seen_in_seed_at < now() - interval '1 day';
  get diagnostics k = row_count;
  n := n + k;

  insert into public.directory_candidates (name, name_norm, domain, ats_provider, ats_token, source, tags, one_liner, batch, team_size, regions, locations, profile_url)
  select r.name, r.name_norm, r.domain, null, null, r.source, coalesce(r.tags, '{}'), r.one_liner, r.batch, r.team_size, coalesce(r.regions, '{}'), r.locations, r.profile_url
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(name text, name_norm text, domain text, ats_provider text, ats_token text, source text, tags text[], one_liner text, batch text, team_size integer, regions text[], locations text, profile_url text)
   where r.ats_provider is null and nullif(r.domain, '') is not null
  on conflict (domain) where domain is not null do update
     set seen_in_seed_at = now(),
         name = excluded.name,
         name_norm = excluded.name_norm,
         tags = excluded.tags,
         one_liner = excluded.one_liner,
         batch = excluded.batch,
         team_size = excluded.team_size,
         regions = excluded.regions,
         locations = excluded.locations,
         profile_url = excluded.profile_url,
         state = case when public.directory_candidates.name_norm is distinct from excluded.name_norm then 'pending' else public.directory_candidates.state end,
         next_check_at = case when public.directory_candidates.name_norm is distinct from excluded.name_norm then now() else public.directory_candidates.next_check_at end;
  get diagnostics k = row_count;
  return n + k;
end;
$$;

revoke execute on function public.upsert_directory_candidates(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_directory_candidates(jsonb) to service_role;

-- What a slice checks first (part 6): candidates whose domain or name is one somebody follows, then YC rows,
-- then the rest oldest first. Pending ones and failed ones whose 90 days are over.
create or replace function public.directory_candidates_due(p_limit integer default 60)
returns setof public.directory_candidates
language sql
stable
security definer
set search_path = ''
as $$
  with followed as (
    select lower(nullif(btrim(c.domain), '')) as d, lower(btrim(c.name)) as n from public.companies c where c.watching
  )
  select c.* from public.directory_candidates c
   where c.state in ('pending', 'failed') and c.next_check_at <= now()
   order by ((c.domain is not null and c.domain in (select f.d from followed f where f.d is not null))
             or lower(c.name) in (select f.n from followed f)) desc,
            (c.source = 'yc') desc,
            c.next_check_at, c.id
   limit least(greatest(p_limit, 1), 200)
$$;

revoke execute on function public.directory_candidates_due(integer) from public, anon, authenticated;
grant execute on function public.directory_candidates_due(integer) to service_role;

-- The boards a slice reads: those with a posting in the last 30 days first, then by next_read_at.
create or replace function public.directory_boards_due(p_limit integer default 100)
returns setof public.company_directory
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.company_directory d
   where d.verified_at is not null and d.ats_provider is not null and d.cannot_read_reason is null
     and coalesce(d.next_read_at, now()) <= now()
   order by exists (select 1 from public.employer_stats s where s.employer_id = d.id and s.opened_30d > 0) desc,
            coalesce(d.next_read_at, d.verified_at), d.id
   limit least(greatest(p_limit, 1), 500)
$$;

revoke execute on function public.directory_boards_due(integer) from public, anon, authenticated;
grant execute on function public.directory_boards_due(integer) to service_role;

-- "Cello has checked 1,200 employers so far": the seed's progress, by state.
create or replace function public.directory_progress()
returns table (verified bigint, pending bigint, failed bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.company_directory where verified_at is not null),
         (select count(*) from public.directory_candidates where state = 'pending'),
         (select count(*) from public.directory_candidates where state = 'failed')
$$;

revoke execute on function public.directory_progress() from public, anon, authenticated;
grant execute on function public.directory_progress() to service_role;

-- ---------------------------------------------------------------------------
-- Search and list: verified rows only
-- ---------------------------------------------------------------------------

create index if not exists company_directory_name_trgm on public.company_directory using gin (name_norm gin_trgm_ops);
create index if not exists company_directory_domain_trgm on public.company_directory using gin (domain gin_trgm_ops);
create index if not exists company_directory_token_idx on public.company_directory (ats_token);

-- The same key lib/entities/companies.ts normalizeCompanyName gives a name: lower case, legal words dropped,
-- everything but letters and digits a single space. "Gusto, Inc." and "gusto" are one key.
create or replace function public.company_name_norm(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[.,]', ' ', 'g'),
         '\y(inc|llc|ltd|limited|gmbh|corp|co|company|the)\y', ' ', 'g'), '[^a-z0-9]+', ' ', 'g'))
$$;

revoke execute on function public.company_name_norm(text) from public, anon;
grant execute on function public.company_name_norm(text) to authenticated, service_role;

-- Names, domains and board tokens, best match first: the exact name or domain, then a prefix, then the closest.
-- "retell", "retellai.com" and "retell-ai" all find Retell AI. A row that is not verified is never here.
create or replace function public.search_company_directory(p_query text, p_limit integer default 8)
returns setof public.company_directory
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select d.* from public.company_directory d,
         lateral (select lower(btrim(p_query)) as raw, public.company_name_norm(p_query) as norm) q
   where d.verified_at is not null
     and q.norm <> ''
     and (d.name_norm like q.norm || '%'
          or d.name_norm % q.norm
          or d.domain = q.raw
          or d.ats_token = q.raw)
   order by (d.name_norm = q.norm or d.domain = q.raw) desc,
            (d.name_norm like q.norm || '%') desc,
            similarity(d.name_norm, q.norm) desc,
            d.open_count desc nulls last,
            d.id
   limit least(greatest(p_limit, 1), 50)
$$;

-- The employers, most open roles first, a page at a time. Verified rows only.
create or replace function public.list_company_directory(p_limit integer default 50, p_offset integer default 0)
returns setof public.company_directory
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select d.* from public.company_directory d
   where d.verified_at is not null
   order by d.open_count desc nulls last, d.name_norm, d.id
   limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
$$;

revoke execute on function public.search_company_directory(text, integer), public.list_company_directory(integer, integer) from public, anon, authenticated;
grant execute on function public.search_company_directory(text, integer), public.list_company_directory(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- employer_stats counters
-- ---------------------------------------------------------------------------

-- p_rows: [{role_type, seniority, open, opened_30d, opened_90d, stated_pay}] for one employer's read, every
-- listing counted whether it is stored or not. Replaces the employer's rows: a read is the whole list.
create or replace function public.bump_employer_stats(p_employer uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.employer_stats where employer_id = p_employer;
  insert into public.employer_stats (employer_id, role_type, seniority, type_origin, open_count, opened_30d, opened_90d, stated_pay, read_at)
  select p_employer, nullif(r ->> 'role_type', ''), nullif(r ->> 'seniority', ''), case when nullif(r ->> 'role_type', '') is null then null else 'code' end,
         coalesce((r ->> 'open')::integer, 0), coalesce((r ->> 'opened_30d')::integer, 0), coalesce((r ->> 'opened_90d')::integer, 0),
         r -> 'stated_pay', now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where (r ->> 'role_type') is null or exists (select 1 from public.role_types t where t.id = r ->> 'role_type')
  on conflict (employer_id, role_type, seniority) do update
     set open_count = public.employer_stats.open_count + excluded.open_count,
         opened_30d = public.employer_stats.opened_30d + excluded.opened_30d,
         opened_90d = public.employer_stats.opened_90d + excluded.opened_90d,
         read_at = excluded.read_at;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.bump_employer_stats(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.bump_employer_stats(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Roles kept for someone who does not follow the employer
-- ---------------------------------------------------------------------------

-- p_employer's roles with company_id null, one row per (employer, posting): the columns upsert_shared_jobs writes.
create or replace function public.upsert_employer_jobs(p_employer uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if not exists (select 1 from public.company_directory d where d.id = p_employer and d.verified_at is not null) then
    raise exception 'not a verified employer' using errcode = '22023';
  end if;
  insert into public.jobs (
    company_id, employer_id, posting_key, external_id, title, description, url, location, salary_range, posted_at,
    is_new, discovered_at, job_function, seniority, language, country, is_remote, job_type, quality_score,
    source, source_tier, last_seen_at, requirements, requirements_extracted_at,
    title_norm, dept_norm, role_type, type_origin, type_prov,
    description_md, description_state, description_source, apply_url, description_md5
  )
  select null, p_employer, coalesce(nullif(r.external_id, ''), md5(r.url)), r.external_id, r.title, r.description, r.url,
         r.location, r.salary_range, r.posted_at, coalesce(r.is_new, true), coalesce(r.discovered_at, now()), r.job_function,
         r.seniority, r.language, r.country, r.is_remote, r.job_type, r.quality_score, r.source, r.source_tier,
         coalesce(r.last_seen_at, now()), r.requirements, r.requirements_extracted_at,
         r.title_norm, r.dept_norm, r.role_type, r.type_origin, r.type_prov,
         r.description_md, r.description_state, r.description_source, r.apply_url, r.description_md5
    from jsonb_populate_recordset(null::public.jobs, coalesce(p_rows, '[]'::jsonb)) r
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

revoke execute on function public.upsert_employer_jobs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_employer_jobs(uuid, jsonb) to service_role;

-- The employer's stored roles by normalised title, or by posting id: what tracing a lead looks for.
create or replace function public.employer_roles(p_employer uuid, p_title_norm text default null, p_external_ids text[] default null)
returns table (id uuid, external_id text, location text)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.external_id, j.location from public.jobs j
   where j.employer_id = p_employer
     and (p_title_norm is null or j.title_norm = p_title_norm)
     and (p_external_ids is null or j.external_id = any(p_external_ids))
   limit 200
$$;

revoke execute on function public.employer_roles(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.employer_roles(uuid, text, text[]) to service_role;

-- What a read of an employer saw: the roles it listed are stamped open and seen, the rest of the employer's roles
-- from the same sources count a miss and close at the second. record_job_sightings does this by company; a shared role
-- is the employer's, so this does it by employer. An empty list is never evidence that anything closed.
create or replace function public.record_employer_sightings(
  p_employer uuid,
  p_external_ids text[],
  p_sources text[],
  p_close_after integer default 2
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen integer := 0;
  v_missed integer := 0;
  v_closed integer := 0;
  v_at timestamptz := now();
begin
  if coalesce(cardinality(p_external_ids), 0) = 0 then
    return jsonb_build_object('seen', 0, 'missed', 0, 'closed', 0);
  end if;

  update public.jobs j
     set last_seen_at = v_at, last_verified_at = v_at, missed_checks = 0, still_open = true, closed_at = null
   where j.employer_id = p_employer and j.external_id = any(p_external_ids);
  get diagnostics v_seen = row_count;

  with missed as (
    update public.jobs j
       set missed_checks = j.missed_checks + 1,
           still_open = case when j.missed_checks + 1 >= p_close_after then false else j.still_open end,
           closed_at = case when j.missed_checks + 1 >= p_close_after and j.still_open is not false then v_at else j.closed_at end
     where j.employer_id = p_employer
       and (j.external_id is null or j.external_id <> all(p_external_ids))
       and cardinality(p_sources) > 0
       and (j.source is null or j.source = any(p_sources))
       and j.still_open is not false
       and j.last_seen_at < v_at
    returning j.still_open
  )
  select count(*), count(*) filter (where still_open is false) into v_missed, v_closed from missed;

  return jsonb_build_object('seen', v_seen, 'missed', v_missed, 'closed', v_closed);
end;
$$;

revoke execute on function public.record_employer_sightings(uuid, text[], text[], integer) from public, anon, authenticated;
grant execute on function public.record_employer_sightings(uuid, text[], text[], integer) to service_role;

-- ---------------------------------------------------------------------------
-- Measures
-- ---------------------------------------------------------------------------

-- T1 (wrong-employer roles stored) is the owner's live check (scripts/check-sourcing.ts): no SQL stands in for it.
-- T24 and T25 are the owner's two runs (35 names, 20 links), written as measure_runs by the directory scripts.

-- T11: directory full-cycle days (reported). How long ago the board read longest ago was read.
create or replace function public.measure_t11()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  oldest numeric;
begin
  select count(*), round(extract(epoch from (now() - min(coalesce(last_read_at, verified_at)))) / 86400.0, 1)
    into n, oldest from public.company_directory where verified_at is not null and ats_provider is not null and cannot_read_reason is null;
  return query select oldest, null::boolean, n,
    case when n = 0 then 'No verified employer yet.' else format('The employer read longest ago was read %s days ago; %s employers are in the rotation.', oldest, n) end;
end;
$$;

-- T26: the share of the seed's candidates verified or failed (not pending), and the first days' pace projected.
create or replace function public.measure_t26()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer;
  done integer;
  first_day timestamptz;
  per_day numeric;
begin
  select count(*), count(*) filter (where state <> 'pending'), min(checked_at) into total, done, first_day from public.directory_candidates;
  if total = 0 then
    return query select null::numeric, null::boolean, 0, 'No seed loaded yet.'::text;
    return;
  end if;
  if first_day is null then
    return query select 0::numeric, null::boolean, total, format('%s candidates wait for their first check.', total);
    return;
  end if;
  per_day := done / greatest(extract(epoch from (now() - first_day)) / 86400.0, 1);
  return query select round(done::numeric / total, 4),
    case when done::numeric / total >= 0.9 then true when (total - done) / nullif(per_day, 0) <= 30 then null else false end,
    total,
    format('%s of %s candidates are verified or failed, at about %s a day.', done, total, round(per_day));
end;
$$;

revoke execute on function public.measure_t11(), public.measure_t26() from public, anon, authenticated;
grant execute on function public.measure_t11(), public.measure_t26() to service_role;

-- Leads take the traced path (lib/sources/trace-leads.ts) only once the directory has filled: off until 20261008060003, applied when the T26 measure shows the fill far along.
insert into public.instance_flags (key, "on", note)
values ('directory_leads', false, 'off: a lead keeps its old path; on: a lead becomes a role only when traced to the employer''s own posting, else a count')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Routines of the clock, off until the seed load is measured (20261008060002)
-- ---------------------------------------------------------------------------

insert into public.routines (user_id, command, every, local_time, timezone, next_due_at, enabled, origin) values
  (null, 'directory.sweep',     interval '30 minutes', null,    'UTC', null, false, 'default'),
  (null, 'directory.seed',      null,                  '04:00', 'UTC', null, false, 'default'),
  (null, 'suggestions.refresh', null,                  '14:30', 'UTC', null, false, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

do $$
begin
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'directory_candidates' and grantee in ('anon', 'authenticated')) then
    raise exception 'directory_candidates must not be readable by a person';
  end if;
  if (select count(*) from public.routines where user_id is null and command in ('directory.sweep', 'directory.seed', 'suggestions.refresh')) <> 3 then
    raise exception 'the three directory routines must exist';
  end if;
end $$;
