-- One row per user per scheduled ingestion, plus the lock that keeps two
-- ingestions from reading the same companies at the same time.
--
-- ingestion_runs is what the app shows as the "Find new roles" scheduled task:
-- when it last ran, how many companies it checked, what it found, what closed,
-- what failed. A scheduled ingestion covers every user's companies, so it writes
-- one row per user (same batch_id), each holding only that user's numbers.
-- Written by the service role only; a signed-in user can read their own rows.

create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  task text not null default 'find_new_roles',
  trigger text not null default 'schedule' check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  companies_checked integer not null default 0,
  companies_failed integer not null default 0,
  jobs_found integer not null default 0,
  jobs_new integer not null default 0,
  jobs_updated integer not null default 0,
  jobs_closed integer not null default 0,
  -- {"greenhouse": {"companies": 3, "found": 120, "new": 4, "failed": 0}, ...}
  -- "page_reader" and "aggregators" appear here too.
  by_provider jsonb not null default '{}'::jsonb,
  -- {"greenhouse": 1, "page_reader": 2}: how many companies each provider failed for.
  failures_by_provider jsonb not null default '{}'::jsonb
);

create index if not exists idx_ingestion_runs_user_started on public.ingestion_runs (user_id, started_at desc);
create index if not exists idx_ingestion_runs_batch on public.ingestion_runs (batch_id);

alter table public.ingestion_runs enable row level security;

drop policy if exists "own ingestion_runs select" on public.ingestion_runs;
create policy "own ingestion_runs select" on public.ingestion_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.ingestion_runs from public, anon, authenticated;
grant select on public.ingestion_runs to authenticated;
grant all on public.ingestion_runs to service_role;

-- ---------------------------------------------------------------------------
-- The lock. One row per name; a holder owns it until it releases it or the
-- lease runs out (so a crashed run cannot block the next one forever).
-- ---------------------------------------------------------------------------
create table if not exists public.ingestion_locks (
  name text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.ingestion_locks enable row level security;
revoke all on public.ingestion_locks from public, anon, authenticated;
grant all on public.ingestion_locks to service_role;

create or replace function public.acquire_ingestion_lock(p_name text, p_holder text, p_lease_minutes integer default 120)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  got text;
begin
  insert into public.ingestion_locks as l (name, holder, acquired_at, expires_at)
  values (p_name, p_holder, now(), now() + make_interval(mins => p_lease_minutes))
  on conflict (name) do update
    set holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    where l.expires_at < now() or l.holder = excluded.holder
  returning holder into got;
  return got is not null and got = p_holder;
end;
$$;

create or replace function public.release_ingestion_lock(p_name text, p_holder text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.ingestion_locks where name = p_name and holder = p_holder;
$$;

revoke all on function public.acquire_ingestion_lock(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_ingestion_lock(text, text) from public, anon, authenticated;
grant execute on function public.acquire_ingestion_lock(text, text, integer) to service_role;
grant execute on function public.release_ingestion_lock(text, text) to service_role;

do $$
begin
  if has_table_privilege('anon', 'public.ingestion_runs', 'select')
     or has_table_privilege('anon', 'public.ingestion_locks', 'select')
     or has_table_privilege('authenticated', 'public.ingestion_locks', 'select')
     or has_table_privilege('authenticated', 'public.ingestion_runs', 'insert') then
    raise exception 'ingestion tables are open to a role that must not touch them';
  end if;
end
$$;
