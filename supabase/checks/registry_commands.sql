-- Proves migrations 20261010000000 (command_slots, take_command_slot) and
-- 20261010000001 (set_autonomy and the preferences.pipeline guard).
--
-- Both are applied by run.sh before this file runs. They are applied again here,
-- inside the transaction, so a second run is shown to change nothing. Everything
-- rolls back.
--
--   nice -n 19 ionice -c3 bash supabase/checks/run.sh supabase/checks/registry_commands.sql

begin;

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'cmd-user@example.invalid'),
  ('cccccccc-0000-0000-0000-000000000002', 'cmd-demo@example.invalid');
insert into public.profiles (id, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'cmd-user@example.invalid'),
  ('cccccccc-0000-0000-0000-000000000002', 'cmd-demo@example.invalid')
on conflict (id) do nothing;
update public.profiles
set is_demo = true, demo_expires_at = now() + interval '72 hours'
where id = 'cccccccc-0000-0000-0000-000000000002';

\ir ../migrations/20261010000000_command_slots.sql
\ir ../migrations/20261010000001_set_autonomy.sql

-- ===========================================================================
-- take_command_slot
-- ===========================================================================
do $$
declare a boolean; b boolean; c boolean; d boolean; n integer;
begin
  a := public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  b := public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  c := public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  d := public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  assert a and b and c, 'a limit of 3 must allow the first three calls';
  assert not d, 'a limit of 3 must refuse the fourth call in the same window';

  -- Another door and another person have their own count.
  assert public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'agent', 'heavy', 3, 600),
    'the agent door has its own count';
  assert public.take_command_slot('cccccccc-0000-0000-0000-000000000002', 'chat', 'heavy', 3, 600),
    'another person has their own count';

  -- Rows older than two days are removed on the next call for that person.
  insert into public.command_slots (user_id, channel, bucket, window_start, n)
  values ('cccccccc-0000-0000-0000-000000000001', 'chat', 'old', now() - interval '3 days', 9);
  perform public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  select count(*) into n from public.command_slots
  where user_id = 'cccccccc-0000-0000-0000-000000000001' and bucket = 'old';
  assert n = 0, 'a row older than two days must be removed';
end $$;

-- Only the service role may run it.
set local role authenticated;
do $$
begin
  perform public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'chat', 'heavy', 3, 600);
  raise exception 'authenticated must not run take_command_slot';
exception when insufficient_privilege then
  null;
end $$;
reset role;

set local role service_role;
do $$
begin
  assert public.take_command_slot('cccccccc-0000-0000-0000-000000000001', 'session', 'search', 12, 60),
    'service_role runs take_command_slot';
end $$;
reset role;

-- ===========================================================================
-- preferences.pipeline
-- ===========================================================================
-- The service role cannot write the key.
set local role service_role;
do $$
begin
  update public.profiles
  set preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{pipeline}', '{"sendForMe": true}'::jsonb)
  where id = 'cccccccc-0000-0000-0000-000000000001';
  raise exception 'a service-role write of preferences.pipeline must raise';
exception when insufficient_privilege then
  null;
end $$;

-- ...and cannot call the function that can.
do $$
begin
  perform public.set_autonomy('{"sendForMe": true}'::jsonb);
  raise exception 'service_role must not run set_autonomy';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- A signed-in person: the function works, the raw column write does not.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare out jsonb; kept jsonb;
begin
  out := public.set_autonomy('{"sendForMe": true, "dailySends": 5}'::jsonb);
  assert (out ->> 'dailySends') = '5', 'set_autonomy returns what it stored';

  begin
    update public.profiles
    set preferences = jsonb_set(preferences, '{pipeline,dailySends}', '500')
    where id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception 'a raw write of preferences.pipeline must raise';
  exception when insufficient_privilege then
    null;
  end;

  -- A merge write that leaves pipeline as it was is fine: settings routes rewrite
  -- the whole column.
  update public.profiles
  set preferences = preferences || '{"matchThreshold": 70}'::jsonb
  where id = 'cccccccc-0000-0000-0000-000000000001';
  select preferences -> 'pipeline' into kept from public.profiles
  where id = 'cccccccc-0000-0000-0000-000000000001';
  assert (kept ->> 'dailySends') = '5', 'a merge write keeps pipeline';
end $$;

-- A demo cannot use it.
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  perform public.set_autonomy('{"sendForMe": true}'::jsonb);
  raise exception 'a demo must not run set_autonomy';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- ===========================================================================
-- approvals: send_email only, decided by a person only (the post-deploy file)
-- ===========================================================================
-- The approvals table comes with the engine. Until it is on this branch the check
-- builds a bare one so the constraints are still proven; once the real table is
-- there it only asserts that both constraints exist on it.
do $$
begin
  if to_regclass('public.approvals') is null then
    create table public.approvals (id uuid primary key default gen_random_uuid(), action text not null, decided_by text);
    perform set_config('cello.check_made_approvals', 'on', true);
  end if;
end $$;

\ir ../migrations/20261010000002_approvals_send_only.sql
\ir ../migrations/20261010000002_approvals_send_only.sql

do $$
begin
  assert exists (select 1 from pg_constraint where conname = 'approvals_r2_send_only' and conrelid = 'public.approvals'::regclass),
    'approvals_r2_send_only is missing';
  assert exists (select 1 from pg_constraint where conname = 'approvals_decided_by_person' and conrelid = 'public.approvals'::regclass),
    'approvals_decided_by_person is missing';

  if coalesce(current_setting('cello.check_made_approvals', true), '') = 'on' then
    begin
      insert into public.approvals (action) values ('submit_application');
      raise exception 'an approval for submit_application must be refused';
    exception when check_violation then
      null;
    end;
    begin
      insert into public.approvals (action, decided_by) values ('send_email', 'rule');
      raise exception 'an approval decided by a rule must be refused';
    exception when check_violation then
      null;
    end;
    insert into public.approvals (action, decided_by) values ('send_email', 'user');
    insert into public.approvals (action) values ('send_email');
  end if;
end $$;

rollback;
