-- K5b follow-up: a signed-in person cannot put a role into what other people read.
--
-- A role with an employer (employer_id set) is shared: the clock offers it to everyone whose targets match, and
-- every follower reads its title and apply link. Only the service role writes one.
--
--   1. upsert_shared_jobs is the shared write and overwrites an existing row on conflict, so it is no longer
--      callable by a signed-in person. The in-app check passes its service-role client to the store.
--   2. Insert by a signed-in person is the same door: the trigger fills employer_id from the company, so the
--      policy now refuses any row that ends up with an employer. A company linked to an employer can no longer
--      be used to write a role by hand.
--   3. A Gmail placeholder is the person's own and stays so: it carries no employer, so it cannot collide with
--      a real posting and never reaches another person's reads.
--   4. A role with no employer that is later given one (the service-role read adopts it) starts from the read:
--      what a person wrote into its body, apply link and type does not carry over to the shared row.
--   5. person_jobs was dropped and made again in 058000 without the revoke 050001 had.

revoke execute on function public.upsert_shared_jobs(jsonb) from authenticated;

drop policy if exists "Users can insert jobs for own companies" on public.jobs;
create policy "Users can insert jobs for own companies"
  on public.jobs for insert to authenticated
  with check (
    jobs.employer_id is null
    and exists (select 1 from public.companies where companies.id = jobs.company_id and companies.user_id = (select auth.uid()))
  );

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
  if new.employer_id is null and new.company_id is not null and new.source is distinct from 'gmail_sync' and new.source is distinct from 'gmail_share' then
    select c.employer_id into new.employer_id from public.companies c where c.id = new.company_id;
  end if;
  return new;
end;
$$;

create or replace function public.jobs_clear_on_adopt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.apply_url := null;
  new.description_md := null;
  new.description_md5 := null;
  new.description_state := null;
  new.description_source := null;
  new.role_type := null;
  new.type_origin := null;
  new.type_prov := null;
  return new;
end;
$$;

drop trigger if exists jobs_clear_on_adopt on public.jobs;
create trigger jobs_clear_on_adopt
  before update of employer_id on public.jobs
  for each row when (old.employer_id is null and new.employer_id is not null)
  execute function public.jobs_clear_on_adopt();
revoke all on function public.jobs_clear_on_adopt() from public, anon, authenticated;

revoke all on public.person_jobs from public, anon;
grant select on public.person_jobs to authenticated, service_role;
