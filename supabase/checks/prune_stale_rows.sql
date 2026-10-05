-- Proves public.prune_stale_rows() (migration 20261004194501) deletes only
-- what it should: old unreferenced jobs, old spans, stale checkpoints. Above
-- all, a job with an application must survive, because deleting it would
-- cascade to the application. Everything runs in one transaction and rolls
-- back, so any database is safe to point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/prune_stale_rows.sql

\set ON_ERROR_STOP 1
begin;
create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as company_id,
       gen_random_uuid() as old_free, gen_random_uuid() as old_applied, gen_random_uuid() as fresh_free,
       gen_random_uuid() as stale_thread, gen_random_uuid() as live_thread;
insert into auth.users (id, email) select user_id, 'prune-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'prune-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select company_id, user_id, 'Prune Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id, discovered_at)
select old_free,    company_id, 'old free',    'd', 'https://x/1', 'prune-1', now() - interval '60 days' from fx union all
select old_applied, company_id, 'old applied', 'd', 'https://x/2', 'prune-2', now() - interval '60 days' from fx union all
select fresh_free,  company_id, 'fresh free',  'd', 'https://x/3', 'prune-3', now() - interval '5 days'  from fx;
insert into public.applications (user_id, job_id) select user_id, old_applied from fx;
insert into public.graph_threads (thread_id, user_id, surface, created_at, last_invoked_at)
select stale_thread, user_id, 'copilot', now() - interval '40 days', now() - interval '40 days' from fx union all
select live_thread,  user_id, 'copilot', now(), now() from fx;
insert into langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
select stale_thread::text, '', 'c1', '{}'::jsonb, '{}'::jsonb from fx union all
select live_thread::text,  '', 'c1', '{}'::jsonb, '{}'::jsonb from fx;
insert into public.trace_spans (trace_id, span_id, user_id, name, kind, start_time, status)
select gen_random_uuid(), gen_random_uuid(), user_id, 'old', 'node', now() - interval '31 days', 'ok' from fx union all
select gen_random_uuid(), gen_random_uuid(), user_id, 'new', 'node', now() - interval '1 day',  'ok' from fx;

select public.prune_stale_rows() as result \gset
\echo prune result: :result

do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.jobs where id = f.old_free),    'old unreferenced job should be gone';
  assert     exists (select 1 from public.jobs where id = f.old_applied), 'old job with an application must stay';
  assert     exists (select 1 from public.applications where job_id = f.old_applied), 'application must survive';
  assert     exists (select 1 from public.jobs where id = f.fresh_free),  'fresh job must stay';
  assert not exists (select 1 from langgraph.checkpoints where thread_id = f.stale_thread::text), 'stale checkpoint should be gone';
  assert     exists (select 1 from langgraph.checkpoints where thread_id = f.live_thread::text),  'live checkpoint must stay';
  assert not exists (select 1 from public.trace_spans where name = 'old' and start_time < now() - interval '30 days'), 'old span should be gone';
  assert     exists (select 1 from public.trace_spans where name = 'new'), 'fresh span must stay';
  raise notice 'ALL PRUNE ASSERTIONS PASSED';
end $$;
rollback;
