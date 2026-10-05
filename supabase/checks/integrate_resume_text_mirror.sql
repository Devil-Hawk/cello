-- Proves the resume_text mirror trigger (migration 20261009000700): the latest
-- BASE version's content is mirrored into profiles.resume_text on insert and on
-- delete, tailored versions never touch it, and deleting every base version
-- leaves the last text in place. One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/integrate_resume_text_mirror.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as company_id, gen_random_uuid() as job_id;
insert into auth.users (id, email) select user_id, 'mirror-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'mirror-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select company_id, user_id, 'Mirror Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id)
select job_id, company_id, 'job', 'd', 'https://x/m1', 'mirror-1' from fx;

insert into public.resume_documents (user_id, job_id, version, content, source)
select user_id, null, 1, 'base one', 'base' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'v1 should mirror';
end $$;

insert into public.resume_documents (user_id, job_id, version, content, source)
select user_id, null, 2, 'base two', 'edited' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base two', 'v2 should mirror';
end $$;

insert into public.resume_documents (user_id, job_id, version, content, source)
select user_id, job_id, 1, 'tailored one', 'tailored' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base two', 'tailored insert must not change the mirror';
end $$;

delete from public.resume_documents d using fx f where d.user_id = f.user_id and d.job_id is null and d.version = 2;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'deleting v2 should fall back to v1';
end $$;

delete from public.resume_documents d using fx f where d.user_id = f.user_id and d.job_id is null;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'deleting every base version leaves the last text';
  raise notice 'ALL MIRROR ASSERTIONS PASSED';
end $$;
rollback;
