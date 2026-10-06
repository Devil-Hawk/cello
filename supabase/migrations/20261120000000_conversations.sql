-- PG6: "I have handled this". A reply the person answered from Gmail clears on the next read, and one they mark
-- handled clears at once. The mark is the person's own, written by the service role through conversations.handled.

alter table public.messages add column if not exists handled_at timestamptz;

create index if not exists messages_unhandled_idx on public.messages (user_id, sent_at desc) where direction = 'in' and handled_at is null;

notify pgrst, 'reload schema';

do $$
begin
  if has_table_privilege('authenticated', 'public.messages', 'insert')
     or has_table_privilege('authenticated', 'public.messages', 'update')
     or has_table_privilege('authenticated', 'public.messages', 'delete') then
    raise exception 'the session must not write messages';
  end if;
end
$$;
