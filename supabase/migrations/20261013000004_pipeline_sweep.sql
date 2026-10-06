-- K13: the second and last agent_sweep().
--
-- WHY
--   The sweeper is one function pg_cron calls every minute. K4 wrote it for routines, stalled agent
--   work and the rendered dispatch, and reserved one rewrite for the application branches. This is
--   it. Branches (a) to (d) are K4's text unchanged (the check below fails when one is missing);
--   (e) to (h) are new.
--
-- WHAT
--   (e) due applications posted to /api/agent/continue with reason advance, fairly
--   (f) a step that died: back to due, or Not sent after 3 tries
--   (g) a fill lease that ran out: Did you send it?, Your turn on the site, or Ready again
--   (h) the daily trim of pipeline events
--   and the backfill of what the old drafts and submissions already say

-- Branches: (a) the meter, (b) routines that are due, (c) stalled agent work, (d) the rendered
-- dispatch, copied from K4's migration unchanged; then K13's (e) due applications, (f) stale
-- heartbeats, (g) fill leases that ran out and (h) the daily trim of pipeline events. This is the
-- second and last body: a later package adds routine rows, never a new body.
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
  n integer;
  filled boolean;
  automatic boolean;
  sending boolean;
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

  -- (e) due applications: preparing or scheduled, due, no live lease, the person not paused. At most 10 a
  -- minute in all and 2 for any one person, the longest waiting first; a poke counts as a beat, so a row
  -- the advancer has not picked up is posted again a minute later.
  for r in
    select d.id from (
      select a.id, a.next_at,
             row_number() over (partition by a.user_id order by a.next_at) as rn
        from public.applications a
        join public.profiles p on p.id = a.user_id
       where a.state in ('preparing', 'scheduled')
         and a.next_at <= now()
         and (a.lease_until is null or a.lease_until < now())
         and (a.heartbeat_at is null or a.heartbeat_at < now() - interval '1 minute')
         and coalesce(p.preferences -> 'pipeline' ->> 'paused_at', '') = ''
    ) d
    where d.rn <= 2
    order by d.next_at
    limit 10
  loop
    update public.applications set heartbeat_at = now() where id = r.id;
    perform public.clock_post(endpoint, secret, jsonb_build_object(
      'reason', 'advance',
      'application_id', r.id,
      'exp', extract(epoch from now())::bigint + 300
    ));
    sent := sent + 1;
  end loop;

  -- (f) stale heartbeats: a preparing step whose lease ran out and that has not beaten for 3 minutes
  -- died. It goes back to due, and to Not sent after 3 tries.
  for r in
    select a.id, a.attempt
      from public.applications a
      join public.profiles p on p.id = a.user_id
     where a.state = 'preparing'
       and a.lease_until is not null and a.lease_until < now()
       and a.heartbeat_at < now() - interval '3 minutes'
       and coalesce(p.preferences -> 'pipeline' ->> 'paused_at', '') = ''
     order by a.heartbeat_at
     limit 20
  loop
    if r.attempt + 1 >= 3 then
      perform public.pipeline_transition(r.id, array['preparing'], 'not_sent', 'Cello could not finish preparing this.', null, null,
        jsonb_build_object('kind', 'step.failed', 'actor', 'schedule', 'channel', 'routine',
          'sentence', 'A step stopped three times. Cello could not finish preparing this.',
          'idempotency_key', 'stale:' || r.id || ':' || (r.attempt + 1), 'attempt_inc', true,
          'payload', jsonb_build_object('cause', 'stale')));
    else
      perform public.pipeline_transition(r.id, array['preparing'], 'preparing', 'Trying again', null, null,
        jsonb_build_object('kind', 'step.failed', 'actor', 'schedule', 'channel', 'routine',
          'sentence', 'A step stopped before it finished. Cello will try again.',
          'idempotency_key', 'stale:' || r.id || ':' || (r.attempt + 1), 'attempt_inc', true,
          'payload', jsonb_build_object('cause', 'stale')));
    end if;
  end loop;

  -- (g) fill leases that ran out. The person's own fill goes to "Did you send it?" when something was
  -- filled and back to Ready when nothing was. A Send for me claim that ended before the click goes to
  -- "Your turn on the site" (interrupted) and is never claimed again; one that ended after
  -- submission.sending may have clicked, so it asks "Did you send it?".
  for r in
    select a.id
      from public.applications a
     where a.state = 'applying' and a.lease_until is not null and a.lease_until < now()
     order by a.lease_until
     limit 20
  loop
    select coalesce((e.payload ->> 'auto')::boolean, false) into automatic
      from public.pipeline_events e
     where e.application_id = r.id and e.kind in ('fill.started', 'fill.auto_started')
     order by e.created_at desc limit 1;
    automatic := coalesce(automatic, false);
    select exists (select 1 from public.pipeline_events e where e.application_id = r.id and e.kind = 'submission.sending') into sending;
    select exists (
      select 1 from public.pipeline_events e
       where e.application_id = r.id and e.kind = 'fill.reported' and e.payload ->> 'phase' = 'filled'
         and e.created_at > coalesce((select max(s.created_at) from public.pipeline_events s where s.application_id = r.id and s.kind = 'fill.started'), '-infinity')
    ) into filled;

    if automatic and not sending then
      perform public.pipeline_transition(r.id, array['applying'], 'needs_you', 'Your turn on the site', 'your_turn',
        jsonb_build_object('cause', 'interrupted', 'auto', true),
        jsonb_build_object('kind', 'fill.blocked', 'actor', 'schedule', 'channel', 'routine',
          'sentence', 'Your browser closed before Cello sent this. Open it and click Fill.',
          'idempotency_key', 'lease:' || r.id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
          'payload', jsonb_build_object('cause', 'interrupted', 'auto', true)));
    elsif automatic or filled then
      perform public.pipeline_transition(r.id, array['applying'], 'needs_you', 'Did you send it?', 'check_sent',
        jsonb_build_object('auto', automatic),
        jsonb_build_object('kind', 'fill.reported', 'actor', 'schedule', 'channel', 'routine',
          'sentence', case when automatic then 'Cello may have clicked Send before the browser closed. Did you send it?'
                           else 'You filled this in, but Cello did not see it sent. Did you send it?' end,
          'idempotency_key', 'lease:' || r.id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
          'payload', jsonb_build_object('phase', 'expired')));
    else
      perform public.pipeline_transition(r.id, array['applying'], 'ready', 'Prepared', null, null,
        jsonb_build_object('kind', 'fill.reported', 'actor', 'schedule', 'channel', 'routine',
          'sentence', 'Nothing was filled, so this is ready again.',
          'idempotency_key', 'lease:' || r.id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
          'payload', jsonb_build_object('phase', 'expired')));
    end if;
  end loop;

  -- (h) once a day: the trim of old step lines.
  if not exists (
    select 1 from public.job_heartbeats h
     where h.job = 'pipeline.prune' and h.user_id is null and h.succeeded_at > now() - interval '23 hours'
  ) then
    n := public.prune_pipeline_events();
    perform public.finish_heartbeat('pipeline.prune', null, true, jsonb_build_object('deleted', n), null, 0, now() + interval '1 day');
  end if;

  return sent;
end;
$$;

revoke all on function public.agent_sweep() from public, anon, authenticated;
grant execute on function public.agent_sweep() to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: what the old drafts say becomes state
-- ---------------------------------------------------------------------------
-- A draft waiting for review or approved is a ready application; a submitted one is a sent one,
-- marked by the person (it was their click). The application row is made when it is missing.
-- Everything else keeps no state.

do $$
begin
  if to_regclass('public.application_drafts') is not null then
    insert into public.applications (user_id, job_id, stage, source)
    select d.user_id, d.job_id, case when d.status = 'submitted' then 'applied' else 'discovered' end, 'draft'
      from public.application_drafts d
     where d.status in ('pending_review', 'approved', 'submitted')
    on conflict (user_id, job_id) do nothing;

    update public.applications a
       set state = case when d.status = 'submitted' then 'sent' else 'ready' end,
           step = case when d.status = 'submitted' then 'Sent' else 'Prepared' end,
           posting_url_hash = coalesce(a.posting_url_hash, public.posting_url_hash(j.url)),
           applied_at = case when d.status = 'submitted' then coalesce(a.applied_at, d.submitted_at, now()) else a.applied_at end,
           last_event_at = clock_timestamp()
      from public.application_drafts d, public.jobs j
     where d.user_id = a.user_id and d.job_id = a.job_id and j.id = a.job_id
       and d.status in ('pending_review', 'approved', 'submitted')
       and a.state is null;

    insert into public.pipeline_events (
      user_id, application_id, job_id, posting_url_hash, kind, actor, channel, sentence, from_state, to_state,
      payload, trust, origin, idempotency_key
    )
    select a.user_id, a.id, a.job_id, a.posting_url_hash, 'submission.marked', 'person', 'session',
           'You sent this application.', 'ready', 'sent', jsonb_build_object('backfill', true), 'person', 'person',
           'backfill:sent:' || a.id
      from public.applications a
      join public.application_drafts d on d.user_id = a.user_id and d.job_id = a.job_id
     where d.status = 'submitted' and a.state = 'sent'
    on conflict (user_id, idempotency_key) do nothing;

    insert into public.pipeline_events (
      user_id, application_id, job_id, posting_url_hash, kind, actor, channel, sentence, from_state, to_state,
      payload, trust, origin, idempotency_key
    )
    select a.user_id, a.id, a.job_id, a.posting_url_hash, 'application.created', 'person', 'session',
           'This was prepared before Cello kept a timeline.', null, 'ready', jsonb_build_object('backfill', true), 'person', 'person',
           'backfill:ready:' || a.id
      from public.applications a
      join public.application_drafts d on d.user_id = a.user_id and d.job_id = a.job_id
     where d.status in ('pending_review', 'approved') and a.state = 'ready'
    on conflict (user_id, idempotency_key) do nothing;
  end if;
end
$$;

do $$
declare
  body text := pg_get_functiondef('public.agent_sweep()'::regprocedure);
begin
  if body not like '%-- (a) the meter%' or body not like '%-- (b) routines that are due%'
     or body not like '%-- (c) stalled agent work%' or body not like '%-- (d) the rendered dispatch%' then
    raise exception 'agent_sweep must keep K4''s four branches';
  end if;
  if body not like '%-- (e) due applications%' or body not like '%-- (f) stale heartbeats%'
     or body not like '%-- (g) fill leases%' or body not like '%-- (h) once a day%' then
    raise exception 'agent_sweep must hold K13''s four branches';
  end if;
  if has_function_privilege('anon', 'public.agent_sweep()', 'execute') or has_function_privilege('authenticated', 'public.agent_sweep()', 'execute') then
    raise exception 'agent_sweep must not be executable by client roles';
  end if;
end
$$;
