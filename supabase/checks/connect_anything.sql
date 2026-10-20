-- Proves the connect-anything migration (20261128200000):
--   * a proposal of kind mcp is accepted, an unknown kind still is not;
--   * a new MCP server row has tool_rules = '{}';
--   * a person reads their own skills and no one else's, anon reads nothing, and no client role writes;
--   * a skill name outside a-z, 0-9 and dashes, a second skill of the same name for one person, and a
--     description of 1,025 characters are refused;
--   * running the migration a second time changes nothing.
-- Everything runs in one transaction and rolls back.
--
-- Run from this folder so \ir finds the migration:
--   cd supabase/checks && psql -X -v ON_ERROR_STOP=1 -f connect_anything.sql "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

--   a  eeeeeeee-0000-0000-0000-000000000001
--   b  eeeeeeee-0000-0000-0000-000000000002
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'connect-a@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'connect-b@example.invalid');
insert into public.profiles (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'connect-a@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'connect-b@example.invalid')
on conflict (id) do nothing;

-- A skill for A, written as the service role (the only writer).
set local role service_role;
insert into public.person_skills (user_id, name, description, body, source)
values ('eeeeeeee-0000-0000-0000-000000000001', 'tidy-notes', 'Use when notes need tidying.', 'Step one.', 'Pasted');
reset role;

-- Proposals and MCP servers.
insert into public.proposals (user_id, kind, payload)
values ('eeeeeeee-0000-0000-0000-000000000001', 'mcp', '{"server":"notes","tool":"search","args":{}}');
insert into public.user_mcp_servers (id, user_id, name, transport, url)
values ('eeeeeeee-1111-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'notes', 'http', 'https://example.invalid/mcp');

do $$
begin
  assert (select tool_rules from public.user_mcp_servers where id = 'eeeeeeee-1111-0000-0000-000000000001') = '{}'::jsonb,
    'a new server has no Never marks';
  begin
    insert into public.proposals (user_id, kind, payload) values ('eeeeeeee-0000-0000-0000-000000000001', 'nonsense', '{}');
    raise exception 'an unknown proposal kind should have been refused';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.person_skills (user_id, name, description, body, source)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'Bad Name', 'd', 'b', 'Pasted');
    raise exception 'a skill name with capitals and a space should have been refused';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.person_skills (user_id, name, description, body, source)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'tidy-notes', 'd', 'b', 'Pasted');
    raise exception 'a second skill of the same name should have been refused';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.person_skills (user_id, name, description, body, source)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'long-one', repeat('x', 1025), 'b', 'Pasted');
    raise exception 'a description of 1,025 characters should have been refused';
  exception when check_violation then
    null;
  end;
  assert (select relrowsecurity from pg_class where oid = 'public.person_skills'::regclass), 'row level security is on';
  assert not has_table_privilege('anon', 'public.person_skills', 'select'), 'anon must not read';
  assert not has_table_privilege('authenticated', 'public.person_skills', 'insert'), 'authenticated must not insert';
  assert not has_table_privilege('authenticated', 'public.person_skills', 'update'), 'authenticated must not update';
  assert not has_table_privilege('authenticated', 'public.person_skills', 'delete'), 'authenticated must not delete';
end $$;

-- B reads none of A's skills; A reads theirs.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.person_skills) = 0, 'b reads none of a''s skills';
end $$;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.person_skills) = 1, 'a reads their skill';
  assert (select name from public.person_skills) = 'tidy-notes';
end $$;
reset role;

-- anon: no privilege at all, so a read is refused outright.
set local role anon;
do $$
begin
  begin
    perform count(*) from public.person_skills;
    raise exception 'anon should not be able to read person_skills';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- The migration, run again inside the same transaction, changes nothing.
create temp table before_rerun as
  select (select count(*) from public.person_skills) as skills,
         (select count(*) from public.proposals where kind = 'mcp') as mcp_proposals,
         (select tool_rules::text from public.user_mcp_servers where id = 'eeeeeeee-1111-0000-0000-000000000001') as rules,
         (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.proposals'::regclass and conname = 'proposals_kind_check') as kind_check,
         (select count(*) from pg_policies where tablename = 'person_skills') as policies;
\ir ../migrations/20261128200000_connect_anything.sql
do $$
declare
  b record;
begin
  select * into b from before_rerun;
  assert (select count(*) from public.person_skills) = b.skills, 'a second run keeps the skills';
  assert (select count(*) from public.proposals where kind = 'mcp') = b.mcp_proposals, 'a second run keeps the proposals';
  assert (select tool_rules::text from public.user_mcp_servers where id = 'eeeeeeee-1111-0000-0000-000000000001') = b.rules, 'a second run keeps the rules';
  assert (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.proposals'::regclass and conname = 'proposals_kind_check') = b.kind_check, 'a second run keeps the kind check';
  assert (select count(*) from pg_policies where tablename = 'person_skills') = b.policies, 'a second run keeps one policy';
end $$;

rollback;

\echo connect anything checks passed
