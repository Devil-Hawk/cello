-- Proves the chat workspace columns (migration 20261024300000):
--   * a worker row can name a command and a chat, hold up to 50 reads, and be stopped; a 51st read is refused;
--   * the retired agent column is optional now, and an unknown status is still refused;
--   * the ledger links a call to its turn and worker, and a deleted turn leaves the ledger row;
--   * deleting a chat deletes its workers.
-- Everything runs in one transaction and rolls back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/chat_workspace.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000021', 'chat-ws@example.invalid');
insert into public.profiles (id, email) values ('dddddddd-0000-0000-0000-000000000021', 'chat-ws@example.invalid')
on conflict (id) do nothing;
insert into public.graph_threads (thread_id, user_id, surface)
values ('dddddddd-4444-0000-0000-000000000021', 'dddddddd-0000-0000-0000-000000000021', 'agent');
insert into public.chats (id, user_id, title) values
  ('dddddddd-1111-0000-0000-000000000021', 'dddddddd-0000-0000-0000-000000000021', 'Research four companies');
insert into public.chat_turns (id, user_id, chat_id, kind, typed, origin) values
  ('dddddddd-2222-0000-0000-000000000021', 'dddddddd-0000-0000-0000-000000000021', 'dddddddd-1111-0000-0000-000000000021', 'person', 'research Ramp', 'person');

do $$
declare
  worker uuid := 'dddddddd-5555-0000-0000-000000000021';
begin
  -- A worker with no agent, named by its command and its chat.
  insert into public.agent_tasks (id, user_id, thread_id, chat_id, turn_id, command, title, object, model, rung)
  values (worker, 'dddddddd-0000-0000-0000-000000000021', 'dddddddd-4444-0000-0000-000000000021',
          'dddddddd-1111-0000-0000-000000000021', 'dddddddd-2222-0000-0000-000000000021',
          'companies.research', 'Research Ramp', '{"kind":"company","ref":"x"}', 'x/free:free', 'R3');
  assert (select reads from public.agent_tasks where id = worker) = '[]'::jsonb, 'reads start empty';

  update public.agent_tasks set stop_requested_at = now() where id = worker;
  update public.agent_tasks set status = 'stopped' where id = worker;
  assert (select status from public.agent_tasks where id = worker) = 'stopped', 'a worker can be stopped';

  begin
    update public.agent_tasks set status = 'cancelled' where id = worker;
    raise exception 'an unknown status should have been refused';
  exception when check_violation then
    null;
  end;

  update public.agent_tasks
     set reads = (select jsonb_agg(jsonb_build_object('label', 'read ' || g, 'url', 'https://ramp.test/' || g, 'at', now())) from generate_series(1, 50) g)
   where id = worker;
  assert jsonb_array_length((select reads from public.agent_tasks where id = worker)) = 50, 'fifty reads fit';
  begin
    update public.agent_tasks
       set reads = (select jsonb_agg(jsonb_build_object('label', 'read ' || g)) from generate_series(1, 51) g)
     where id = worker;
    raise exception 'a 51st read should have been refused';
  exception when check_violation then
    null;
  end;

  -- The ledger names the turn and the worker; a deleted turn leaves the row.
  insert into public.llm_spend (id, user_id, period, model, estimate_usd, actual_usd, status, rung, step, chat_turn_id, task_id)
  values ('dddddddd-6666-0000-0000-000000000021', 'dddddddd-0000-0000-0000-000000000021', date_trunc('month', now())::date,
          'x/free:free', 0, 0, 'settled', 'R3', 'chat', 'dddddddd-2222-0000-0000-000000000021', worker);
  assert (select count(*) from public.llm_spend where chat_turn_id = 'dddddddd-2222-0000-0000-000000000021' and task_id = worker) = 1, 'the ledger links its turn and worker';

  delete from public.chats where id = 'dddddddd-1111-0000-0000-000000000021';
  assert (select count(*) from public.agent_tasks where id = worker) = 0, 'deleting a chat deletes its workers';
  assert (select chat_turn_id from public.llm_spend where id = 'dddddddd-6666-0000-0000-000000000021') is null, 'the ledger row stays, unlinked';
end $$;

rollback;

\echo chat workspace checks passed
