-- Agent engine, part 1: conversations and threads.
--
-- WHY
--   The new Copilot runs every conversation, and every occurrence of a
--   scheduled task, as a LangGraph thread. Two threads must never resume the
--   same conversation at once (a checkpoint written by both would fork the
--   history), and the transaction pooler on port 6543 breaks session advisory
--   locks. So the lock is a lease on the thread row, claimed with one
--   conditional UPDATE (lib/agents/scheduler.ts claimLease).
--
--   graph_threads gets two surfaces: 'agent' (a conversation with Ask Cello)
--   and 'scheduled' (one occurrence of a scheduled task). The old 'copilot'
--   surface stays valid so earlier conversations remain readable.
--
-- Additive and idempotent.

alter table public.graph_threads drop constraint if exists graph_threads_surface_check;
alter table public.graph_threads
  add constraint graph_threads_surface_check
  check (surface in ('run', 'copilot', 'refresh', 'autopilot', 'agent', 'scheduled'));

alter table public.graph_threads add column if not exists lease_until timestamptz;
alter table public.graph_threads add column if not exists lease_holder uuid;

-- The sweeper looks for threads whose lease ran out while work was pending.
create index if not exists idx_graph_threads_lease
  on public.graph_threads (lease_until)
  where lease_until is not null;

-- Which scheduled task a conversation belongs to (its own results thread).
-- The foreign key is added by 20261006000602, once scheduled_tasks exists.
alter table public.copilot_conversations add column if not exists scheduled_task_id uuid;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'graph_threads' and column_name = 'lease_until'
  ) then
    raise exception 'graph_threads.lease_until is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.graph_threads'::regclass
      and conname = 'graph_threads_surface_check'
      and pg_get_constraintdef(oid) like '%scheduled%'
  ) then
    raise exception 'graph_threads surface check does not allow agent and scheduled';
  end if;
end
$$;
