-- Daily health check: heartbeats, one report per day, and open alerts.
--
-- The free database is 500 MB and filled once already (2026-09-25), schedules
-- can stop without anyone noticing, and a source can fail for days. The daily
-- harness cron records what it sees here and raises an alert row for the
-- owner when the database is near its limit, a schedule missed its window, or
-- a source failed three checks in a row (lib/quality/health.ts).
--
-- These tables are for the service role only. The owner reads alerts through
-- /api/ops/alerts, which checks who is asking; nothing here is reachable from
-- the browser or the public key.

create table if not exists public.cron_heartbeats (
  job text primary key check (job ~ '^[a-z-]{3,40}$'),
  last_started_at timestamptz,
  last_ok_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_health_checks (
  checked_at timestamptz primary key default now(),
  db_bytes bigint not null,
  report jsonb not null
);

create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('db_size', 'schedule_missed', 'source_failing')),
  subject text not null check (char_length(subject) between 1 and 80),
  message text not null check (char_length(message) <= 300),
  detail jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open alert per kind and subject; a resolved one can be followed by a new one.
create unique index if not exists ops_alerts_one_open_idx on public.ops_alerts (kind, subject) where resolved_at is null;

alter table public.cron_heartbeats enable row level security;
alter table public.ops_health_checks enable row level security;
alter table public.ops_alerts enable row level security;

revoke all on public.cron_heartbeats, public.ops_health_checks, public.ops_alerts from public, anon, authenticated;
grant all on public.cron_heartbeats, public.ops_health_checks, public.ops_alerts to service_role;

-- Database size, the biggest tables and, when pg_cron is installed, when each
-- scheduled job last succeeded. Dynamic SQL for the cron part so the function
-- also compiles on a database without the cron schema.
create or replace function public.ops_db_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tables jsonb;
  schedules jsonb := '[]'::jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'bytes', t.bytes) order by t.bytes desc), '[]'::jsonb)
    into tables
  from (
    select c.relname as name, pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc
    limit 15
  ) t;

  if exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
        'job', j.jobname,
        'last_ok_at', (select max(d.end_time) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'succeeded')
      )), '[]'::jsonb)
      from cron.job j
    $q$ into schedules;
  end if;

  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', tables,
    'schedules', schedules
  );
end;
$$;

revoke all on function public.ops_db_stats() from public, anon, authenticated;
grant execute on function public.ops_db_stats() to service_role;

notify pgrst, 'reload schema';

do $$
declare
  t text;
begin
  foreach t in array array['cron_heartbeats', 'ops_health_checks', 'ops_alerts'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% must have row level security on', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception '% must be for the service role only', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.ops_db_stats()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_db_stats()', 'execute') then
    raise exception 'ops_db_stats is for the service role only';
  end if;
end
$$;
