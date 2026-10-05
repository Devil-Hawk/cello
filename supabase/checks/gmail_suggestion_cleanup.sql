-- Proves public.delete_unreferenced_gmail_suggestions() (migration
-- 20261005200001) deletes only Gmail-suggested companies nothing points at. A
-- suggestion with a job that has an application, or with only a contact, must
-- survive, and so must a sourcer lead and a tracked company. Everything runs in
-- one transaction and rolls back, so any database is safe to point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/gmail_suggestion_cleanup.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id,
       gen_random_uuid() as free_gmail, gen_random_uuid() as job_gmail, gen_random_uuid() as contact_gmail,
       gen_random_uuid() as lead, gen_random_uuid() as tracked, gen_random_uuid() as job_id;
insert into auth.users (id, email) select user_id, 'gmail-clean-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'gmail-clean-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url, metadata)
select free_gmail,    user_id, 'Free Gmail',    'https://a.invalid', '{"source":"gmail","suggested":true}'::jsonb from fx union all
select job_gmail,     user_id, 'Job Gmail',     'https://b.invalid', '{"source":"gmail","suggested":true}'::jsonb from fx union all
select contact_gmail, user_id, 'Contact Gmail', 'https://c.invalid', '{"source":"gmail","suggested":true}'::jsonb from fx union all
select lead,          user_id, 'Sourcer Lead',  'https://d.invalid', '{"source":"sourcer","suggested":true}'::jsonb from fx union all
select tracked,       user_id, 'Tracked',       'https://e.invalid', null from fx;
insert into public.jobs (id, company_id, title, description, url, external_id)
select job_id, job_gmail, 'a job', 'd', 'https://b.invalid/1', 'gc-1' from fx;
insert into public.applications (user_id, job_id) select user_id, job_id from fx;
insert into public.contacts (user_id, company_id, name) select user_id, contact_gmail, 'A Contact' from fx;

select public.delete_unreferenced_gmail_suggestions() as deleted \gset
\echo deleted: :deleted

do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.companies where id = f.free_gmail),   'an unreferenced gmail suggestion should be gone';
  assert     exists (select 1 from public.companies where id = f.job_gmail),     'a suggestion with a job must stay';
  assert     exists (select 1 from public.applications where job_id = f.job_id), 'its application must survive';
  assert     exists (select 1 from public.companies where id = f.contact_gmail), 'a suggestion with a contact must stay';
  assert     exists (select 1 from public.companies where id = f.lead),          'a sourcer lead must stay';
  assert     exists (select 1 from public.companies where id = f.tracked),       'a tracked company must stay';
  raise notice 'ALL GMAIL CLEANUP ASSERTIONS PASSED';
end $$;
rollback;
