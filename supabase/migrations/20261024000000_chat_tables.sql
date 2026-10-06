-- Chat, part 1: projects, chats, attached things, turns and proposals.
--
-- WHY
--   Chat holds any number of roles, companies, applications, people, earlier
--   chats and made things as ordered tiles (`chat_attachments`), keeps every
--   turn with the person's typed words apart from Cello's answer
--   (`chat_turns`), and keeps what Cello proposes until the person decides
--   (`proposals`). `projects` is code's name for one application's chats and
--   made things: nothing a person sees ever names one.
--
--   Every column and key later packages use is created here, so none of them
--   alters these tables.
--
-- Rules the database keeps (so no caller has to):
--   * a chat holds at most 25 attached things at once, counted under a lock on
--     the chat row so two attaches racing each other cannot make 26;
--   * the position of a tile is set here, in attach order;
--   * one active tile per (chat, kind, ref); detaching keeps the row;
--   * a person turn has typed words; a status turn names its event.
--
-- Access: the owner reads their own rows. Every write goes through the server
-- (service role). The thread id of a chat is its own id (graph_threads.thread_id).

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) <= 80),
  kind text not null default 'application' check (kind = 'application'),
  application_id uuid not null unique references public.applications (id) on delete cascade,
  created_by text not null default 'code' check (created_by = 'code'),
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  pinned_at timestamptz,
  archived_at timestamptz
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 80),
  created_at timestamptz not null default now(),
  last_turn_at timestamptz not null default now(),
  archived_at timestamptz,
  project_id uuid references public.projects (id) on delete set null,
  pinned_at timestamptz,
  -- {rung, model, effort}; null means the person's default.
  model_choice jsonb,
  -- {review: boolean, off: [tool groups]}
  settings jsonb not null default '{}'
);

create index if not exists idx_chats_user_recent
  on public.chats (user_id, pinned_at desc nulls last, last_turn_at desc);

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  -- Set by the trigger below, in attach order.
  position int not null,
  kind text not null check (kind in ('role', 'preview', 'company', 'application', 'person', 'chat', 'made', 'material')),
  ref jsonb not null,
  origin text not null check (origin in ('person', 'model')),
  -- {door} for the person; {turn_id} when Cello attached it from a tool result of that turn.
  prov jsonb,
  confirmed_at timestamptz,
  added_at timestamptz not null default now(),
  removed_at timestamptz
);

create unique index if not exists chat_attachments_active_uq
  on public.chat_attachments (chat_id, kind, ref) where removed_at is null;
create index if not exists idx_chat_attachments_chat on public.chat_attachments (chat_id, position);

create or replace function public.chat_attachment_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chat_owner uuid;
  active int;
  last_position int;
begin
  -- The lock is what makes the count honest when two attaches race.
  select c.user_id into chat_owner from public.chats c where c.id = new.chat_id for update;
  if chat_owner is null or chat_owner <> new.user_id then
    raise exception 'chat % is not this person''s', new.chat_id using errcode = 'check_violation';
  end if;
  select count(*) filter (where a.removed_at is null), coalesce(max(a.position), 0)
    into active, last_position
    from public.chat_attachments a where a.chat_id = new.chat_id;
  if new.removed_at is null and active >= 25 then
    raise exception 'A chat holds at most 25 things' using errcode = 'check_violation';
  end if;
  new.position := last_position + 1;
  return new;
end
$$;

drop trigger if exists chat_attachments_before_insert on public.chat_attachments;
create trigger chat_attachments_before_insert
  before insert on public.chat_attachments
  for each row execute function public.chat_attachment_before_insert();

create table if not exists public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  kind text not null check (kind in ('person', 'cello', 'status')),
  -- Only what reached the text field by keystrokes, paste or dictation: the one source for own-words checks.
  typed text check (typed is null or char_length(typed) <= 20000),
  answer text,
  -- person for a person turn, model for Cello's answer, code for a status turn.
  origin text not null check (origin in ('person', 'code', 'model')),
  prov jsonb,
  confirmed_at timestamptz,
  -- [{about: [{kind, ref}], text} | {card: {kind, ref}}]
  parts jsonb not null default '[]',
  -- [{kind, table, id, role: named | made | recalled}]
  links jsonb not null default '[]',
  -- A status turn's pipeline_events row. No foreign key: that table is created by a later package.
  -- ponytail: add the key when pipeline_events exists, in the status-turn migration.
  event_id uuid,
  -- A selection quoted from an earlier answer: {text, turn_id}. Never typed words.
  quoted jsonb,
  model_choice jsonb,
  ran jsonb,
  disclosure jsonb,
  branch_of uuid references public.chat_turns (id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chat_turns_person_has_typed check (kind <> 'person' or typed is not null),
  constraint chat_turns_status_has_event check (kind <> 'status' or event_id is not null)
);

create index if not exists idx_chat_turns_chat on public.chat_turns (chat_id, created_at);

create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('search', 'answers', 'material', 'instructions', 'learned', 'start')),
  payload jsonb not null,
  -- The person's own words the proposal rests on, checked against what they typed.
  quote text,
  channel text,
  status text not null default 'open' check (status in ('open', 'confirmed', 'dismissed')),
  origin text not null default 'model' check (origin in ('person', 'code', 'model')),
  prov jsonb,
  confirmed_at timestamptz,
  chat_id uuid references public.chats (id) on delete set null,
  turn_id uuid references public.chat_turns (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists idx_proposals_user_open on public.proposals (user_id, created_at desc) where status = 'open';

do $$
declare
  t text;
begin
  foreach t in array array['projects', 'chats', 'chat_attachments', 'chat_turns', 'proposals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'own ' || t || ' select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      'own ' || t || ' select', t
    );
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_turns'
  ) then
    alter publication supabase_realtime add table public.chat_turns;
  end if;
end
$$;

-- The switches the owner flips. All off. instance_flags belongs to a package that may
-- not have landed when this runs, so the insert waits for the table instead of making it.
do $$
begin
  if to_regclass('public.instance_flags') is not null then
    insert into public.instance_flags (key, "on", note) values
      ('chat_shown', false, 'off: Chat stays hidden from everyone but the owner until S13, S14, S15 and S21 pass'),
      ('chat_recall_words', false, 'off: recall in words stays off until S22 passes'),
      ('chat_apply', false, 'off: Chat applies through the pipeline only when the owner turns this on')
    on conflict (key) do nothing;
  end if;
end
$$;

notify pgrst, 'reload schema';

do $$
declare
  t text;
begin
  foreach t in array array['projects', 'chats', 'chat_attachments', 'chat_turns', 'proposals'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception 'row level security is not enabled on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'anon must not read %', t;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.chat_attachments'::regclass and tgname = 'chat_attachments_before_insert') then
    raise exception 'the 25 tile limit trigger is missing';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'chat_turns'
  ) then
    raise exception 'chat_turns is not in the realtime publication';
  end if;
end
$$;
