-- PR 4 (companies/scrapling): the queue for pages only a browser can read, and the clock step that wakes the worker.
--
-- render_jobs holds one row per page (or per employer search) the server could not read with plain
-- requests. The pull worker (packages/scrapers/src/worker.py) claims a row through a signed route,
-- reads the page in a browser and posts what it saw; it never holds a database key. Only the service
-- role touches this table. claim_render_job() hands out one row, and takes back a claim left for 20
-- minutes (the third such claim marks the job failed with 'timeout').

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('careers_page', 'web_search')),
  candidate_id uuid references public.directory_candidates (id) on delete cascade,
  url text,
  query text,
  state text not null default 'queued' check (state in ('queued', 'claimed', 'done', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  done_at timestamptz,
  result jsonb,
  failure text,
  created_at timestamptz not null default now()
);

create index if not exists render_jobs_state_idx on public.render_jobs (state, created_at);

alter table public.render_jobs enable row level security;
revoke all on public.render_jobs from anon, authenticated;
grant all on public.render_jobs to service_role;

create or replace function public.claim_render_job()
returns setof public.render_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.render_jobs;
begin
  update public.render_jobs
     set state = 'failed', failure = 'timeout', done_at = now()
   where state = 'claimed' and claimed_at < now() - interval '20 minutes' and attempts >= 3;
  update public.render_jobs
     set state = 'queued', claimed_at = null
   where state = 'claimed' and claimed_at < now() - interval '20 minutes' and attempts < 3;

  select * into r from public.render_jobs
   where state = 'queued'
   order by created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  update public.render_jobs
     set state = 'claimed', claimed_at = now(), attempts = attempts + 1
   where id = r.id
  returning * into r;
  return next r;
end;
$$;

revoke all on function public.claim_render_job() from public, anon, authenticated;
grant execute on function public.claim_render_job() to service_role;

-- A person's pasted link makes a candidate of its own.
alter table public.directory_candidates drop constraint if exists directory_candidates_source_check;
alter table public.directory_candidates add constraint directory_candidates_source_check check (source in ('kalil', 'yc', 'person'));

-- agent_sweep() with the worker's dispatch added as step (e); (a) to (d) are as the clock shipped them.
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
  queued integer;
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

  -- (e) the pull worker: pages only a browser can read wait in render_jobs. One GitHub run takes up
  -- to 50 of them, at most one run an hour.
  select count(*) into queued from public.render_jobs where state = 'queued';
  if queued > 0 and gh_token is not null
     and not exists (
       select 1 from public.job_heartbeats h
        where h.job = 'directory.read' and h.user_id is null
          and h.started_at > now() - interval '60 minutes'
     ) then
    perform net.http_post(
      url := 'https://api.github.com/repos/Devil-Hawk/cello/actions/workflows/directory-read.yml/dispatches',
      body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('count', least(queued, 50)::text)),
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || gh_token,
        'Accept', 'application/vnd.github+json',
        'X-GitHub-Api-Version', '2022-11-28',
        'User-Agent', 'cello-clock',
        'Content-Type', 'application/json'
      )
    );
    perform public.start_heartbeat('directory.read', null);
    sent := sent + 1;
  end if;

  return sent;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.render_jobs'::regclass and relrowsecurity) then
    raise exception 'render_jobs must have row level security on';
  end if;
  if has_table_privilege('anon', 'public.render_jobs', 'select') or has_table_privilege('authenticated', 'public.render_jobs', 'select') then
    raise exception 'render_jobs is for the service role only';
  end if;
  if has_function_privilege('anon', 'public.claim_render_job()', 'execute') or has_function_privilege('authenticated', 'public.claim_render_job()', 'execute') then
    raise exception 'claim_render_job must not be executable by client roles';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'directory_candidates_source_check' and pg_get_constraintdef(oid) like '%person%') then
    raise exception 'directory_candidates.source must allow person';
  end if;
  if pg_get_functiondef('public.agent_sweep()'::regprocedure) not like '%directory-read.yml%' then
    raise exception 'agent_sweep must dispatch the pull worker';
  end if;
  if has_function_privilege('anon', 'public.agent_sweep()', 'execute') or has_function_privilege('authenticated', 'public.agent_sweep()', 'execute') then
    raise exception 'agent_sweep must not be executable by client roles';
  end if;
end
$$;

notify pgrst, 'reload schema';
