-- Drop jobs.tsv: the production database is 561 MB against the 500 MB free-plan quota and grows about 60 MB a day.
-- public.jobs is 489 MB of it (heap 33 MB, TOAST 387 MB, indexes 68 MB, 29,586 rows). jobs.tsv, a stored tsvector
-- of the title and the first 20000 characters of the description, holds 119 MB, and its GIN index idx_jobs_tsv holds
-- 40 MB with 0 scans since the database was created. The only reader now searches the title through
-- idx_jobs_title_trgm. The free quota forced this.
--
-- person_jobs listed j.tsv, so it is recreated without it (same columns otherwise, same grants as 20261008050001).

drop view public.person_jobs;
drop index if exists public.idx_jobs_tsv;
alter table public.jobs drop column if exists tsv;

create view public.person_jobs
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
       j.is_remote, j.source, j.quality_score, j.last_verified_at, j.still_open, j.last_seen_at,
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

revoke all on public.person_jobs from public, anon;
grant select on public.person_jobs to authenticated, service_role;
