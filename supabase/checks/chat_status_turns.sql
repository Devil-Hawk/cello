-- Proves the status-turn trigger (migration 20261024300002):
--   * one state change of an application writes one status turn in each chat that holds it as a tile;
--   * a chat that does not hold it, a chat whose tile was removed, and another person's chat get none;
--   * an event that moves nothing (same state) writes none.
-- Runs on a probe table with the columns the trigger reads (the pipeline's table has the same ones).
-- One transaction, rolled back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/chat_status_turns.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000031', 'chat-st-a@example.invalid'),
  ('dddddddd-0000-0000-0000-000000000032', 'chat-st-b@example.invalid');
insert into public.profiles (id, email) values
  ('dddddddd-0000-0000-0000-000000000031', 'chat-st-a@example.invalid'),
  ('dddddddd-0000-0000-0000-000000000032', 'chat-st-b@example.invalid')
on conflict (id) do nothing;
insert into public.graph_threads (thread_id, user_id, surface) values
  ('dddddddd-1111-0000-0000-000000000031', 'dddddddd-0000-0000-0000-000000000031', 'agent'),
  ('dddddddd-1111-0000-0000-000000000032', 'dddddddd-0000-0000-0000-000000000031', 'agent'),
  ('dddddddd-1111-0000-0000-000000000033', 'dddddddd-0000-0000-0000-000000000031', 'agent'),
  ('dddddddd-1111-0000-0000-000000000034', 'dddddddd-0000-0000-0000-000000000032', 'agent');
insert into public.chats (id, user_id, title) values
  ('dddddddd-1111-0000-0000-000000000031', 'dddddddd-0000-0000-0000-000000000031', 'Holds it'),
  ('dddddddd-1111-0000-0000-000000000032', 'dddddddd-0000-0000-0000-000000000031', 'Holds it too'),
  ('dddddddd-1111-0000-0000-000000000033', 'dddddddd-0000-0000-0000-000000000031', 'Does not'),
  ('dddddddd-1111-0000-0000-000000000034', 'dddddddd-0000-0000-0000-000000000032', 'Another person');

insert into public.chat_attachments (user_id, chat_id, kind, ref, origin) values
  ('dddddddd-0000-0000-0000-000000000031', 'dddddddd-1111-0000-0000-000000000031', 'application', '{"id":"dddddddd-9999-0000-0000-000000000031"}', 'person'),
  ('dddddddd-0000-0000-0000-000000000031', 'dddddddd-1111-0000-0000-000000000032', 'application', '{"id":"dddddddd-9999-0000-0000-000000000031"}', 'person'),
  ('dddddddd-0000-0000-0000-000000000031', 'dddddddd-1111-0000-0000-000000000033', 'application', '{"id":"dddddddd-9999-0000-0000-000000000099"}', 'person'),
  ('dddddddd-0000-0000-0000-000000000032', 'dddddddd-1111-0000-0000-000000000034', 'application', '{"id":"dddddddd-9999-0000-0000-000000000099"}', 'person');

-- A table of its own with the columns the trigger reads, so the check does not depend on the pipeline's keys.
create table public.chat_status_probe (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  application_id uuid,
  from_state text,
  to_state text
);
create trigger chat_status_turns
  after insert on public.chat_status_probe
  for each row
  when (new.application_id is not null and new.to_state is not null and new.to_state is distinct from new.from_state)
  execute function public.chat_status_turns();

do $$
declare
  ev uuid := gen_random_uuid();
begin
  insert into public.chat_status_probe (id, user_id, application_id, from_state, to_state)
  values (ev, 'dddddddd-0000-0000-0000-000000000031', 'dddddddd-9999-0000-0000-000000000031', 'ready', 'applying');

  assert (select count(*) from public.chat_turns where kind = 'status' and event_id = ev) = 2, 'one status turn in each chat that holds the application';
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = 'dddddddd-1111-0000-0000-000000000033') = 0, 'none in a chat holding another application';
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = 'dddddddd-1111-0000-0000-000000000034') = 0, 'none in another person''s chat';

  -- A removed tile no longer follows the application.
  update public.chat_attachments set removed_at = now() where chat_id = 'dddddddd-1111-0000-0000-000000000032' and kind = 'application';
  insert into public.chat_status_probe (user_id, application_id, from_state, to_state)
  values ('dddddddd-0000-0000-0000-000000000031', 'dddddddd-9999-0000-0000-000000000031', 'applying', 'sent');
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = 'dddddddd-1111-0000-0000-000000000031') = 2, 'the chat that still holds it gets the second change';
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = 'dddddddd-1111-0000-0000-000000000032') = 1, 'the chat that let it go gets no more';

  -- A line that moves nothing says nothing.
  insert into public.chat_status_probe (user_id, application_id, from_state, to_state)
  values ('dddddddd-0000-0000-0000-000000000031', 'dddddddd-9999-0000-0000-000000000031', 'sent', 'sent');
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = 'dddddddd-1111-0000-0000-000000000031') = 2, 'no turn when the state did not change';
end $$;

rollback;

\echo chat status turn checks passed
