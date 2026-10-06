-- Chat, part 2: what recall needs from the tables.
--
-- WHY
--   Recall across chats (chat.recall) searches meaning first, through the memory store, and falls back to words when
--   the embedder is down. The words path reads two generated search columns, one on a chat's title and one on the
--   words a person typed, so it costs no write and cannot drift from the rows. A made thing names the turn that made
--   it, so the page can follow it back to its chat and a deleted chat leaves what it made in place.
--
--   chats.tsv        search over the chat's title
--   chat_turns.tsv   search over the typed words only (never Cello's answer)
--   artifacts.chat_turn_id   the turn that made this row; set null when the turn goes with its chat

alter table public.chats
  add column if not exists tsv tsvector generated always as (to_tsvector('simple', title)) stored;
alter table public.chat_turns
  add column if not exists tsv tsvector generated always as (to_tsvector('simple', coalesce(typed, ''))) stored;

create index if not exists idx_chats_tsv on public.chats using gin (tsv);
create index if not exists idx_chat_turns_tsv on public.chat_turns using gin (tsv);

alter table public.artifacts
  add column if not exists chat_turn_id uuid references public.chat_turns (id) on delete set null;
create index if not exists idx_artifacts_chat_turn on public.artifacts (chat_turn_id) where chat_turn_id is not null;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chats' and column_name = 'tsv')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_turns' and column_name = 'tsv') then
    raise exception 'the chat search columns are missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artifacts' and column_name = 'chat_turn_id') then
    raise exception 'artifacts.chat_turn_id is missing';
  end if;
end
$$;
