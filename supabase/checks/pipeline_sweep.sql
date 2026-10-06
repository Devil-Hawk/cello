-- K13: the second agent_sweep() (migration 20261013000004).
--
-- Proves K4's four branches are still in the body and K13's four are added; due applications are posted
-- with reason advance, at most 10 a minute and 2 for one person, skipping a live lease, a poke from the
-- last minute and a paused person; a step that died goes back to due and, after three tries, to Not
-- sent; a fill lease that ran out lands where the person can see it (Did you send it?, Your turn on the
-- site, Ready again); and the trim runs once a day. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/pipeline_sweep.sql

\set ON_ERROR_STOP 1
begin;

alter table public.applications drop constraint if exists applications_resume_artifact_fkey;

create temp table fx as
select gen_random_uuid() as u1, gen_random_uuid() as u2, gen_random_uuid() as u3, gen_random_uuid() as u4, gen_random_uuid() as u5,
       gen_random_uuid() as co1, gen_random_uuid() as co2, gen_random_uuid() as co3, gen_random_uuid() as co4, gen_random_uuid() as co5;
grant select on fx to public;

insert into auth.users (id, email)
select u1, 'sw-1@example.invalid' from fx union all select u2, 'sw-2@example.invalid' from fx
union all select u3, 'sw-3@example.invalid' from fx union all select u4, 'sw-4@example.invalid' from fx
union all select u5, 'sw-5@example.invalid' from fx;

insert into public.companies (id, user_id, name, career_url)
select co1, u1, 'Sweep One', 'https://sweep1.example' from fx union all select co2, u2, 'Sweep Two', 'https://sweep2.example' from fx
union all select co3, u3, 'Sweep Three', 'https://sweep3.example' from fx union all select co4, u4, 'Sweep Four', 'https://sweep4.example' from fx
union all select co5, u5, 'Sweep Five', 'https://sweep5.example' from fx;

-- Nothing the migrations seeded is due while this check runs.
update public.routines set next_due_at = now() + interval '1 day', poked_at = null, lease_until = null where next_due_at is not null;
delete from net.calls;
delete from vault.decrypted_secrets where name in ('agent_continue_url', 'agent_continue_secret', 'github_dispatch_token');
select vault.create_secret('https://cello.example.invalid/api/agent/continue', 'agent_continue_url');
select vault.create_secret('a-secret-of-at-least-sixteen-characters', 'agent_continue_secret');

create function pg_temp.mkapp(uid uuid, co uuid, n text) returns uuid language plpgsql as $$
declare j uuid := gen_random_uuid(); a uuid;
begin
  insert into public.jobs (id, company_id, title, description, url, external_id)
  values (j, co, 'Engineer ' || n, 'd', 'https://sweep.example/jobs/' || n, 'sw-' || n);
  insert into public.applications (user_id, job_id) values (uid, j) returning id into a;
  return a;
end $$;

create function pg_temp.ev(k text, a text, key text, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('kind', k, 'actor', a, 'sentence', 'A line for the person.', 'idempotency_key', key) || extra
$$;

-- ---------------------------------------------------------------------------
-- 1. The body
-- ---------------------------------------------------------------------------

do $$
declare body text := pg_get_functiondef('public.agent_sweep()'::regprocedure);
begin
  if body not like '%-- (a) the meter%' or body not like '%-- (b) routines that are due%'
     or body not like '%-- (c) stalled agent work%' or body not like '%-- (d) the rendered dispatch%' then
    raise exception 'K4''s four branches must stay';
  end if;
  if body not like '%-- (e) due applications%' or body not like '%-- (f) stale heartbeats%'
     or body not like '%-- (g) fill leases%' or body not like '%-- (h) once a day%' then
    raise exception 'K13''s four branches must be there';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Due applications: reason advance, 10 a minute, 2 a person, skipping what must be skipped
-- ---------------------------------------------------------------------------

-- Five people with six due applications each: thirty due, ten posted, two for each.
do $$
declare f record; uid uuid; co uuid; i int; a uuid; users uuid[]; cos uuid[];
begin
  select * into f from fx;
  users := array[f.u1, f.u2, f.u3, f.u4, f.u5];
  cos := array[f.co1, f.co2, f.co3, f.co4, f.co5];
  for k in 1..5 loop
    for i in 1..6 loop
      a := pg_temp.mkapp(users[k], cos[k], k || '-' || i);
      perform public.pipeline_transition(a, array['none'], 'preparing', 'Queued', null, null,
        pg_temp.ev('application.created', 'person', 'sw:' || a, jsonb_build_object('next_at', now() - (i || ' minutes')::interval)));
      -- the transition stamps the beat; a row that has not been poked has not beaten for a while
      update public.applications set heartbeat_at = null where id = a;
    end loop;
  end loop;
end $$;

select public.agent_sweep() as sent \gset
do $$
declare n_calls int; per_user int;
begin
  select count(*) into n_calls from net.calls;
  if n_calls <> 10 then raise exception 'ten a minute: expected 10 calls, got %', n_calls; end if;
  if (select count(*) from net.calls where body ->> 'reason' = 'advance') <> 10 then raise exception 'every call carries the reason advance'; end if;
  select max(c) into per_user from (
    select count(*) as c from net.calls n join public.applications a on a.id = (n.body ->> 'application_id')::uuid group by a.user_id
  ) s;
  if per_user <> 2 then raise exception 'two a person: the busiest got %', per_user; end if;
  if (select count(distinct a.user_id) from net.calls n join public.applications a on a.id = (n.body ->> 'application_id')::uuid) <> 5 then
    raise exception 'every person gets a turn';
  end if;
  -- the longest waiting go first for each person
  if exists (
    select 1 from net.calls n join public.applications a on a.id = (n.body ->> 'application_id')::uuid
     where a.next_at > now() - interval '4 minutes'
  ) then raise exception 'the longest waiting go first'; end if;
  if (select count(*) from public.applications where heartbeat_at is not null) <> 10 then raise exception 'a poke counts as a beat'; end if;
  if exists (select 1 from net.calls where headers ->> 'X-Cello-Signature' is null) then raise exception 'every call is signed'; end if;
end $$;

-- Posted rows are not posted again within the minute; the others are.
delete from net.calls;
select public.agent_sweep() as sent \gset
do $$
begin
  if (select count(*) from net.calls) <> 10 then raise exception 'the next minute posts ten more, got %', (select count(*) from net.calls); end if;
  if (select count(distinct n.body ->> 'application_id') from net.calls n) <> 10 then raise exception 'no row twice'; end if;
end $$;

-- A live lease, a poke a moment ago, a paused person, a row not due, and a row waiting on the person are skipped.
update public.applications set state = null, next_at = null, heartbeat_at = null, lease_until = null;
do $$
declare f record; a_lease uuid; a_poke uuid; a_paused uuid; a_future uuid; a_needs uuid; a_ok uuid;
begin
  select * into f from fx;
  a_lease := pg_temp.mkapp(f.u1, f.co1, 'lease'); a_poke := pg_temp.mkapp(f.u1, f.co1, 'poke');
  a_paused := pg_temp.mkapp(f.u2, f.co2, 'paused'); a_future := pg_temp.mkapp(f.u3, f.co3, 'future');
  a_needs := pg_temp.mkapp(f.u3, f.co3, 'needs'); a_ok := pg_temp.mkapp(f.u4, f.co4, 'ok');
  update public.applications set state = 'preparing', next_at = now() - interval '5 minutes', lease_until = now() + interval '3 minutes', heartbeat_at = now() - interval '5 minutes' where id = a_lease;
  update public.applications set state = 'preparing', next_at = now() - interval '5 minutes', heartbeat_at = now() where id = a_poke;
  update public.applications set state = 'preparing', next_at = now() - interval '5 minutes' where id = a_paused;
  update public.applications set state = 'scheduled', next_at = now() + interval '1 hour' where id = a_future;
  update public.applications set state = 'needs_you', needs_reason = 'answer', next_at = now() - interval '5 minutes' where id = a_needs;
  update public.applications set state = 'scheduled', next_at = now() - interval '5 minutes' where id = a_ok;
  perform public.pipeline_pause(f.u2);
  delete from net.calls;
  perform public.agent_sweep();
  if (select count(*) from net.calls) <> 1 or (select body ->> 'application_id' from net.calls) <> a_ok::text then
    raise exception 'only the one due row that may run is posted, got %', (select jsonb_agg(body) from net.calls);
  end if;
  perform public.pipeline_resume(f.u2);
end $$;

-- ---------------------------------------------------------------------------
-- 3. A step that died
-- ---------------------------------------------------------------------------

do $$
declare f record; a1 uuid; a2 uuid; a3 uuid;
begin
  select * into f from fx;
  update public.applications set state = null, next_at = null, heartbeat_at = null, lease_until = null;
  a1 := pg_temp.mkapp(f.u1, f.co1, 'stale1'); a2 := pg_temp.mkapp(f.u1, f.co1, 'stale2'); a3 := pg_temp.mkapp(f.u1, f.co1, 'live');
  -- died: the lease ran out and nothing has beaten for 4 minutes
  update public.applications set state = 'preparing', attempt = 0, next_at = now() + interval '1 hour', lease_until = now() - interval '1 minute', heartbeat_at = now() - interval '4 minutes' where id = a1;
  -- died a third time
  update public.applications set state = 'preparing', attempt = 2, next_at = now() + interval '1 hour', lease_until = now() - interval '1 minute', heartbeat_at = now() - interval '4 minutes' where id = a2;
  -- alive: a beat at 200 seconds with the lease still held
  update public.applications set state = 'preparing', attempt = 0, next_at = now() + interval '1 hour', lease_until = now() + interval '1 minute', heartbeat_at = now() - interval '200 seconds' where id = a3;
  delete from net.calls;
  perform public.agent_sweep();
  if (select state from public.applications where id = a1) <> 'preparing' or (select attempt from public.applications where id = a1) <> 1 then raise exception 'a step that died is tried again once more'; end if;
  if (select next_at from public.applications where id = a1) > now() + interval '1 minute' then raise exception 'and is due at once'; end if;
  if (select state from public.applications where id = a2) <> 'not_sent' then raise exception 'after three tries it is not sent'; end if;
  if (select state from public.applications where id = a3) <> 'preparing' or (select attempt from public.applications where id = a3) <> 0 then raise exception 'a live heartbeat is not reclaimed'; end if;
  if not exists (select 1 from public.pipeline_events where application_id = a1 and kind = 'step.failed') then raise exception 'the retry is an event'; end if;
  -- the same sweep a minute later does not reclaim it twice
  perform public.agent_sweep();
  if (select attempt from public.applications where id = a1) <> 1 then raise exception 'a step is reclaimed once'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Fill leases that ran out
-- ---------------------------------------------------------------------------

do $$
declare f record; manual_filled uuid; manual_empty uuid; auto_early uuid; auto_late uuid; live uuid;
begin
  select * into f from fx;
  update public.applications set state = null, next_at = null, heartbeat_at = null, lease_until = null;
  manual_filled := pg_temp.mkapp(f.u1, f.co1, 'lease-filled'); manual_empty := pg_temp.mkapp(f.u1, f.co1, 'lease-empty');
  auto_early := pg_temp.mkapp(f.u1, f.co1, 'lease-auto-early'); auto_late := pg_temp.mkapp(f.u1, f.co1, 'lease-auto-late');
  live := pg_temp.mkapp(f.u1, f.co1, 'lease-live');
  update public.applications set state = 'applying', lease_until = now() - interval '1 minute' where id in (manual_filled, manual_empty, auto_early, auto_late);
  update public.applications set state = 'applying', lease_until = now() + interval '10 minutes' where id = live;

  perform public.pipeline_note(f.u1, manual_filled, pg_temp.ev('fill.started', 'extension', 'ls:mf:s', '{"payload": {"auto": false}}'));
  perform public.pipeline_note(f.u1, manual_filled, pg_temp.ev('fill.reported', 'extension', 'ls:mf:r', '{"payload": {"phase": "filled"}}'));
  perform public.pipeline_note(f.u1, manual_empty, pg_temp.ev('fill.started', 'extension', 'ls:me:s', '{"payload": {"auto": false}}'));
  perform public.pipeline_note(f.u1, auto_early, pg_temp.ev('fill.started', 'extension', 'ls:ae:s', '{"payload": {"auto": true}}'));
  perform public.pipeline_note(f.u1, auto_late, pg_temp.ev('fill.started', 'extension', 'ls:al:s', '{"payload": {"auto": true}}'));
  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, idempotency_key)
  values (f.u1, auto_late, 'submission.sending', 'extension', 'x', 'ls:al:sending');

  delete from net.calls;
  perform public.agent_sweep();

  if (select state || ':' || needs_reason from public.applications where id = manual_filled) <> 'needs_you:check_sent' then raise exception 'a manual fill that filled something asks Did you send it?'; end if;
  if (select state from public.applications where id = manual_empty) <> 'ready' then raise exception 'a manual fill that filled nothing is ready again'; end if;
  if (select state || ':' || needs_reason || ':' || (needs_detail ->> 'cause') from public.applications where id = auto_early) <> 'needs_you:your_turn:interrupted' then
    raise exception 'an automatic claim that ended before the click is Your turn on the site (interrupted)';
  end if;
  if (select state || ':' || needs_reason from public.applications where id = auto_late) <> 'needs_you:check_sent' then raise exception 'an automatic claim that ended after submission.sending asks Did you send it?'; end if;
  if (select state from public.applications where id = live) <> 'applying' then raise exception 'a live lease is left alone'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The daily trim runs once
-- ---------------------------------------------------------------------------

do $$
begin
  if (select succeeded_at from public.job_heartbeats where job = 'pipeline.prune' and user_id is null) is null then raise exception 'the trim records its heartbeat'; end if;
  update public.job_heartbeats set succeeded_at = now() - interval '1 hour', found = '{"deleted": -1}' where job = 'pipeline.prune' and user_id is null;
  perform public.agent_sweep();
  if (select found ->> 'deleted' from public.job_heartbeats where job = 'pipeline.prune' and user_id is null) <> '-1' then raise exception 'the trim runs once a day, not every minute'; end if;
  update public.job_heartbeats set succeeded_at = now() - interval '25 hours' where job = 'pipeline.prune' and user_id is null;
  perform public.agent_sweep();
  if (select found ->> 'deleted' from public.job_heartbeats where job = 'pipeline.prune' and user_id is null) = '-1' then raise exception 'the trim runs again after a day'; end if;
end $$;

rollback;
