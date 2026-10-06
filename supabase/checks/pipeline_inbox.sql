-- K19: messages, contacts' kind and T6 (migration 20261019000000).
--
-- One row per Gmail message and person; a subject or excerpt over its limit is refused; trust is one of
-- four words; the session reads its own rows and writes none; a contact kind outside the list is refused;
-- T6 counts people with a heartbeat. Rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/pipeline_inbox.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as u1, gen_random_uuid() as u2;
grant select on fx to public;
insert into auth.users (id, email) select u1, 'in-1@example.invalid' from fx union all select u2, 'in-2@example.invalid' from fx;

insert into public.messages (user_id, gmail_message_id, sent_at, from_domain, subject, kind, trust)
select u1, 'g-1', now(), 'acme.com', 'Your application', 'applied', 'proven' from fx;

do $$
declare n integer;
begin
  begin
    insert into public.messages (user_id, gmail_message_id, sent_at) select u1, 'g-1', now() from fx;
    raise exception 'the same Gmail message was stored twice for one person';
  exception when unique_violation then null;
  end;
  -- another person may hold a message with the same Gmail id
  insert into public.messages (user_id, gmail_message_id, sent_at) select u2, 'g-1', now() from fx;
  begin
    insert into public.messages (user_id, gmail_message_id, sent_at, subject) select u1, 'g-2', now(), repeat('x', 201) from fx;
    raise exception 'a subject over 200 characters was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.messages (user_id, gmail_message_id, sent_at, excerpt) select u1, 'g-3', now(), repeat('x', 601) from fx;
    raise exception 'an excerpt over 600 characters was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.messages (user_id, gmail_message_id, sent_at, trust) select u1, 'g-4', now(), 'trusted' from fx;
    raise exception 'an unknown trust level was accepted';
  exception when check_violation then null;
  end;
  -- an application may be deleted without deleting what was said about it
  begin
    insert into public.contacts (user_id, name, kind) select u1, 'Someone', 'boss' from fx;
    raise exception 'a contact kind outside the list was accepted';
  exception when check_violation then null;
  end;
  insert into public.contacts (user_id, name, kind, agency_name, employer_origin) select u1, 'Rae Recruiter', 'agency_recruiter', 'Talent Partners', 'code' from fx;
  select count(*) into n from public.contacts where kind = 'agency_recruiter';
  if n <> 1 then raise exception 'the contact kind was not stored'; end if;
end
$$;

-- T6: nobody read yet, then one person read an hour ago and one never
do $$
declare r record;
begin
  delete from public.job_heartbeats where job = 'inbox.sync';
  select * into r from public.measure_t6();
  if r.sample_n <> 0 or r.value is not null then raise exception 'T6 with no heartbeats should have no value'; end if;
  insert into public.job_heartbeats (job, user_id, started_at, succeeded_at) select 'inbox.sync', u1, now() - interval '65 minutes', now() - interval '60 minutes' from fx;
  insert into public.job_heartbeats (job, user_id, started_at) select 'inbox.sync', u2, now() - interval '5 hours' from fx;
  select * into r from public.measure_t6();
  if r.sample_n <> 2 or r.passed or r.value < 4.9 then raise exception 'T6 should be the 5 hour wait of the person who never read, got %', r.value; end if;
end
$$;

-- the session reads its own messages and writes none
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select u1 from fx), 'role', 'authenticated')::text, true);
do $$
declare n integer;
begin
  select count(*) into n from public.messages;
  if n <> 1 then raise exception 'the person should see 1 message, saw %', n; end if;
  begin
    insert into public.messages (user_id, gmail_message_id, sent_at) values (auth.uid(), 'g-9', now());
    raise exception 'a session insert was accepted';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

rollback;
