-- Proves the chat memory columns (migration 20261024200000):
--   * words search finds a typed line by its words (stemmed) and a chat by its title, and never matches Cello's answer;
--   * chat_recall_words finds typed lines, chats and made things for one person only;
--   * deleting a chat deletes its turns and keeps what it made, with the turn link cleared.
-- Everything runs in one transaction and rolls back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/chat_memory.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000011', 'chat-mem@example.invalid');
insert into public.profiles (id, email) values ('dddddddd-0000-0000-0000-000000000011', 'chat-mem@example.invalid')
on conflict (id) do nothing;

insert into public.chats (id, user_id, title) values
  ('dddddddd-1111-0000-0000-000000000011', 'dddddddd-0000-0000-0000-000000000011', 'AI roles at fintechs');
insert into public.chat_turns (id, user_id, chat_id, kind, typed, answer, origin) values
  ('dddddddd-2222-0000-0000-000000000011', 'dddddddd-0000-0000-0000-000000000011', 'dddddddd-1111-0000-0000-000000000011', 'person', 'compare the Ramp and Linear roles', null, 'person'),
  ('dddddddd-2222-0000-0000-000000000012', 'dddddddd-0000-0000-0000-000000000011', 'dddddddd-1111-0000-0000-000000000011', 'cello', null, 'zebra only in the answer', 'model');
insert into public.artifacts (id, user_id, type, title, chat_turn_id) values
  ('dddddddd-3333-0000-0000-000000000011', 'dddddddd-0000-0000-0000-000000000011', 'dossier', 'Comparison of 6 AI roles', 'dddddddd-2222-0000-0000-000000000011');

do $$
begin
  assert (select count(*) from public.chat_turns where tsv @@ plainto_tsquery('english', 'compared')) = 1, 'a typed word finds its turn';
  assert (select count(*) from public.chat_turns where tsv @@ plainto_tsquery('english', 'zebra')) = 0, 'an answer is not searched';
  assert (select count(*) from public.chats where tsv @@ plainto_tsquery('english', 'fintechs')) = 1, 'a title word finds its chat';

  -- The words path: any word matches, stemmed, for this person only, and an answer is never searched.
  assert (select count(*) from public.chat_recall_words('dddddddd-0000-0000-0000-000000000011', 'six or compared or yesterday', 10) where kind = 'turn') = 1,
    'words recall finds the typed line by a stemmed word';
  assert (select count(*) from public.chat_recall_words('dddddddd-0000-0000-0000-000000000011', 'comparison', 10) where kind = 'made' and artifact_id = 'dddddddd-3333-0000-0000-000000000011') = 1,
    'words recall finds the made thing by its title';
  assert (select count(*) from public.chat_recall_words('dddddddd-0000-0000-0000-000000000011', 'zebra', 10)) = 0, 'words recall never reads an answer';
  assert (select count(*) from public.chat_recall_words('dddddddd-0000-0000-0000-000000000099', 'compared or comparison or fintechs', 10)) = 0, 'another person finds nothing';

  delete from public.chats where id = 'dddddddd-1111-0000-0000-000000000011';
  assert (select count(*) from public.chat_turns where chat_id = 'dddddddd-1111-0000-0000-000000000011') = 0, 'deleting a chat deletes its turns';
  assert (select count(*) from public.artifacts where id = 'dddddddd-3333-0000-0000-000000000011') = 1, 'what the chat made stays';
  assert (select chat_turn_id from public.artifacts where id = 'dddddddd-3333-0000-0000-000000000011') is null, 'and its turn link is cleared';
end $$;

rollback;

\echo chat memory checks passed
