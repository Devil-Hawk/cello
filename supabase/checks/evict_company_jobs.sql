-- Proves public.evict_company_jobs() (migration 20261007000100): it deletes the
-- named roles of one company that nothing points at, keeps a role an
-- application points at, leaves roles that were not named and another company's
-- roles alone, returns the ids it deleted, and refuses a signed-in user who does
-- not own the company. One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/evict_company_jobs.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as other_user, gen_random_uuid() as co, gen_random_uuid() as co2,
       gen_random_uuid() as free_job, gen_random_uuid() as applied_job, gen_random_uuid() as unnamed_job,
       gen_random_uuid() as other_co_job;
insert into auth.users (id, email) select user_id, 'evict-check@example.invalid' from fx union all
                                   select other_user, 'evict-check-2@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'evict-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select other_user, 'evict-check-2@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select co,  user_id, 'Amazon', 'https://amazon.jobs.invalid' from fx union all
select co2, user_id, 'Other',  'https://other.invalid' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id, source)
select free_job,    co,  'Free Role',     'd', 'https://p.invalid/1', 'ev-1', 'scraper' from fx union all
select applied_job, co,  'Applied Role',  'd', 'https://p.invalid/2', 'ev-2', 'scraper' from fx union all
select unnamed_job, co,  'Unnamed Role',  'd', 'https://p.invalid/3', 'ev-3', 'scraper' from fx union all
select other_co_job, co2, 'Other Co Role', 'd', 'https://p.invalid/4', 'ev-4', 'scraper' from fx;
insert into public.applications (user_id, job_id) select user_id, applied_job from fx;

-- The cron (no JWT) may evict for any company. The other company's id is named too: it is not this company's role.
select public.evict_company_jobs((select co from fx), array['ev-1', 'ev-2', 'ev-4']) as gone \gset
\echo gone: :gone

do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.jobs where id = f.free_job),      'a named free role should be deleted';
  assert     exists (select 1 from public.jobs where id = f.applied_job),   'a role with an application must stay';
  assert     exists (select 1 from public.applications where job_id = f.applied_job), 'its application survives';
  assert     exists (select 1 from public.jobs where id = f.unnamed_job),   'a role that was not named stays';
  assert     exists (select 1 from public.jobs where id = f.other_co_job),  'another company''s role stays';
  raise notice 'ALL EVICT ASSERTIONS PASSED';
end $$;

-- A signed-in user who does not own the company is refused.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', other_user)::text, true) from fx;
do $$
declare f record;
begin
  select * into f from fx;
  begin
    perform public.evict_company_jobs(f.co, array['ev-3']);
    raise exception 'should have been refused';
  exception when sqlstate '42501' then
    raise notice 'another user was refused';
  end;
end $$;

-- Fail closed: a signed-in role whose claims are missing or empty is refused too, and nothing is deleted.
select set_config('chk.co', co::text, true) from fx;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
do $$
begin
  begin
    perform public.evict_company_jobs(current_setting('chk.co')::uuid, array['ev-3']);
    raise exception 'should have been refused';
  exception when sqlstate '42501' then
    raise notice 'empty claims were refused';
  end;
end $$;
reset role;
do $$
declare f record;
begin
  select * into f from fx;
  assert exists (select 1 from public.jobs where id = f.unnamed_job), 'the role survives an empty-claims call';
  raise notice 'ROLE SURVIVED';
end $$;
rollback;
