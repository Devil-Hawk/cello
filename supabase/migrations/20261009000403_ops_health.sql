-- The owner's health report: one row a day.
--
-- The free database is 500 MB and filled once already (2026-09-25), a background
-- routine can stop without anyone noticing, and a source can fail for days. The
-- daily health check (lib/quality/health.ts) stores what it saw here: the database
-- size, the biggest tables, how fresh each routine is and which sources keep
-- failing. Routine freshness is read from job_heartbeats, the only heartbeat.
--
-- The table is for the service role only. The owner reads the latest row through
-- /api/ops/health, which checks who is asking; nothing here is reachable from
-- the browser or the public key.

-- An earlier draft kept a second heartbeat table and an alerts table. Neither is used.
drop table if exists public.cron_heartbeats, public.ops_alerts;

create table if not exists public.ops_health_checks (
  checked_at timestamptz primary key default now(),
  -- Null when the size could not be read: the report says so rather than showing 0.
  db_bytes bigint,
  report jsonb not null
);

alter table public.ops_health_checks enable row level security;
revoke all on public.ops_health_checks from public, anon, authenticated;
grant all on public.ops_health_checks to service_role;

-- The database size and its biggest tables.
create or replace function public.ops_db_stats()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'bytes', t.bytes) order by t.bytes desc)
      from (
        select c.relname as name, pg_total_relation_size(c.oid) as bytes
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc
        limit 15
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.ops_db_stats() from public, anon, authenticated;
grant execute on function public.ops_db_stats() to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.ops_health_checks'::regclass) then
    raise exception 'ops_health_checks must have row level security on';
  end if;
  if has_table_privilege('anon', 'public.ops_health_checks', 'select')
     or has_table_privilege('authenticated', 'public.ops_health_checks', 'select') then
    raise exception 'ops_health_checks must be for the service role only';
  end if;
  if has_function_privilege('anon', 'public.ops_db_stats()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_db_stats()', 'execute') then
    raise exception 'ops_db_stats is for the service role only';
  end if;
  if to_regclass('public.cron_heartbeats') is not null or to_regclass('public.ops_alerts') is not null then
    raise exception 'cron_heartbeats and ops_alerts are not kept';
  end if;
end
$$;
