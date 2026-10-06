-- K20: notification_log and push_subscriptions (migration 20261020000000) and the dropped view.
--
-- The same thing is never recorded twice for one person; another person may hold the same key; the
-- session reads its own rows and writes none; a push key cannot be read back; the old name for what was
-- sent is gone and the attempts table stays. Rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/pipeline_delivery.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as u1, gen_random_uuid() as u2;
grant select on fx to public;
insert into auth.users (id, email) select u1, 'dl-1@example.invalid' from fx union all select u2, 'dl-2@example.invalid' from fx;

-- every person has a daily summary routine at 08:00, not due before the next 08:00
do $$
declare r record;
begin
  select * into r from public.routines where user_id = (select u1 from fx) and command = 'summary.send';
  if not found then raise exception 'a new person has no summary.send routine'; end if;
  if r.local_time <> time '08:00' or r.every is not null or r.timezone <> 'UTC' or r.next_due_at <= now() or r.next_due_at > now() + interval '25 hours' then
    raise exception 'summary.send should be daily at 08:00 UTC, next due within a day: %', r;
  end if;
  if (r.next_due_at at time zone 'UTC')::time <> time '08:00' then raise exception 'summary.send is not due at 08:00: %', r.next_due_at; end if;
end
$$;

insert into public.notification_log (user_id, kind, subject_id) select u1, 'summary', '2026-10-06' from fx;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) select u1, 'https://push.example/abc', 'k', 'a' from fx;

do $$
begin
  begin
    insert into public.notification_log (user_id, kind, subject_id) select u1, 'summary', '2026-10-06' from fx;
    raise exception 'the same delivery was recorded twice';
  exception when unique_violation then null;
  end;
  insert into public.notification_log (user_id, kind, subject_id) select u2, 'summary', '2026-10-06' from fx;
  insert into public.notification_log (user_id, kind, subject_id) select u1, 'summary', '2026-10-07' from fx;
  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) select u2, 'https://push.example/abc', 'k', 'a' from fx;
    raise exception 'one endpoint was stored for two people';
  exception when unique_violation then null;
  end;
end
$$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select u1 from fx), 'role', 'authenticated')::text, true);
do $$
declare n integer;
begin
  select count(*) into n from public.notification_log;
  if n <> 2 then raise exception 'the person should see their 2 deliveries, saw %', n; end if;
  select count(*) into n from public.push_subscriptions;
  if n <> 1 then raise exception 'the person should see their 1 subscription, saw %', n; end if;
  begin
    perform auth from public.push_subscriptions;
    raise exception 'the push key was readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notification_log (user_id, kind, subject_id) values (auth.uid(), 'x', 'y');
    raise exception 'a session insert was accepted';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- the post-deploy drop: the old name goes, the table stays
do $$
begin
  if to_regclass('public.application_receipts') is not null then
    raise exception 'the old name is still there after the migrations ran';
  end if;
  if to_regclass('public.application_attempts') is null then
    raise exception 'the attempts table is missing';
  end if;
end
$$;

rollback;
