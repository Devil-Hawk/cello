-- Proves K15's one SQL change (migration 20261015000000) and the mem0 scope:
--   * an application at applied or later with no reaction gets one `applied` reaction on
--     the `applications` surface, and a second run adds none;
--   * an application still at discovered gets none, and a reaction the person already made
--     for the role is left as it was;
--   * mem0 keeps its tables in the `mem0` schema: no learnings table ever lands in `public`
--     (the schema scoping of lib/memory/mem0-store.ts, checked wherever mem0 has run).
-- One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/learning_writer_k15.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as company_id,
       gen_random_uuid() as applied_job, gen_random_uuid() as discovered_job, gen_random_uuid() as passed_job;
insert into auth.users (id, email) select user_id, 'learning-k15@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'learning-k15@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url) select company_id, user_id, 'Learning Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id)
select applied_job, company_id, 'applied role', 'd', 'https://x/k15-1', 'k15-1' from fx
union all select discovered_job, company_id, 'discovered role', 'd', 'https://x/k15-2', 'k15-2' from fx
union all select passed_job, company_id, 'passed role', 'd', 'https://x/k15-3', 'k15-3' from fx;

insert into public.applications (user_id, job_id, stage, source)
select user_id, applied_job, 'applied', 'manual' from fx
union all select user_id, discovered_job, 'discovered', 'manual' from fx
union all select user_id, passed_job, 'interview', 'manual' from fx;

-- The history from before the trigger existed: applications with no reaction, and one
-- reaction the person made themselves.
delete from public.role_reactions r using fx f where r.user_id = f.user_id;
insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title)
select user_id, passed_job, 'not_for_me', 'pay', 'roles', 'passed role' from fx;

\ir ../migrations/20261015000000_learning.sql

do $$
declare f record;
begin
  select * into f from fx;
  assert (select count(*) from public.role_reactions where user_id = f.user_id and job_id = f.applied_job and reaction = 'applied' and surface = 'applications') = 1,
    'the applied application should have one applied reaction on the applications surface';
  assert not exists (select 1 from public.role_reactions where user_id = f.user_id and job_id = f.discovered_job),
    'an application still at discovered must get no reaction';
  assert (select reaction from public.role_reactions where user_id = f.user_id and job_id = f.passed_job) = 'not_for_me',
    'a reaction the person made must not be overwritten by their application history';
  assert (select count(*) from public.role_reactions where user_id = f.user_id) = 2, 'two reactions in all';
end $$;

\ir ../migrations/20261015000000_learning.sql

do $$
declare f record;
begin
  select * into f from fx;
  assert (select count(*) from public.role_reactions where user_id = f.user_id) = 2, 'a second run must add nothing';
  assert not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name like 'learnings%'
  ), 'a mem0 learnings table landed in public: mem0 must stay in its own schema';
  raise notice 'ALL K15 ASSERTIONS PASSED';
end $$;

rollback;
