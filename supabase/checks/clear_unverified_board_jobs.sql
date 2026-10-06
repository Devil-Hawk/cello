-- Proves public.clear_unverified_board_jobs() (migration 20261005200002): it
-- deletes the roles one provider wrote for one company, keeps (and closes) a
-- role an application points at, leaves another provider's roles and another
-- company's roles alone, and refuses a signed-in user who does not own the
-- company. One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/clear_unverified_board_jobs.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as other_user, gen_random_uuid() as co, gen_random_uuid() as co2,
       gen_random_uuid() as free_job, gen_random_uuid() as applied_job, gen_random_uuid() as other_source_job,
       gen_random_uuid() as other_co_job;
insert into auth.users (id, email) select user_id, 'clear-board-check@example.invalid' from fx union all
                                   select other_user, 'clear-board-check-2@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'clear-board-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select other_user, 'clear-board-check-2@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select co,  user_id, 'Amazon', 'https://amazon.jobs.invalid' from fx union all
select co2, user_id, 'Other',  'https://other.invalid' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id, source)
select free_job,         co,  'SEO Marketing Manager', 'd', 'https://p.invalid/1', 'cb-1', 'personio' from fx union all
select applied_job,      co,  'Applied Role',          'd', 'https://p.invalid/2', 'cb-2', 'personio' from fx union all
select other_source_job, co,  'Greenhouse Role',       'd', 'https://g.invalid/1', 'cb-3', 'greenhouse' from fx union all
select other_co_job,     co2, 'Other Co Role',         'd', 'https://p.invalid/3', 'cb-4', 'personio' from fx;
insert into public.applications (user_id, job_id) select user_id, applied_job from fx;

-- The cron (no JWT) may clear any company.
select * from public.clear_unverified_board_jobs((select co from fx), 'personio') \gset
\echo deleted: :deleted closed: :closed

do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.jobs where id = f.free_job),        'a free role should be deleted';
  assert     exists (select 1 from public.jobs where id = f.applied_job),     'a role with an application must stay';
  assert (select still_open from public.jobs where id = f.applied_job) is false, 'and be marked closed';
  assert     exists (select 1 from public.applications where job_id = f.applied_job), 'its application survives';
  assert     exists (select 1 from public.jobs where id = f.other_source_job), 'another provider''s role stays';
  assert     exists (select 1 from public.jobs where id = f.other_co_job),    'another company''s role stays';
  raise notice 'ALL CLEAR-BOARD ASSERTIONS PASSED';
end $$;

-- A signed-in user who does not own the company is refused.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', other_user)::text, true) from fx;
do $$
declare f record;
begin
  select * into f from fx;
  begin
    perform * from public.clear_unverified_board_jobs(f.co, 'personio');
    raise exception 'should have been refused';
  exception when sqlstate '42501' then
    raise notice 'another user was refused';
  end;
end $$;

-- Fail closed: a signed-in role whose claims are missing or empty is refused too, and nothing is deleted.
insert into public.jobs (id, company_id, title, description, url, external_id, source)
select gen_random_uuid(), co, 'Fresh Role', 'd', 'https://p.invalid/9', 'cb-9', 'personio' from fx;
select set_config('chk.co', co::text, true) from fx;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
do $$
begin
  begin
    perform * from public.clear_unverified_board_jobs(current_setting('chk.co')::uuid, 'personio');
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
  assert exists (select 1 from public.jobs where id = (select id from public.jobs where external_id = 'cb-9')), 'the role survives an empty-claims call';
  raise notice 'ROLE SURVIVED';
end $$;
rollback;
