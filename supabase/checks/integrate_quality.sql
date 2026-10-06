-- Proves migrations 20261009000400-403 (feedback ids, feedback events, job
-- dismissed feedback, ops health). It applies them TWICE inside the
-- transaction (so idempotency is exercised), runs the assertions as the real
-- client roles, and rolls back. The parts that read a role's trace from
-- public.person_roles (the employer and role work, K5a) run once that table exists.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/integrate_quality.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

\ir ../migrations/20261009000400_feedback_ids.sql
\ir ../migrations/20261009000400_feedback_ids.sql
\ir ../migrations/20261009000401_feedback_events.sql
\ir ../migrations/20261009000401_feedback_events.sql
\ir ../migrations/20261009000402_job_dismissed_feedback.sql
\ir ../migrations/20261009000403_ops_health.sql
\ir ../migrations/20261009000403_ops_health.sql

-- Fixed ids: client roles cannot read a postgres-owned temp table.
--   owner  bbbbbbbb-0000-0000-0000-000000000001
--   other  bbbbbbbb-0000-0000-0000-000000000002
insert into auth.users (id, email) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'q-owner@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'q-other@example.invalid');
insert into public.profiles (id, email) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'q-owner@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'q-other@example.invalid')
on conflict (id) do nothing;

insert into public.companies (id, user_id, name, career_url) values
  ('bbbbbbbb-1111-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Quality Check Co', 'https://example.invalid/careers');
insert into public.jobs (id, company_id, title, description, url, discovered_at) values
  ('bbbbbbbb-2222-0000-0000-000000000001', 'bbbbbbbb-1111-0000-0000-000000000001', 'Role with a trace', 'd', 'https://example.invalid/j1', now()),
  ('bbbbbbbb-2222-0000-0000-000000000002', 'bbbbbbbb-1111-0000-0000-000000000001', 'Role without a trace', 'd', 'https://example.invalid/j2', now());

-- The assessment's trace lives on the person's own row. lane-stub: K5a person_roles
do $$
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, role trace rows not created';
    return;
  end if;
  insert into public.person_roles (user_id, job_id, trace_id, observation_id)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-2222-0000-0000-000000000001', repeat('a', 32), repeat('b', 16)) on conflict (user_id, job_id) do update set trace_id=excluded.trace_id, observation_id=excluded.observation_id;
end $$;

-- ===========================================================================
-- Part 1: nothing for anon, nothing new for authenticated beyond own events
-- ===========================================================================
do $$
declare
  t text;
begin
  foreach t in array array['feedback_events', 'ops_health_checks'] loop
    assert not has_table_privilege('anon', 'public.' || t, 'select'), t || ': anon must not read';
    assert not has_table_privilege('anon', 'public.' || t, 'insert'), t || ': anon must not write';
  end loop;
  assert not has_table_privilege('authenticated', 'public.ops_health_checks', 'select'), 'ops_health_checks: authenticated must not read';
  assert to_regclass('public.cron_heartbeats') is null and to_regclass('public.ops_alerts') is null, 'the second heartbeat table and the alerts table are not kept';
  assert not has_table_privilege('authenticated', 'public.feedback_events', 'insert'), 'authenticated must not insert events';
  assert not has_table_privilege('authenticated', 'public.feedback_events', 'update'), 'authenticated must not update events';
  assert not has_table_privilege('authenticated', 'public.feedback_events', 'delete'), 'authenticated must not delete events';
  assert has_table_privilege('authenticated', 'public.feedback_events', 'select'), 'authenticated reads its own events';
  assert not has_function_privilege('anon', 'public.ops_db_stats()', 'execute'), 'ops_db_stats: anon';
  assert not has_function_privilege('authenticated', 'public.ops_db_stats()', 'execute'), 'ops_db_stats: authenticated';
  assert not has_function_privilege('anon', 'public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text)', 'execute'), 'enqueue_feedback: anon';
  assert not has_function_privilege('authenticated', 'public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text)', 'execute'), 'enqueue_feedback: authenticated';
  assert has_function_privilege('service_role', 'public.ops_db_stats()', 'execute'), 'ops_db_stats: service_role';
end $$;

-- The stats function reports a size and the biggest tables.
do $$
declare s jsonb;
begin
  s := public.ops_db_stats();
  assert (s ->> 'db_bytes')::bigint > 0, 'db_bytes is reported';
  assert jsonb_typeof(s -> 'tables') = 'array', 'tables is an array';
end $$;

-- ===========================================================================
-- Part 2: triggers write exactly the events they should
-- ===========================================================================

-- An outreach draft with a trace and what the model first wrote.
insert into public.outreach_messages
  (id, user_id, to_email, subject, body, status, trace_id, observation_id, generated_subject, generated_body)
values
  ('bbbbbbbb-3333-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'a@example.invalid',
   'Hello', 'Original body', 'pending_review', repeat('c', 32), repeat('d', 16), 'Hello', 'Original body'),
  ('bbbbbbbb-3333-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'b@example.invalid',
   'Hello', 'Original body', 'pending_review', repeat('c', 32), repeat('d', 16), 'Hello', 'Original body'),
  ('bbbbbbbb-3333-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'c@example.invalid',
   'Hello', 'Original body', 'pending_review', repeat('c', 32), repeat('d', 16), 'Hello', 'Original body'),
  ('bbbbbbbb-3333-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', 'd@example.invalid',
   'Hello', 'No trace here', 'pending_review', null, null, null, null);

-- Approving an unedited draft writes exactly one event; a second update (sent) writes none.
update public.outreach_messages set status = 'approved' where id = 'bbbbbbbb-3333-0000-0000-000000000001';
do $$
begin
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000001') = 1,
    'approving an unedited draft writes exactly one event';
  assert (select signal from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000001') = 'draft_approved';
end $$;
update public.outreach_messages set status = 'sent', sent_at = now() where id = 'bbbbbbbb-3333-0000-0000-000000000001';
do $$
begin
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000001') = 1,
    'a second update writes no further event';
end $$;

-- An edited draft writes draft_approved and draft_edited, the trace carried over.
update public.outreach_messages set body = 'Edited body', status = 'approved' where id = 'bbbbbbbb-3333-0000-0000-000000000002';
do $$
begin
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000002') = 2,
    'an edited draft writes an approval and an edit';
  assert exists (select 1 from public.feedback_events
                 where subject_id = 'bbbbbbbb-3333-0000-0000-000000000002' and signal = 'draft_edited'
                   and trace_id = repeat('c', 32) and observation_id = repeat('d', 16) and status = 'pending');
end $$;

-- A skip by the person is an event; a skip the system made (error set) is not.
update public.outreach_messages set status = 'skipped' where id = 'bbbbbbbb-3333-0000-0000-000000000003';
update public.outreach_messages set status = 'skipped', error = 'contact already replied' where id = 'bbbbbbbb-3333-0000-0000-000000000004';
do $$
begin
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000003' and signal = 'draft_skipped') = 1;
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000004') = 0,
    'a row with no trace, or a system skip, writes nothing';
end $$;

-- A reply days later attaches to the same row.
update public.outreach_messages set replied_at = now(), reply_classification = 'positive' where id = 'bbbbbbbb-3333-0000-0000-000000000001';
do $$
begin
  assert (select comment from public.feedback_events where subject_id = 'bbbbbbbb-3333-0000-0000-000000000001' and signal = 'outreach_replied') = 'positive';
end $$;

-- Application drafts: approve with an edit, reject.
insert into public.application_drafts
  (id, user_id, job_id, status, cover_letter, resume_summary, trace_id, observation_id, generated_cover_letter, generated_resume_summary)
values
  ('bbbbbbbb-4444-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-2222-0000-0000-000000000001',
   'pending_review', 'Dear team', 'Summary', repeat('e', 32), repeat('f', 16), 'Dear team', 'Summary'),
  ('bbbbbbbb-4444-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-2222-0000-0000-000000000002',
   'pending_review', 'Dear team', 'Summary', repeat('e', 32), repeat('f', 16), 'Dear team', 'Summary');
update public.application_drafts set status = 'approved', cover_letter = 'Dear hiring team' where id = 'bbbbbbbb-4444-0000-0000-000000000001';
update public.application_drafts set status = 'rejected' where id = 'bbbbbbbb-4444-0000-0000-000000000002';
do $$
begin
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-4444-0000-0000-000000000001') = 2, 'draft approved and edited';
  assert (select count(*) from public.feedback_events where subject_id = 'bbbbbbbb-4444-0000-0000-000000000002' and signal = 'draft_skipped') = 1;
end $$;

-- ===========================================================================
-- Part 3: a stage change made from the browser (as the signed-in person)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}', true);

insert into public.applications (id, user_id, job_id, stage)
values ('bbbbbbbb-5555-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-2222-0000-0000-000000000001', 'discovered');
update public.applications set stage = 'applied' where id = 'bbbbbbbb-5555-0000-0000-000000000001';
update public.applications set stage = 'interview' where id = 'bbbbbbbb-5555-0000-0000-000000000001';

-- The person can read their own events, never another person's, and cannot write.
do $$
declare n int;
begin
  select count(*) into n from public.feedback_events;
  assert n >= 8, 'the owner reads their own events, got ' || n;
  -- lane-stub: K5a person_roles
  assert (select count(*) from public.feedback_events where signal = 'job_applied') = case when to_regclass('public.person_roles') is null then 0 else 1 end,
    'applying queues one job_applied event carrying the person''s own trace';
  assert (select count(*) from public.feedback_events where signal = 'interview_scheduled') = 1,
    'the interview is credited to the draft for that job';
  begin
    insert into public.feedback_events (user_id, signal, subject_table, subject_id, trace_id, traced_at)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'job_applied', 'jobs', gen_random_uuid(), repeat('a', 32), now());
    raise exception 'authenticated insert should have been refused';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform 1 from public.ops_health_checks;
    raise exception 'authenticated read of ops_health_checks should have been refused';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.feedback_events) = 0, 'another person sees none of those events';
end $$;

reset role;

-- The interview was credited to the application draft for that job.
do $$
begin
  assert exists (select 1 from public.feedback_events
                 where signal = 'interview_scheduled' and subject_table = 'application_drafts'
                   and subject_id = 'bbbbbbbb-4444-0000-0000-000000000001');
  -- lane-stub: K5a person_roles
  assert to_regclass('public.person_roles') is null or exists (select 1 from public.feedback_events
                 where signal = 'job_applied' and subject_table = 'jobs'
                   and subject_id = 'bbbbbbbb-2222-0000-0000-000000000001' and trace_id = repeat('a', 32));
end $$;

-- Passing on a role is feedback when role reactions exist.
do $$
begin
  if to_regclass('public.role_reactions') is null or to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles or role_reactions absent, job_dismissed trigger not exercised';
  else
    insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title, company_name)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-2222-0000-0000-000000000001', 'not_for_me', 'pay', 'today', 'Role with a trace', 'Quality Check Co')
    on conflict (user_id, job_id) do update set reaction = 'not_for_me', reason = 'pay';
    assert (select comment from public.feedback_events where signal = 'job_dismissed' and subject_id = 'bbbbbbbb-2222-0000-0000-000000000001') = 'pay';
  end if;
end $$;

rollback;

\echo quality checks passed
