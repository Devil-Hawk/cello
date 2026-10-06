-- A person's roles as one view: the roles they hold (person_roles) with the role's own columns, and
-- the person's own company for it. A shared role has one `jobs` row, so company_id is only the
-- company of whoever stored it first; viewer_company_id is the viewer's.
--
-- security_invoker: a signed-in person reads through their own row level security (person_roles and
-- companies are theirs alone). The service role bypasses it, so it filters on viewer_id.
-- The person's columns come first so later migrations can grow the view with `j.*` at the end.

create or replace view public.person_jobs
with (security_invoker = true)
as
select pr.user_id as viewer_id,
       pr.visible_since,
       pr.saved_at,
       pr.hidden_reason,
       vc.id as viewer_company_id,
       vc.name as viewer_company_name,
       j.*
  from public.jobs j
  join public.person_roles pr on pr.job_id = j.id
  left join lateral (
    select c.id, c.name
      from public.companies c
     where c.user_id = pr.user_id
       and (c.id = j.company_id or (j.employer_id is not null and c.employer_id = j.employer_id))
     order by (c.id = j.company_id) desc
     limit 1
  ) vc on true;

revoke all on public.person_jobs from public, anon;
grant select on public.person_jobs to authenticated, service_role;

do $$
begin
  if (select a.attname from pg_attribute a
       where a.attrelid = 'public.person_jobs'::regclass and a.attnum > 0 order by a.attnum limit 1) <> 'viewer_id' then
    raise exception 'person_jobs must start with viewer_id';
  end if;
end $$;
