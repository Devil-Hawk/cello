-- Proves the status-turn trigger is attached to the pipeline's real table (migration 20261024300002 after
-- 20261013000001): one event that moves an application writes one status turn in the chat that holds it, and an
-- event that moves nothing writes none. It does nothing on a database without pipeline_events.
-- One transaction, rolled back.
--
--   bash supabase/checks/run.sh supabase/checks/chat_status_turns_pipeline.sql

\set ON_ERROR_STOP 1
begin;

do $$
declare
  u uuid := 'dddddddd-0000-0000-0000-000000000041';
  c uuid := 'dddddddd-1111-0000-0000-000000000041';
  app uuid := 'dddddddd-9999-0000-0000-000000000041';
  fk text;
begin
  if to_regclass('public.pipeline_events') is null then
    raise notice 'chat_status_turns_pipeline: no pipeline_events here, skipped';
    return;
  end if;

  insert into auth.users (id, email) values (u, 'chat-st-real@example.invalid');
  insert into public.profiles (id, email) values (u, 'chat-st-real@example.invalid') on conflict (id) do nothing;
  insert into public.graph_threads (thread_id, user_id, surface) values (c, u, 'agent');
  insert into public.chats (id, user_id, title) values (c, u, 'Holds it');
  insert into public.chat_attachments (user_id, chat_id, kind, ref, origin) values (u, c, 'application', jsonb_build_object('id', app), 'person');

  -- The application row is the pipeline's to make; this check is about the trigger, so the key to it is let go (rolled back).
  for fk in select conname from pg_constraint where conrelid = 'public.pipeline_events'::regclass and contype = 'f' and conname like '%application_id%' loop
    execute format('alter table public.pipeline_events drop constraint %I', fk);
  end loop;

  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, from_state, to_state, idempotency_key)
  values (u, app, 'step.started', 'cello', 'Cello started the resume.', 'preparing', 'applying', 'chat-check-1');
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = c) = 1, 'one status turn for one move';

  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, from_state, to_state, idempotency_key)
  values (u, app, 'step.started', 'cello', 'Nothing moved.', 'applying', 'applying', 'chat-check-2');
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = c) = 1, 'none when the state did not change';

  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, from_state, to_state, idempotency_key)
  values (u, app, 'step.finished', 'cello', 'The posting is open.', 'applying', 'applying', 'chat-check-3');
  assert (select count(*) from public.chat_turns where kind = 'status' and chat_id = c) = 2, 'a finished step is a line even when the state did not change';
end $$;

rollback;

\echo chat status turn (real table) checks passed
