-- Proves the chat tables (migration 20261024000000):
--   * the 26th active attached thing is refused, positions run 1..n in attach order,
--     detaching keeps the row and a re-attach makes a new row, and one active tile
--     is allowed per (chat, kind, ref);
--   * a tile cannot be put on another person's chat;
--   * a person turn needs typed words and a status turn needs its event;
--   * row level security: a person reads their own rows and no one else's, writes
--     nothing, and anon reads nothing.
-- Everything runs in one transaction and rolls back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/chat_tables.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

\set ON_ERROR_STOP 1
begin;

-- Fixed ids: client roles cannot read a postgres-owned temp table.
--   a  dddddddd-0000-0000-0000-000000000001
--   b  dddddddd-0000-0000-0000-000000000002
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'chat-a@example.invalid'),
  ('dddddddd-0000-0000-0000-000000000002', 'chat-b@example.invalid');
insert into public.profiles (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'chat-a@example.invalid'),
  ('dddddddd-0000-0000-0000-000000000002', 'chat-b@example.invalid')
on conflict (id) do nothing;

insert into public.chats (id, user_id, title) values
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'A chat'),
  ('dddddddd-1111-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 'B chat');

-- ===========================================================================
-- The 25 tile limit, positions, detach and re-attach
-- ===========================================================================
do $$
declare
  i int;
  first_ref jsonb := jsonb_build_object('table', 'artifacts', 'id', '00000000-0000-0000-0000-000000000001');
begin
  for i in 1..24 loop
    insert into public.chat_attachments (user_id, chat_id, kind, ref, origin, prov)
    values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'made',
            jsonb_build_object('table', 'artifacts', 'id', format('00000000-0000-0000-0000-%s', lpad(i::text, 12, '0'))),
            'person', '{"door":"chat.attach"}');
  end loop;

  begin
    insert into public.chat_attachments (user_id, chat_id, kind, ref, origin)
    values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'made', first_ref, 'person');
    raise exception 'a second active tile for the same thing should have been refused';
  exception when unique_violation then
    null;
  end;

  insert into public.chat_attachments (user_id, chat_id, kind, ref, origin)
  values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'made',
          '{"table":"artifacts","id":"00000000-0000-0000-0000-000000000025"}', 'person');
  assert (select count(*) from public.chat_attachments where chat_id = 'dddddddd-1111-0000-0000-000000000001') = 25, 'twenty-five tiles';
  assert (select bool_and(position = right(ref ->> 'id', 12)::int) from public.chat_attachments
          where chat_id = 'dddddddd-1111-0000-0000-000000000001'), 'positions are 1..25 in attach order';

  begin
    insert into public.chat_attachments (user_id, chat_id, kind, ref, origin)
    values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'made',
            '{"table":"artifacts","id":"00000000-0000-0000-0000-000000000099"}', 'person');
    raise exception 'the 26th tile should have been refused';
  exception when check_violation then
    null;
  end;

  -- Detaching keeps the row; the freed place can be used and the same thing can come back as a new row.
  update public.chat_attachments set removed_at = now()
   where chat_id = 'dddddddd-1111-0000-0000-000000000001' and ref = first_ref;
  assert (select count(*) from public.chat_attachments where chat_id = 'dddddddd-1111-0000-0000-000000000001') = 25, 'detaching keeps the row';

  insert into public.chat_attachments (user_id, chat_id, kind, ref, origin, prov)
  values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'made', first_ref, 'model', '{"turn_id":"t"}');
  assert (select count(*) from public.chat_attachments where chat_id = 'dddddddd-1111-0000-0000-000000000001' and ref = first_ref) = 2,
    'a re-attach makes a new row';
  assert (select max(position) from public.chat_attachments where chat_id = 'dddddddd-1111-0000-0000-000000000001') = 26,
    'the new tile goes last';
  assert (select count(*) from public.chat_attachments
          where chat_id = 'dddddddd-1111-0000-0000-000000000001' and removed_at is null) = 25, 'twenty-five active again';

  -- Another person's chat takes no tile from this person.
  begin
    insert into public.chat_attachments (user_id, chat_id, kind, ref, origin)
    values ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-1111-0000-0000-000000000001', 'role', '{"id":"x"}', 'person');
    raise exception 'a tile on another person''s chat should have been refused';
  exception when check_violation then
    null;
  end;
end $$;

-- ===========================================================================
-- The two turn rules
-- ===========================================================================
do $$
begin
  begin
    insert into public.chat_turns (user_id, chat_id, kind, origin)
    values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'person', 'person');
    raise exception 'a person turn without typed words should have been refused';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.chat_turns (user_id, chat_id, kind, origin)
    values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'status', 'code');
    raise exception 'a status turn without its event should have been refused';
  exception when check_violation then
    null;
  end;
end $$;

insert into public.chat_turns (id, user_id, chat_id, kind, typed, origin) values
  ('dddddddd-2222-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'person', 'hello from a', 'person'),
  ('dddddddd-2222-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 'dddddddd-1111-0000-0000-000000000002', 'person', 'hello from b', 'person');
insert into public.proposals (id, user_id, kind, payload) values
  ('dddddddd-3333-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'search', '{"role_types":["ai_engineer"]}'),
  ('dddddddd-3333-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 'search', '{"role_types":["designer"]}');

-- ===========================================================================
-- Row level security
-- ===========================================================================
do $$
declare
  t text;
begin
  foreach t in array array['projects', 'chats', 'chat_attachments', 'chat_turns', 'proposals'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ': row level security is on';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), t || ': anon must not read';
    assert not has_table_privilege('authenticated', 'public.' || t, 'insert'), t || ': authenticated must not insert';
    assert not has_table_privilege('authenticated', 'public.' || t, 'update'), t || ': authenticated must not update';
    assert not has_table_privilege('authenticated', 'public.' || t, 'delete'), t || ': authenticated must not delete';
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.chats) = 1, 'a reads only their chat';
  assert (select count(*) from public.chat_attachments) = 26, 'a reads their own tiles, removed ones included';
  assert (select count(*) from public.chat_turns) = 1, 'a reads only their turn';
  assert (select typed from public.chat_turns) = 'hello from a';
  assert (select count(*) from public.proposals) = 1, 'a reads only their proposal';
end $$;

select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  assert (select count(*) from public.chats) = 1, 'b reads only their chat';
  assert (select title from public.chats) = 'B chat';
  assert (select count(*) from public.chat_attachments) = 0, 'b reads none of a''s tiles';
  assert (select typed from public.chat_turns) = 'hello from b', 'b reads only their turn';
  assert (select payload ->> 'role_types' from public.proposals) like '%designer%', 'b reads only their proposal';
end $$;
reset role;

rollback;

\echo chat tables checks passed
