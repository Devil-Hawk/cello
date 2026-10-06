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
--   chat_recall_words()      one query over the three, for one person, any word matching (the English config
--                            stems, so "compared" finds "compare")

alter table public.chats
  add column if not exists tsv tsvector generated always as (to_tsvector('english', title)) stored;
alter table public.chat_turns
  add column if not exists tsv tsvector generated always as (to_tsvector('english', coalesce(typed, ''))) stored;

create index if not exists idx_chats_tsv on public.chats using gin (tsv);
create index if not exists idx_chat_turns_tsv on public.chat_turns using gin (tsv);

alter table public.artifacts
  add column if not exists chat_turn_id uuid references public.chat_turns (id) on delete set null;
create index if not exists idx_artifacts_chat_turn on public.artifacts (chat_turn_id) where chat_turn_id is not null;

-- Words-only recall for one person: what they typed, what they titled a chat, what a made thing is called.
-- p_query is words joined by ' or '. Rows come back as ids; the caller reads each row before showing anything.
-- ponytail: artifact titles are matched without an index, which is fine to thousands of made things; add a
-- generated column and a GIN index on artifacts.title if that ever hurts.
create or replace function public.chat_recall_words(p_user uuid, p_query text, p_limit int default 10)
returns table (kind text, chat_id uuid, turn_id uuid, artifact_id uuid, score real)
language sql
stable
set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tq)
  (select 'turn'::text, t.chat_id, t.id, null::uuid, ts_rank(t.tsv, q.tq)
     from public.chat_turns t, q
    where t.user_id = p_user and t.kind = 'person' and t.superseded_at is null and t.tsv @@ q.tq
    order by 5 desc limit least(p_limit, 50))
  union all
  (select 'chat'::text, c.id, null::uuid, null::uuid, ts_rank(c.tsv, q.tq)
     from public.chats c, q
    where c.user_id = p_user and c.tsv @@ q.tq
    order by 5 desc limit least(p_limit, 50))
  union all
  (select 'made'::text, null::uuid, a.chat_turn_id, a.id, ts_rank(to_tsvector('english', a.title), q.tq)
     from public.artifacts a, q
    where a.user_id = p_user and to_tsvector('english', a.title) @@ q.tq
    order by 5 desc limit least(p_limit, 50))
$$;

revoke all on function public.chat_recall_words(uuid, text, int) from public, anon, authenticated;
grant execute on function public.chat_recall_words(uuid, text, int) to service_role;

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
  if has_function_privilege('anon', 'public.chat_recall_words(uuid, text, int)', 'execute')
     or has_function_privilege('authenticated', 'public.chat_recall_words(uuid, text, int)', 'execute') then
    raise exception 'chat_recall_words must be callable by the server only';
  end if;
end
$$;
