-- K4: the minute sweeper (migration 20261008040000).
--
-- Proves agent_sweep() posts one signed call for a due routine and nothing when nothing is due;
-- does nothing without the Vault rows; skips a routine poked a minute ago or running a slice;
-- makes one GitHub call for two companies that need a browser; stops at the meter's allowance;
-- and that a new person gets a roles.check routine. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/clock_sweep.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as demo_id,
       gen_random_uuid() as c1, gen_random_uuid() as c2, gen_random_uuid() as c3;
grant select on fx to public;
create temp table res (k text, v bigint);

-- Nothing the migration seeded is due while this check runs.
update public.routines set next_due_at = now() + interval '1 day', poked_at = null, lease_until = null where next_due_at is not null;
delete from net.calls;
delete from vault.decrypted_secrets where name in ('agent_continue_url', 'agent_continue_secret', 'github_dispatch_token');

-- A person's routines come from their profile.
insert into auth.users (id, email) select user_id, 'clock-a@example.invalid' from fx union all select demo_id, 'clock-demo@example.invalid' from fx;
-- (a trigger on auth.users has made both profiles, and a routine for each.) A demo's profile is
-- replaced by one flagged as a demo: it gets none.
delete from public.profiles where id = (select demo_id from fx);
insert into public.profiles (id, email, is_demo) select demo_id, 'clock-demo@example.invalid', true from fx;

do $$
declare f record; r record;
begin
  select * into f from fx;
  select * into r from public.routines where user_id = f.user_id and command = 'roles.check';
  if r.id is null then raise exception 'a new profile gets no roles.check routine'; end if;
  if r.every <> interval '6 hours' then raise exception 'roles.check should run every 6 hours, got %', r.every; end if;
  if r.next_due_at > now() + interval '11 minutes' then raise exception 'the first check should be within ten minutes'; end if;
  if exists (select 1 from public.routines where user_id = f.demo_id) then raise exception 'a demo must get no routines'; end if;
  if (select count(*) from public.routines where user_id is null and command in
      ('inbox.sync', 'owner.health', 'clock.meter', 'clock.prune', 'harness.resume', 'demo.expire', 'harness.digest', 'harness.distill', 'roles.render')) <> 9 then
    raise exception 'an instance routine is missing';
  end if;
  if (select enabled from public.routines where command = 'roles.render' and user_id is null) then
    raise exception 'the rendered dispatch must ship off';
  end if;
end $$;

-- Only the service role may run the clock's functions.
do $$
declare f text;
begin
  foreach f in array array['public.agent_sweep()', 'public.background_ready()', 'public.clock_prune()',
                           'public.start_heartbeat(text, uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be executable by client roles', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '% must be executable by the service role', f;
    end if;
  end loop;
end $$;

-- Due, but the Vault rows are missing: nothing is posted.
update public.routines set next_due_at = now() - interval '1 minute' where command = 'inbox.sync' and user_id is null;
insert into res select 'sent_without_vault', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_without_vault') <> 0 or (select count(*) from net.calls) <> 0 then
    raise exception 'the sweeper posted without the Vault rows';
  end if;
  if public.background_ready() then raise exception 'background_ready must be false without the Vault rows'; end if;
end $$;

select vault.create_secret('https://cello.example.invalid/api/agent/continue', 'agent_continue_url');
select vault.create_secret('a-secret-of-at-least-sixteen-characters', 'agent_continue_secret');

do $$ begin
  if not public.background_ready() then raise exception 'background_ready must be true with both rows and the job scheduled'; end if;
end $$;

-- One due routine: one signed call.
insert into res select 'sent_one', public.agent_sweep();
do $$
declare c record; sig text;
begin
  if (select v from res where k = 'sent_one') <> 1 or (select count(*) from net.calls) <> 1 then
    raise exception 'expected one call for one due routine, got % sent and % recorded', (select v from res where k = 'sent_one'), (select count(*) from net.calls);
  end if;
  select * into c from net.calls;
  if c.url <> 'https://cello.example.invalid/api/agent/continue' then raise exception 'wrong url %', c.url; end if;
  if c.body->>'reason' <> 'routine' then raise exception 'wrong reason %', c.body->>'reason'; end if;
  if c.body->>'routine_id' <> (select id::text from public.routines where command = 'inbox.sync' and user_id is null) then
    raise exception 'the body names the wrong routine';
  end if;
  if (c.body->>'exp')::bigint < extract(epoch from now())::bigint + 290 or (c.body->>'exp')::bigint > extract(epoch from now())::bigint + 310 then
    raise exception 'exp must be five minutes ahead';
  end if;
  sig := encode(extensions.hmac(convert_to(c.body::text, 'utf8'), convert_to('a-secret-of-at-least-sixteen-characters', 'utf8'), 'sha256'), 'hex');
  if c.headers->>'X-Cello-Signature' <> sig then raise exception 'the signature is not the hmac of the body text'; end if;
end $$;

-- The same routine is not posted twice in two minutes.
insert into res select 'sent_again', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_again') <> 0 then raise exception 'a routine poked just now was posted again'; end if;
end $$;

-- Nothing due: nothing posted.
update public.routines set next_due_at = now() + interval '1 day', poked_at = null;
delete from net.calls;
insert into res select 'sent_none', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_none') <> 0 or (select count(*) from net.calls) <> 0 then raise exception 'the sweeper posted with nothing due'; end if;
end $$;

-- A routine poked a minute ago is skipped; one that is running a slice is skipped; a disabled one is skipped.
update public.routines set next_due_at = now() - interval '5 minutes', poked_at = now() - interval '1 minute'
 where command = 'inbox.sync' and user_id is null;
update public.routines set next_due_at = now() - interval '5 minutes', lease_until = now() + interval '4 minutes'
 where command = 'clock.meter' and user_id is null;
update public.routines set next_due_at = now() - interval '5 minutes', enabled = false
 where command = 'clock.prune' and user_id is null;
insert into res select 'sent_skipped', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_skipped') <> 0 then raise exception 'the sweeper posted a poked, leased or disabled routine (%)', (select v from res where k = 'sent_skipped'); end if;
end $$;

-- A slice that died: its lease ran out, so it is posted again.
update public.routines set lease_until = now() - interval '1 minute' where command = 'clock.meter' and user_id is null;
insert into res select 'sent_revived', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_revived') <> 1 then raise exception 'a routine whose lease ran out was not posted (%)', (select v from res where k = 'sent_revived'); end if;
end $$;

-- Two companies that only a browser can read make one GitHub call, and no second while it runs.
update public.routines set next_due_at = now() + interval '1 day', poked_at = null, lease_until = null, enabled = true;
update public.routines set enabled = false where command = 'roles.render' and user_id is null;
insert into public.companies (id, user_id, name, career_url, metadata, last_scraped_at)
select c1, user_id, 'Render One', 'https://one.example.invalid/jobs', '{"source_check": {"readable": false, "reason": "reading", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb, null from fx
union all select c2, user_id, 'Render Two', 'https://two.example.invalid/jobs', '{"source_check": {"readable": false, "reason": "reading", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb, now() - interval '7 hours' from fx
union all select c3, user_id, 'Read Lately', 'https://three.example.invalid/jobs', '{"source_check": {"readable": false, "reason": "reading", "checked_at": "2026-10-08T00:00:00Z"}}'::jsonb, now() - interval '1 hour' from fx;
delete from net.calls;

-- Off: no call, whatever is waiting.
insert into res select 'sent_render_off', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_render_off') <> 0 then raise exception 'the dispatch ran while roles.render is off'; end if;
end $$;

update public.routines set enabled = true where command = 'roles.render' and user_id is null;
-- On, but no token: no call.
insert into res select 'sent_no_token', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_no_token') <> 0 then raise exception 'the dispatch ran without a token'; end if;
end $$;

select vault.create_secret('ghp_notarealtoken', 'github_dispatch_token');
insert into res select 'sent_render', public.agent_sweep();
do $$
declare c record; ids text[];
begin
  if (select v from res where k = 'sent_render') <> 1 or (select count(*) from net.calls) <> 1 then
    raise exception 'expected one GitHub call for two render companies, got %', (select count(*) from net.calls);
  end if;
  select * into c from net.calls;
  if c.url <> 'https://api.github.com/repos/Devil-Hawk/cello/actions/workflows/scrape.yml/dispatches' then raise exception 'wrong dispatch url %', c.url; end if;
  ids := string_to_array(c.body->'inputs'->>'company_ids', ',');
  if cardinality(ids) <> 2 or not (select c1::text = any(ids) and c2::text = any(ids) and not c3::text = any(ids) from fx) then
    raise exception 'the dispatch must carry the two companies not read in six hours, got %', c.body->'inputs'->>'company_ids';
  end if;
  if c.headers->>'Authorization' <> 'Bearer ghp_notarealtoken' then raise exception 'the dispatch must use the vault token'; end if;
end $$;

insert into res select 'sent_render_twice', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_render_twice') <> 0 or (select count(*) from net.calls) <> 1 then
    raise exception 'a second dispatch went out while the first run had not finished';
  end if;
end $$;

-- The meter: at the allowance nothing new starts.
update public.routines set next_due_at = now() - interval '1 minute' where command = 'inbox.sync' and user_id is null;
insert into public.clock_meter (month, duration_ms) values (date_trunc('month', now())::date, public.clock_allowance_ms())
  on conflict (month) do update set duration_ms = excluded.duration_ms;
delete from net.calls;
insert into res select 'sent_paused', public.agent_sweep();
do $$ begin
  if (select v from res where k = 'sent_paused') <> 0 or (select count(*) from net.calls) <> 0 then raise exception 'the sweeper started work at the meter allowance'; end if;
end $$;

-- prune-stale-rows no longer has its own job.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'prune-stale-rows') then raise exception 'prune-stale-rows is still scheduled'; end if;
  if (public.clock_prune() ->> 'jobs') is null then raise exception 'clock_prune must report what prune_stale_rows removed'; end if;
end $$;

rollback;
