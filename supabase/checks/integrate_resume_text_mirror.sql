-- Proves the resume_text mirror trigger (migration 20261017000000, which moved the mirror from
-- resume_documents to the base resume artifact): the latest BASE version's text is mirrored
-- into profiles.resume_text on insert and on delete, tailored versions never touch it, and
-- deleting every base version leaves the last text in place. One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/integrate_resume_text_mirror.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as company_id, gen_random_uuid() as job_id,
       gen_random_uuid() as base_id, gen_random_uuid() as tailored_id;
insert into auth.users (id, email) select user_id, 'mirror-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'mirror-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select company_id, user_id, 'Mirror Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id)
select job_id, company_id, 'job', 'd', 'https://x/m1', 'mirror-1' from fx;
insert into public.artifacts (id, user_id, type, title, is_base) select base_id, user_id, 'resume', 'Base resume', true from fx;
insert into public.artifacts (id, user_id, type, title, job_id) select tailored_id, user_id, 'resume', 'Tailored', job_id from fx;

insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select base_id, 1, 'user', '{"text":"base one"}', 'base one' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'v1 should mirror';
end $$;

insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select base_id, 2, 'user', '{"text":"base two"}', 'base two' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base two', 'v2 should mirror';
end $$;

insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select tailored_id, 1, 'cello', '{"text":"tailored one"}', 'tailored one' from fx;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base two', 'tailored insert must not change the mirror';
end $$;

delete from public.artifact_versions v using fx f where v.artifact_id = f.base_id and v.version = 2;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'deleting v2 should fall back to v1';
end $$;

delete from public.artifact_versions v using fx f where v.artifact_id = f.base_id;
do $$ declare f record; begin
  select * into f from fx;
  assert (select resume_text from public.profiles where id = f.user_id) = 'base one', 'deleting every base version leaves the last text';
  raise notice 'ALL MIRROR ASSERTIONS PASSED';
end $$;
rollback;
