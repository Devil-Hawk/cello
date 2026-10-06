-- A role row is shared by every follower of an employer, so what one person's resume, key or choices
-- produced must not live on it: a match score and its details (the scorer's resume and key) and the
-- new flag (one person's check knocks the role out) belong on that person's own person_roles row.
-- Only the service role writes them; a signed-in person keeps saved_at and hidden_reason (060009).
-- Apply after the code that reads person_jobs and writes person_roles has been deployed.

alter table public.person_roles
  add column if not exists match_score integer,
  add column if not exists match_details jsonb,
  add column if not exists is_new boolean not null default true;

-- What a shared row already holds goes to the person who owns jobs.company_id (the one who stored it),
-- never over a value that person already has.
update public.person_roles pr
   set match_score = j.match_score, match_details = j.match_details
  from public.jobs j
  join public.companies c on c.id = j.company_id
 where pr.job_id = j.id and pr.user_id = c.user_id
   and pr.match_score is null and pr.match_details is null
   and (j.match_score is not null or j.match_details is not null);

update public.person_roles pr
   set is_new = false
  from public.jobs j
  join public.companies c on c.id = j.company_id
 where pr.job_id = j.id and pr.user_id = c.user_id
   and pr.is_new and not j.is_new;

drop trigger if exists jobs_score_is_the_servers on public.jobs;
drop function if exists public.jobs_score_is_the_servers();

-- Values are copied above; nothing a holder can read stays on the shared row.
update public.jobs
   set match_score = null, match_details = null, is_new = true
 where match_score is not null or match_details is not null or not is_new;

-- The one place every writer goes through, the service role included.
create or replace function public.jobs_hold_no_person_values()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.match_score := null;
  new.match_details := null;
  new.is_new := true;
  return new;
end;
$$;

revoke all on function public.jobs_hold_no_person_values() from public, anon, authenticated;

drop trigger if exists jobs_hold_no_person_values on public.jobs;
create trigger jobs_hold_no_person_values
  before insert or update of match_score, match_details, is_new on public.jobs
  for each row execute function public.jobs_hold_no_person_values();

-- The shared columns by name, then the viewer's own score, details and flag.
drop view if exists public.person_jobs;
create view public.person_jobs
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
       j.id, j.company_id, j.title, j.description, j.url, j.location, j.salary_range, j.job_type,
       j.posted_at, j.discovered_at, j.external_id, j.job_function, j.seniority, j.language, j.country,
       j.is_remote, j.source, j.quality_score, j.last_verified_at, j.still_open, j.tsv, j.last_seen_at,
       j.missed_checks, j.closed_at, j.requirements, j.requirements_extracted_at, j.employer_id,
       j.posting_key, j.source_tier, j.legit_label, j.title_norm, j.dept_norm, j.role_type, j.type_origin,
       j.type_prov, j.description_md, j.description_state, j.description_source, j.apply_url, j.description_md5,
       pr.match_score,
       pr.match_details,
       pr.is_new,
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

revoke all on public.person_jobs from public, anon;
grant select on public.person_jobs to authenticated, service_role;

create or replace function public.distill_match_score_by_score_band(p_user_id uuid)
returns table (band text, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    case
      when pr.match_score <= 49 then '0-49'
      when pr.match_score <= 69 then '50-69'
      when pr.match_score <= 84 then '70-84'
      else '85-100'
    end as band,
    count(*) filter (where a.stage in ('interview', 'offer', 'accepted')) as positive_count,
    count(*) filter (where a.stage = 'rejected') as negative_count,
    array_agg(v.id) as verdict_ids
  from public.eval_verdicts v
  join public.jobs j on j.id = v.subject_id
  join public.person_roles pr on pr.job_id = j.id and pr.user_id = p_user_id
  join public.applications a on a.job_id = j.id and a.user_id = p_user_id
  where v.user_id = p_user_id
    and v.subject_kind = 'match_score'
    and pr.match_score is not null
    and a.stage in ('interview', 'offer', 'accepted', 'rejected')
  group by band;
$$;

do $$
declare
  c text;
begin
  foreach c in array array['match_score', 'match_details', 'is_new'] loop
    if not exists (select 1 from pg_attribute where attrelid = 'public.person_roles'::regclass and attname = c and not attisdropped) then
      raise exception 'person_roles.% is missing', c;
    end if;
    if has_column_privilege('authenticated', 'public.person_roles', c, 'UPDATE') then
      raise exception 'a signed-in person may update person_roles.%', c;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.person_roles', 'INSERT') then
    raise exception 'a signed-in person may insert person_roles';
  end if;
  if exists (select 1 from public.jobs where match_score is not null or match_details is not null or not is_new) then
    raise exception 'a shared role still holds a person''s value';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_hold_no_person_values') then
    raise exception 'jobs_hold_no_person_values is missing';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.person_jobs'::regclass and attname = 'match_score') then
    raise exception 'person_jobs has no match_score';
  end if;
end $$;

notify pgrst, 'reload schema';
