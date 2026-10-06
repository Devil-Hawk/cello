-- K4 clock: one clock, in the database.
--
-- WHY
--   Background work ran on GitHub's schedule (late, sometimes dropped: it started once in 14
--   hours on 2026-10-05) and on one Vercel cron. A free Vercel function lives 300 seconds, so
--   long work runs in slices that hand themselves on. The schedule lives here: pg_cron runs
--   agent_sweep() every minute. When a routine is due it posts a signed body to the app's
--   /api/agent/continue through pg_net, and the app runs it. When nothing is due it posts
--   nothing.
--
-- WHAT
--   routines          what runs when: per person (user_id) or for the instance (user_id null)
--   job_heartbeats    the last start, success and next due time of each routine, for the pages
--   clock_meter       function milliseconds this month; at 80 percent of the allowance new
--                     background work stops
--   measures, measure_runs   the register of what is measured and each run (rows: 20261008045000)
--
--   The endpoint and the signing secret come from Supabase Vault (agent_continue_url,
--   agent_continue_secret). The rendered tier's dispatch needs a third row, github_dispatch_token.
--   Without the first two the sweeper does nothing and background_ready() is false.
--
--   The cron job itself is scheduled by 20261008040001, after the deploy answers.
--
--   The body is signed over its jsonb text. The route also accepts the compact form of the same
--   body, so a pg_net that serialises differently does not refuse every call.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  -- null for a routine of the instance
  user_id uuid references public.profiles (id) on delete cascade,
  command text not null check (char_length(command) between 1 and 80),
  args jsonb not null default '{}'::jsonb,
  -- A routine runs at a local time every day, or every so often, or is a switch with neither.
  local_time time,
  every interval,
  timezone text not null default 'UTC',
  next_due_at timestamptz,
  enabled boolean not null default true,
  created_by text not null default 'code' check (created_by in ('code', 'person')),
  origin text,
  -- The sweeper posted this routine at this time; it is not posted again for two minutes.
  poked_at timestamptz,
  -- A slice of the routine is running until this time.
  lease_until timestamptz,
  -- Where the last slice stopped, for the routine's own bookkeeping.
  slice jsonb,
  created_at timestamptz not null default now(),
  check (not (local_time is not null and every is not null))
);

create unique index if not exists routines_command_user_key
  on public.routines (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists routines_due_idx on public.routines (next_due_at) where enabled and next_due_at is not null;
create index if not exists routines_user_idx on public.routines (user_id) where user_id is not null;

create table if not exists public.job_heartbeats (
  job text not null,
  user_id uuid references public.profiles (id) on delete cascade,
  started_at timestamptz,
  succeeded_at timestamptz,
  next_due_at timestamptz,
  -- boards read, roles kept, counted out, cannot read: whatever the routine counted
  found jsonb not null default '{}'::jsonb,
  failure text,
  duration_ms bigint
);

create unique index if not exists job_heartbeats_job_user_key
  on public.job_heartbeats (job, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.clock_meter (
  month date primary key,
  duration_ms bigint not null default 0
);

create table if not exists public.measures (
  id text primary key,
  layer text not null check (layer in ('true', 'step', 'person')),
  name text not null,
  bar text not null,
  direction text,
  source text,
  gates text[] not null default '{}',
  state text not null default 'watch' check (state in ('watch', 'gating'))
);

create table if not exists public.measure_runs (
  id bigint generated always as identity primary key,
  measure_id text not null references public.measures (id) on delete cascade,
  ran_at timestamptz not null default now(),
  value numeric,
  passed boolean,
  sample_n integer,
  note text
);

create index if not exists measure_runs_measure_idx on public.measure_runs (measure_id, ran_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: a person reads their own rows and the instance's; only code writes.
-- ---------------------------------------------------------------------------

alter table public.routines enable row level security;
alter table public.job_heartbeats enable row level security;
alter table public.clock_meter enable row level security;
alter table public.measures enable row level security;
alter table public.measure_runs enable row level security;

revoke all on public.routines, public.job_heartbeats, public.clock_meter, public.measures, public.measure_runs from anon, authenticated;
grant select on public.routines, public.job_heartbeats to authenticated;
grant all on public.routines, public.job_heartbeats, public.clock_meter, public.measures, public.measure_runs to service_role;
grant usage, select on sequence public.measure_runs_id_seq to service_role;

drop policy if exists routines_select on public.routines;
create policy routines_select on public.routines
  for select to authenticated using (user_id is null or user_id = (select auth.uid()));

drop policy if exists job_heartbeats_select on public.job_heartbeats;
create policy job_heartbeats_select on public.job_heartbeats
  for select to authenticated using (user_id is null or user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Heartbeats and the meter
-- ---------------------------------------------------------------------------

create or replace function public.record_meter(p_ms bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.clock_meter (month, duration_ms)
  values (date_trunc('month', now())::date, greatest(coalesce(p_ms, 0), 0))
  on conflict (month) do update set duration_ms = public.clock_meter.duration_ms + excluded.duration_ms
$$;

create or replace function public.start_heartbeat(p_job text, p_user uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.job_heartbeats (job, user_id, started_at)
  values (p_job, p_user, now())
  on conflict (job, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set started_at = now();
end;
$$;

create or replace function public.finish_heartbeat(
  p_job text,
  p_user uuid,
  p_ok boolean,
  p_found jsonb default '{}'::jsonb,
  p_failure text default null,
  p_duration_ms bigint default 0,
  p_next_due timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.job_heartbeats (job, user_id, started_at, succeeded_at, next_due_at, found, failure, duration_ms)
  values (
    p_job, p_user, now(),
    case when p_ok then now() end,
    p_next_due,
    coalesce(p_found, '{}'::jsonb),
    case when p_ok then null else left(coalesce(p_failure, 'failed'), 500) end,
    greatest(coalesce(p_duration_ms, 0), 0)
  )
  on conflict (job, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set
    -- a failure keeps the last success and the due time the person was promised
    succeeded_at = case when p_ok then now() else public.job_heartbeats.succeeded_at end,
    next_due_at = case when p_ok then p_next_due else public.job_heartbeats.next_due_at end,
    found = case when p_ok then coalesce(p_found, '{}'::jsonb) else public.job_heartbeats.found end,
    failure = case when p_ok then null else left(coalesce(p_failure, 'failed'), 500) end,
    duration_ms = greatest(coalesce(p_duration_ms, 0), 0);

  perform public.record_meter(p_duration_ms);
end;
$$;

-- 80 percent of Vercel Hobby's 360 GB-hours at 2 GB, in milliseconds. lib/clock/meter.ts holds the
-- same number and a test keeps the two equal. An estimate until the slice measurements (SP6).
create or replace function public.clock_allowance_ms()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 518400000::bigint $$;

-- ---------------------------------------------------------------------------
-- Routines of a person
-- ---------------------------------------------------------------------------

create or replace function public.ensure_person_routines(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Spread the first checks over ten minutes so a new instance does not read everyone at once.
  insert into public.routines (user_id, command, every, timezone, next_due_at, origin)
  values (p_user, 'roles.check', interval '6 hours', 'UTC', now() + random() * interval '10 minutes', 'default')
  on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;
end;
$$;

create or replace function public.profiles_ensure_routines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A demo never reads company sites on a schedule.
  if not coalesce(new.is_demo, false) then
    perform public.ensure_person_routines(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_ensure_routines on public.profiles;
create trigger profiles_ensure_routines
  after insert on public.profiles
  for each row execute function public.profiles_ensure_routines();

select public.ensure_person_routines(p.id)
from public.profiles p
where not coalesce(p.is_demo, false);

-- ---------------------------------------------------------------------------
-- Routines of the instance
-- ---------------------------------------------------------------------------

insert into public.routines (user_id, command, every, local_time, timezone, next_due_at, enabled, origin) values
  (null, 'inbox.sync',     interval '1 hour',    null,    'UTC', now() + interval '1 minute',  true,  'default'),
  (null, 'owner.health',   null,                 '06:00', 'UTC', date_trunc('day', now()) + interval '1 day 6 hours', true, 'default'),
  (null, 'clock.meter',    interval '1 hour',    null,    'UTC', now() + interval '2 minutes', true,  'default'),
  (null, 'clock.prune',    null,                 '03:30', 'UTC', date_trunc('day', now()) + interval '1 day 3 hours 30 minutes', true, 'default'),
  (null, 'harness.resume', interval '5 minutes', null,    'UTC', now() + interval '1 minute',  true,  'default'),
  (null, 'demo.expire',    interval '1 hour',    null,    'UTC', now() + interval '3 minutes', true,  'default'),
  (null, 'harness.digest', null,                 '13:07', 'UTC', date_trunc('day', now()) + interval '13 hours 7 minutes' + case when now() >= date_trunc('day', now()) + interval '13 hours 7 minutes' then interval '1 day' else interval '0' end, true, 'default'),
  (null, 'harness.distill', null,                '14:00', 'UTC', date_trunc('day', now()) + interval '14 hours' + case when now() >= date_trunc('day', now()) + interval '14 hours' then interval '1 day' else interval '0' end, true, 'default'),
  -- The rendered tier's dispatch has no handler: this row is the switch. It ships off until S11 passes.
  (null, 'roles.render',   null,                 null,    'UTC', null,                         false, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

-- ---------------------------------------------------------------------------
-- Is background work possible on this server?
-- ---------------------------------------------------------------------------

create or replace function public.background_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'agent_continue_url' and decrypted_secret is not null)
     and exists (select 1 from vault.decrypted_secrets where name = 'agent_continue_secret' and decrypted_secret is not null)
     and exists (select 1 from cron.job where jobname = 'cello-agent-sweep' and coalesce(active, true))
$$;

-- ---------------------------------------------------------------------------
-- The sweeper
-- ---------------------------------------------------------------------------

create or replace function public.clock_post(p_endpoint text, p_secret text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := p_endpoint,
    body := p_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cello-Signature', encode(extensions.hmac(convert_to(p_body::text, 'utf8'), convert_to(p_secret, 'utf8'), 'sha256'), 'hex')
    )
  );
end;
$$;

-- Branches: (a) the meter, (b) routines that are due, (c) stalled agent work, (d) the rendered
-- dispatch. A later package adds routine rows, never a new body; K13 replaces this function once
-- to add the application branches and keeps each of these.
create or replace function public.agent_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  secret text;
  gh_token text;
  sent integer := 0;
  r record;
  body jsonb;
  paused boolean;
  ids text;
  render_enabled boolean;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets where name = 'agent_continue_url' limit 1;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'agent_continue_secret' limit 1;
  if endpoint is null or secret is null then
    return 0;
  end if;

  -- (a) the meter: at the allowance, nothing new starts this month
  select coalesce(m.duration_ms, 0) >= public.clock_allowance_ms() into paused
    from (select 1) one left join public.clock_meter m on m.month = date_trunc('month', now())::date;
  if coalesce(paused, false) then
    return 0;
  end if;

  -- (b) routines that are due. The runner holds a lease while a slice runs, so a long slice is
  -- not posted again; a slice that died is picked up when its lease runs out.
  for r in
    select id from public.routines
     where enabled
       and next_due_at is not null
       and next_due_at <= now()
       and (poked_at is null or poked_at < now() - interval '2 minutes')
       and (lease_until is null or lease_until < now())
     order by next_due_at
     limit 20
     for update skip locked
  loop
    update public.routines set poked_at = now() where id = r.id;
    perform public.clock_post(endpoint, secret, jsonb_build_object(
      'reason', 'routine',
      'routine_id', r.id,
      'exp', extract(epoch from now())::bigint + 300
    ));
    sent := sent + 1;
  end loop;

  -- (c) stalled agent work. The old harness runs are covered by the harness.resume routine.
  -- Agent tasks and the thread lease arrive with the engine; until both exist this does nothing.
  if to_regclass('public.agent_tasks') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'graph_threads' and column_name = 'lease_until'
     ) then
    for r in execute $q$
      select t.id, t.thread_id
        from public.agent_tasks t
        join public.graph_threads g on g.thread_id = t.thread_id
       where t.parent_id is null
         and t.status = 'working'
         and t.heartbeat_at < now() - interval '90 seconds'
         and (g.lease_until is null or g.lease_until < now())
       order by t.heartbeat_at
       limit 10
         for update of t skip locked
    $q$
    loop
      -- A poke counts as a beat, so a task that cannot start is retried every 90 seconds.
      execute 'update public.agent_tasks set heartbeat_at = now() where id = $1' using r.id;
      perform public.clock_post(endpoint, secret, jsonb_build_object(
        'reason', 'stale',
        'thread_id', r.thread_id,
        'exp', extract(epoch from now())::bigint + 300
      ));
      sent := sent + 1;
    end loop;
  end if;

  -- (d) the rendered dispatch: companies whose site only a browser can read, as one GitHub run.
  select enabled into render_enabled from public.routines where command = 'roles.render' and user_id is null;
  select decrypted_secret into gh_token from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if coalesce(render_enabled, false) and gh_token is not null
     and not exists (
       select 1 from public.job_heartbeats h
        where h.job = 'roles.render' and h.user_id is null
          and h.started_at > now() - interval '60 minutes'
          and (h.succeeded_at is null or h.succeeded_at < h.started_at)
     ) then
    select string_agg(c.id::text, ',') into ids
      from (
        select id from public.companies
         where (metadata->>'suggested' is null or metadata->>'suggested' <> 'true')
           and metadata->'source_check'->>'reason' = 'reading'
           and (last_scraped_at is null or last_scraped_at < now() - interval '6 hours')
         order by last_scraped_at nulls first
         limit 50
      ) c;
    if ids is not null then
      perform net.http_post(
        url := 'https://api.github.com/repos/Devil-Hawk/cello/actions/workflows/scrape.yml/dispatches',
        body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('company_ids', ids)),
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || gh_token,
          'Accept', 'application/vnd.github+json',
          'X-GitHub-Api-Version', '2022-11-28',
          'User-Agent', 'cello-clock',
          'Content-Type', 'application/json'
        )
      );
      perform public.start_heartbeat('roles.render', null);
      sent := sent + 1;
    end if;
  end if;

  return sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prune, as the clock.prune routine's SQL
-- ---------------------------------------------------------------------------

create or replace function public.clock_prune()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pruned jsonb;
  runs_deleted bigint;
  measures_deleted bigint;
  slots_deleted bigint := 0;
begin
  pruned := public.prune_stale_rows();

  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics runs_deleted = row_count;

  delete from public.measure_runs where ran_at < now() - interval '400 days';
  get diagnostics measures_deleted = row_count;

  -- Chat's command slots arrive with K10; until then there is nothing to clean.
  if to_regclass('public.command_slots') is not null then
    execute 'delete from public.command_slots where created_at < now() - interval ''1 day''';
    get diagnostics slots_deleted = row_count;
  end if;

  delete from public.clock_meter where month < (date_trunc('month', now()) - interval '13 months')::date;

  return pruned || jsonb_build_object(
    'cron_runs', runs_deleted, 'measure_runs', measures_deleted, 'command_slots', slots_deleted
  );
end;
$$;

-- prune-stale-rows had its own pg_cron job; the clock runs it now.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-stale-rows') then
    perform cron.unschedule('prune-stale-rows');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping, not an API: nobody but the service role runs these over the Data API.
-- ---------------------------------------------------------------------------

revoke all on function public.record_meter(bigint) from public, anon, authenticated;
revoke all on function public.start_heartbeat(text, uuid) from public, anon, authenticated;
revoke all on function public.finish_heartbeat(text, uuid, boolean, jsonb, text, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.clock_allowance_ms() from public, anon, authenticated;
revoke all on function public.ensure_person_routines(uuid) from public, anon, authenticated;
revoke all on function public.profiles_ensure_routines() from public, anon, authenticated;
revoke all on function public.background_ready() from public, anon, authenticated;
revoke all on function public.clock_post(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.agent_sweep() from public, anon, authenticated;
revoke all on function public.clock_prune() from public, anon, authenticated;
grant execute on function public.record_meter(bigint) to service_role;
grant execute on function public.start_heartbeat(text, uuid) to service_role;
grant execute on function public.finish_heartbeat(text, uuid, boolean, jsonb, text, bigint, timestamptz) to service_role;
grant execute on function public.clock_allowance_ms() to service_role;
grant execute on function public.ensure_person_routines(uuid) to service_role;
grant execute on function public.background_ready() to service_role;
grant execute on function public.agent_sweep() to service_role;
grant execute on function public.clock_prune() to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.record_meter(bigint)',
    'public.start_heartbeat(text, uuid)',
    'public.finish_heartbeat(text, uuid, boolean, jsonb, text, bigint, timestamptz)',
    'public.clock_allowance_ms()',
    'public.ensure_person_routines(uuid)',
    'public.profiles_ensure_routines()',
    'public.background_ready()',
    'public.clock_post(text, text, jsonb)',
    'public.agent_sweep()',
    'public.clock_prune()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be executable by client roles', f;
    end if;
  end loop;
  if exists (select 1 from cron.job where jobname = 'prune-stale-rows') then
    raise exception 'prune-stale-rows must be unscheduled';
  end if;
  if (select enabled from public.routines where command = 'roles.render' and user_id is null) then
    raise exception 'the rendered dispatch must ship off';
  end if;
end
$$;
