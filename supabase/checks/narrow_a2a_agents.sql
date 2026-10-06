-- Proves migration 20261008010000: the A2A agent check allows exactly the
-- matcher and the company researcher, and no interview table is left. Runs in
-- one transaction and rolls back, so any database is safe to point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/narrow_a2a_agents.sql

\set ON_ERROR_STOP 1
begin;

do $$
declare def text; n int;
begin
  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conrelid = 'public.a2a_tasks'::regclass and conname = 'a2a_tasks_agent_check';
  if def is distinct from $d$CHECK ((agent = ANY (ARRAY['matcher'::text, 'company_researcher'::text])))$d$ then
    raise exception 'agent check is %', def;
  end if;

  select count(*) into n
  from pg_constraint
  where conrelid = 'public.a2a_tasks'::regclass and contype = 'c'
    and conname <> 'a2a_tasks_agent_check'
    and pg_get_constraintdef(oid) like '%agent%';
  if n <> 0 then raise exception 'another check on a2a_tasks mentions agent'; end if;

  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name like 'interview%') then
    raise exception 'an interview table is still there';
  end if;
end $$;

create temp table fx as select gen_random_uuid() as user_id, gen_random_uuid() as thread_id;
insert into auth.users (id, email) select user_id, 'a2a-check@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'a2a-check@example.invalid' from fx on conflict (id) do nothing;
insert into public.graph_threads (thread_id, user_id, surface) select thread_id, user_id, 'agent' from fx;

insert into public.a2a_tasks (user_id, thread_id, agent) select user_id, thread_id, 'matcher' from fx;

do $$
declare f record;
begin
  select * into f from fx;
  begin
    insert into public.a2a_tasks (user_id, thread_id, agent) values (f.user_id, f.thread_id, 'nope');
    raise exception 'a task for an unknown agent was accepted';
  exception when check_violation then
    null;
  end;
end $$;

\echo narrow_a2a_agents: ok
rollback;
