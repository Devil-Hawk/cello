-- Agent engine, part 4: the live task tree.
--
-- WHY
--   While Cello works, the person sees what it is doing: one line per task,
--   with sub-tasks for each specialist and each branch of a fan-out ("Researching
--   6 companies (4 done, 1 partial, 1 failed)"). The graph writes these rows and
--   Supabase Realtime pushes them to the browser, so the tree survives a
--   reconnect and a continuation in a new request. `heartbeat_at` lets the
--   sweeper tell a task that is still working from one whose request died.
--
-- Access: the owner reads their own rows (and Realtime delivers them). Only the
-- server writes.

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_id uuid not null references public.graph_threads (thread_id) on delete cascade,
  conversation_id uuid references public.copilot_conversations (id) on delete cascade,
  scheduled_task_id uuid references public.scheduled_tasks (id) on delete set null,
  parent_id uuid references public.agent_tasks (id) on delete cascade,
  agent text not null check (agent in ('cello', 'scout', 'researcher', 'writer', 'reviewer', 'coach', 'applier')),
  title text not null check (char_length(title) <= 160),
  status text not null default 'queued' check (status in ('queued', 'working', 'waiting', 'done', 'partial', 'failed')),
  partial_reason text check (partial_reason in ('budget', 'time', 'steps')),
  branch_index int,
  caps jsonb,
  cost_usd numeric(10, 4) not null default 0,
  summary text check (summary is null or char_length(summary) <= 2000),
  artifact_ids uuid[] not null default '{}',
  trace_id text,
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_tasks_thread on public.agent_tasks (thread_id, created_at);
create index if not exists idx_agent_tasks_user_recent on public.agent_tasks (user_id, created_at desc);
-- The sweeper's question: which root tasks are marked working but stopped beating.
create index if not exists idx_agent_tasks_stale
  on public.agent_tasks (status, heartbeat_at)
  where parent_id is null and status = 'working';

alter table public.agent_tasks enable row level security;

drop policy if exists "own agent_tasks select" on public.agent_tasks;
create policy "own agent_tasks select" on public.agent_tasks
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.agent_tasks from public, anon, authenticated;
grant select on table public.agent_tasks to authenticated;
grant all on table public.agent_tasks to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_tasks'
  ) then
    alter publication supabase_realtime add table public.agent_tasks;
  end if;
end
$$;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.agent_tasks'::regclass and relrowsecurity) then
    raise exception 'row level security is not enabled on agent_tasks';
  end if;
  if has_table_privilege('anon', 'public.agent_tasks', 'select') then
    raise exception 'anon must not read agent_tasks';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'agent_tasks'
  ) then
    raise exception 'agent_tasks is not in the realtime publication';
  end if;
end
$$;
