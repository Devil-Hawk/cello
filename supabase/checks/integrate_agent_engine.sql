-- Proves the agent engine's tables (migrations 20261009000600 to 604 and 610):
--   * the retired values are refused: an interview prep artifact and a coach task;
--   * approvals keep an outcome, and there is no second taste table;
--   * row level security is on for each table, nothing reaches anon, and a person
--     reads their own rows and no one else's but cannot write any;
--   * artifact_add_version numbers versions one after another and a retried call
--     with the same key adds nothing.
-- Everything runs in one transaction and rolls back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/integrate_agent_engine.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

-- Fixed ids: client roles cannot read a postgres-owned temp table.
--   a  cccccccc-0000-0000-0000-000000000001
--   b  cccccccc-0000-0000-0000-000000000002
insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'engine-a@example.invalid'),
  ('cccccccc-0000-0000-0000-000000000002', 'engine-b@example.invalid');
insert into public.profiles (id, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'engine-a@example.invalid'),
  ('cccccccc-0000-0000-0000-000000000002', 'engine-b@example.invalid')
on conflict (id) do nothing;

-- ===========================================================================
-- The retired values are refused
-- ===========================================================================
do $$
begin
  begin
    insert into public.artifacts (user_id, type, title)
    values ('cccccccc-0000-0000-0000-000000000001', 'interview_prep', 'x');
    raise exception 'an interview prep artifact should have been refused';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.agent_tasks (user_id, thread_id, agent, title)
    values ('cccccccc-0000-0000-0000-000000000001', gen_random_uuid(), 'coach', 'x');
    raise exception 'a coach task should have been refused';
  exception when check_violation then
    null;
  end;
end $$;

-- ===========================================================================
-- Approvals keep an outcome; there is no second taste table
-- ===========================================================================
do $$
begin
  assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approvals' and column_name = 'outcome'),
    'approvals.outcome is present';
  assert to_regclass('public.taste_statements') is null, 'there is no taste_statements table';
end $$;

-- ===========================================================================
-- Row level security: a person reads their own rows, never writes, never sees another's
-- ===========================================================================
insert into public.artifacts (id, user_id, type, title) values
  ('cccccccc-1111-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'cover_letter', 'A letter'),
  ('cccccccc-1111-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'cover_letter', 'B letter');
insert into public.artifact_versions (artifact_id, version, author, content, content_text) values
  ('cccccccc-1111-0000-0000-000000000001', 1, 'cello', '{"text":"a"}', 'a'),
  ('cccccccc-1111-0000-0000-000000000002', 1, 'cello', '{"text":"b"}', 'b');
insert into public.scheduled_tasks (id, user_id, name, instruction, cron, timezone) values
  ('cccccccc-2222-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'A task', 'Find roles.', '0 8 * * *', 'UTC'),
  ('cccccccc-2222-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'B task', 'Find roles.', '0 8 * * *', 'UTC');

do $$
declare
  t text;
begin
  foreach t in array array['artifacts', 'artifact_versions', 'scheduled_tasks', 'agent_tasks', 'approvals'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ': row level security is on';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), t || ': anon must not read';
    assert not has_table_privilege('authenticated', 'public.' || t, 'insert'), t || ': authenticated must not insert';
    assert not has_table_privilege('authenticated', 'public.' || t, 'update'), t || ': authenticated must not update';
    assert not has_table_privilege('authenticated', 'public.' || t, 'delete'), t || ': authenticated must not delete';
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.artifacts) = 1, 'a reads only their artifact';
  assert (select count(*) from public.artifact_versions) = 1, 'a reads only their versions';
  assert (select count(*) from public.scheduled_tasks) = 1, 'a reads only their task';
  assert (select title from public.artifacts) = 'A letter';
  begin
    update public.artifacts set title = 'changed' where id = 'cccccccc-1111-0000-0000-000000000001';
    raise exception 'an update by the person should have been refused';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  assert (select title from public.artifacts) = 'B letter', 'b reads only their artifact';
end $$;
reset role;

-- ===========================================================================
-- artifact_add_version
-- ===========================================================================
do $$
declare
  v1 integer;
  v2 integer;
  again integer;
begin
  v1 := public.artifact_add_version('cccccccc-0000-0000-0000-000000000001', 'cccccccc-1111-0000-0000-000000000001', 'user', '{"text":"edit"}', 'edit');
  v2 := public.artifact_add_version('cccccccc-0000-0000-0000-000000000001', 'cccccccc-1111-0000-0000-000000000001', 'cello', '{"text":"again"}', 'again', null, null, null, 'retry-key');
  again := public.artifact_add_version('cccccccc-0000-0000-0000-000000000001', 'cccccccc-1111-0000-0000-000000000001', 'cello', '{"text":"again"}', 'again', null, null, null, 'retry-key');
  assert v1 = 2, 'the second version is number 2';
  assert v2 = 3 and again = 3, 'a retried call with the same key returns the version it made';
  assert (select count(*) from public.artifact_versions where artifact_id = 'cccccccc-1111-0000-0000-000000000001') = 3, 'a retry adds nothing';
  begin
    perform public.artifact_add_version('cccccccc-0000-0000-0000-000000000002', 'cccccccc-1111-0000-0000-000000000001', 'user', '{}', 'x');
    raise exception 'another person must not add a version';
  exception when others then
    if sqlerrm like 'another person must not%' then raise; end if;
  end;
end $$;

rollback;

\echo agent engine checks passed
