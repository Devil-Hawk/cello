-- Chat, part 3: workers, what a turn costs, and what a chat makes.
--
-- WHY
--   A Chat turn that researches four companies shows four workers, each one a row in agent_tasks that the page
--   reads live. Each worker is about one thing, lists up to 50 reads that code wrote from its tool results, and
--   can be stopped: stop_requested_at is the one signal every branch checks before it calls a model or a tool.
--   A turn's cost is the sum of its ledger rows, so the ledger names the turn and the worker that made each call.
--   A made thing names the turn that made it, and the application's project it belongs to.
--
--   expand only: agent and conversation_id become optional here and are dropped by a later migration, once no
--   deployed code writes them.
--
--   artifacts.project_id            the application's project (code makes it; no person ever sees one)
--   artifact_versions.chat_turn_id  the turn that made this version
--   llm_spend.chat_turn_id, task_id the turn and the worker a call belonged to
--   agent_tasks                      command, chat_id, turn_id, object, reads, model, rung, stop_requested_at;
--                                    status gains stopped

alter table public.artifacts
  add column if not exists project_id uuid references public.projects (id) on delete set null;
create index if not exists idx_artifacts_project on public.artifacts (project_id) where project_id is not null;

alter table public.artifact_versions
  add column if not exists chat_turn_id uuid references public.chat_turns (id) on delete set null;

alter table public.agent_tasks
  add column if not exists command text check (command is null or char_length(command) <= 80),
  add column if not exists chat_id uuid references public.chats (id) on delete cascade,
  add column if not exists turn_id uuid references public.chat_turns (id) on delete cascade,
  -- {kind, ref}: the thing this worker is about.
  add column if not exists object jsonb,
  -- [{label, url or {table, id}, at}] written by code from tool results.
  add column if not exists reads jsonb not null default '[]',
  add column if not exists model text,
  add column if not exists rung text,
  add column if not exists stop_requested_at timestamptz;

alter table public.agent_tasks drop constraint if exists agent_tasks_reads_cap;
alter table public.agent_tasks add constraint agent_tasks_reads_cap check (jsonb_array_length(reads) <= 50);

alter table public.agent_tasks alter column agent drop not null;

alter table public.agent_tasks drop constraint if exists agent_tasks_status_check;
alter table public.agent_tasks
  add constraint agent_tasks_status_check
  check (status in ('queued', 'working', 'waiting', 'done', 'partial', 'failed', 'stopped'));

create index if not exists idx_agent_tasks_chat on public.agent_tasks (chat_id, created_at) where chat_id is not null;
create index if not exists idx_agent_tasks_turn on public.agent_tasks (turn_id) where turn_id is not null;

alter table public.llm_spend
  add column if not exists chat_turn_id uuid references public.chat_turns (id) on delete set null,
  add column if not exists task_id uuid references public.agent_tasks (id) on delete set null;
create index if not exists idx_llm_spend_chat_turn on public.llm_spend (chat_turn_id) where chat_turn_id is not null;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_tasks' and column_name = 'stop_requested_at')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'llm_spend' and column_name = 'task_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artifacts' and column_name = 'project_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artifact_versions' and column_name = 'chat_turn_id') then
    raise exception 'the chat workspace columns are missing';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.agent_tasks'::regclass and conname = 'agent_tasks_status_check' and pg_get_constraintdef(oid) like '%stopped%') then
    raise exception 'agent_tasks does not allow stopped';
  end if;
end
$$;
