-- The verdict on a role reaches a person through the same view as the role.
--
-- person_jobs (20261008060013) is the one place a person reads the roles they hold: the posting's columns,
-- their own company for it, and their own score and flags. What Cello concluded about the role for them
-- (20261009000200: the facts it breaks, how likely they are to want it, their chance with cited evidence)
-- is on the same person_roles row, so it is added to the view. Without it every list would read the view for
-- the company and person_roles again for the verdict.
--
-- Appending columns to the end of a view keeps its grants and its dependents; no row is read or changed.

create or replace view public.person_jobs
with (security_invoker = true)
as
select pr.user_id as viewer_id,
       pr.visible_since,
       pr.saved_at,
       pr.hidden_reason,
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
       pr.role_type as viewer_role_type,
       pr.assessed_at,
       pr.blocked_reasons,
       pr.want_p,
       pr.want_reason,
       pr.want_detail,
       pr.chance,
       pr.chance_detail
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

do $$
declare
  c text;
begin
  foreach c in array array['assessed_at', 'blocked_reasons', 'want_p', 'want_reason', 'want_detail', 'chance', 'chance_detail'] loop
    if not exists (select 1 from pg_attribute where attrelid = 'public.person_jobs'::regclass and attname = c and not attisdropped) then
      raise exception 'person_jobs has no %', c;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.person_jobs', 'SELECT') then
    raise exception 'anon can read person_jobs';
  end if;
  if not has_table_privilege('authenticated', 'public.person_jobs', 'SELECT') then
    raise exception 'authenticated cannot read person_jobs';
  end if;
end $$;

notify pgrst, 'reload schema';
