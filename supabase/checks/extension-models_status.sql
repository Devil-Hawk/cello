-- Proves migration 20261123500000 (extension_status): the popup's numbers come from one
-- SQL read. Applies the migration again inside the transaction, then checks Send for me
-- on and off, Pause, the cap's default and its 1 to 10 bounds, and (where the pipeline
-- events table exists) that tries and sent are counted for today and for this person only.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/extension-models_status.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-6666-0000-0000-000000000001', 'status-a@example.invalid'),
  ('aaaaaaaa-6666-0000-0000-000000000002', 'status-b@example.invalid');
insert into public.profiles (id, email) values
  ('aaaaaaaa-6666-0000-0000-000000000001', 'status-a@example.invalid'),
  ('aaaaaaaa-6666-0000-0000-000000000002', 'status-b@example.invalid')
on conflict (id) do nothing;

\ir ../migrations/20261123500000_extension_status.sql

do $$
declare
  a constant uuid := 'aaaaaaaa-6666-0000-0000-000000000001';
  r jsonb;
begin
  -- A person who has set nothing: off, not paused, nothing counted, the default cap.
  r := public.extension_status(a);
  assert r = '{"send_for_me": false, "paused": false, "sent_today": 0, "tries_today": 0, "cap": 3}'::jsonb, 'defaults were ' || r::text;

  -- Send for me on, with a cap of 5.
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('mode', 'auto', 'maxPerDay', 5))) where id = a;
  r := public.extension_status(a);
  assert (r ->> 'send_for_me')::boolean and (r ->> 'cap')::int = 5, 'send on, cap 5 was ' || r::text;

  -- Mode me is off; Pause shows.
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('mode', 'me'), 'paused_at', now())) where id = a;
  r := public.extension_status(a);
  assert not (r ->> 'send_for_me')::boolean and (r ->> 'paused')::boolean, 'mode me and paused was ' || r::text;

  -- The cap is held between 1 and 10, and nonsense falls back to 3.
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('maxPerDay', 50))) where id = a;
  assert (public.extension_status(a) ->> 'cap')::int = 10, 'a cap of 50 must read 10';
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('maxPerDay', 0))) where id = a;
  assert (public.extension_status(a) ->> 'cap')::int = 1, 'a cap of 0 must read 1';
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('maxPerDay', 'lots'))) where id = a;
  assert (public.extension_status(a) ->> 'cap')::int = 3, 'a cap of lots must read 3';

  -- A zone that does not exist falls back to UTC instead of failing.
  update public.profiles set preferences = jsonb_build_object('timezone', 'Not/AZone') where id = a;
  assert (public.extension_status(a) ->> 'tries_today')::int = 0, 'a bad zone broke the read';
end $$;

-- A client cannot call it: only the server does.
do $$
begin
  assert not has_function_privilege('authenticated', 'public.extension_status(uuid)', 'execute'), 'authenticated can read another person''s numbers';
  assert not has_function_privilege('anon', 'public.extension_status(uuid)', 'execute'), 'anon can read numbers';
  assert has_function_privilege('service_role', 'public.extension_status(uuid)', 'execute'), 'the server cannot read numbers';
end $$;

-- Counts, where the pipeline events table is the minimal one this check makes. When the
-- real table exists its own checks cover its columns, and this part says so and stops.
do $$
declare
  a constant uuid := 'aaaaaaaa-6666-0000-0000-000000000001';
  b constant uuid := 'aaaaaaaa-6666-0000-0000-000000000002';
  r jsonb;
begin
  if to_regclass('public.pipeline_events') is not null then
    raise notice 'public.pipeline_events exists: the count assertions were skipped, not run';
    return;
  end if;
  create table public.pipeline_events (user_id uuid, kind text, actor text, created_at timestamptz default now());
  insert into public.pipeline_events (user_id, kind, actor, created_at) values
    (a, 'fill.auto_started', 'extension', now()),
    (a, 'fill.auto_started', 'extension', now()),
    (a, 'submission.sent', 'extension', now()),
    (a, 'submission.sent', 'person', now()),
    (a, 'fill.auto_started', 'extension', now() - interval '3 days'),
    (b, 'fill.auto_started', 'extension', now());
  update public.profiles set preferences = jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('mode', 'auto', 'maxPerDay', 3))) where id = a;
  r := public.extension_status(a);
  assert (r ->> 'tries_today')::int = 2, 'tries today was ' || (r ->> 'tries_today');
  assert (r ->> 'sent_today')::int = 1, 'sent today counted a send the person made themselves, or none: ' || (r ->> 'sent_today');
  assert (public.extension_status(b) ->> 'tries_today')::int = 1, 'another person''s tries leaked';
end $$;

rollback;
