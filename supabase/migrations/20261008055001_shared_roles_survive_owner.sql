-- K5b, after the contract (20261008055000): a shared role outlives the follower whose company stored it first.
--
-- jobs.company_id still cascades, and a shared posting keeps the first follower's company_id. Without this, that
-- follower removing the company (or deleting their account) deleted the role for everyone else, and with it their
-- person_roles row and their applications.
--
-- Before a company goes, each role another person also holds is handed to one of those holders' company at the same
-- employer (or to none: company_id may be null since the contract). A role only the leaving person holds still
-- cascades as before. What the leaving person held of a handed role goes with their company, unless they saved it or
-- applied to it.

create or replace function public.keep_shared_roles_on_company_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.person_roles pr
   using public.jobs j
   where j.id = pr.job_id
     and j.company_id = old.id
     and pr.user_id = old.user_id
     and pr.saved_at is null
     and not exists (select 1 from public.applications a where a.job_id = j.id and a.user_id = old.user_id)
     and exists (select 1 from public.person_roles o where o.job_id = j.id and o.user_id <> old.user_id);

  update public.jobs j
     set company_id = (
       select c.id
         from public.companies c
         join public.person_roles pr on pr.user_id = c.user_id and pr.job_id = j.id
        where c.user_id <> old.user_id
          and j.employer_id is not null
          and c.employer_id = j.employer_id
          and not exists (select 1 from public.jobs j2 where j2.company_id = c.id and j2.external_id = j.external_id)
        limit 1)
   where j.company_id = old.id
     and exists (select 1 from public.person_roles o where o.job_id = j.id and o.user_id <> old.user_id);

  return old;
end;
$$;

revoke execute on function public.keep_shared_roles_on_company_delete() from public, anon, authenticated;

drop trigger if exists keep_shared_roles_on_company_delete on public.companies;
create trigger keep_shared_roles_on_company_delete
  before delete on public.companies
  for each row execute function public.keep_shared_roles_on_company_delete();
