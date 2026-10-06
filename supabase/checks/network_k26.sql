-- K26: contact_touch, the follow-up rule, the prune and the grants (migration 20261118000000).
--
-- contact_touch equals hand counts on three threads; a person with no application has a last in touch; the
-- rule refuses 0, 31 and 15 days after their reply and writes only what it names; a row a memory cites
-- survives the 400-day prune and an uncited one does not; deleting a person keeps their messages; one row
-- per address. Rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/network_k26.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as u1, gen_random_uuid() as c1, gen_random_uuid() as c2, gen_random_uuid() as c3;
grant select on fx to public;
insert into auth.users (id, email) select u1, 'net-1@example.invalid' from fx;
insert into public.contacts (id, user_id, name, email) select c1, u1, 'Marcus Reed', 'marcus@petrichor.ai' from fx;
insert into public.contacts (id, user_id, name, email) select c2, u1, 'Dana Lee', 'dana@ramp.com' from fx;
insert into public.contacts (id, user_id, name, email, last_contact_at) select c3, u1, 'Quiet Qin', 'qin@x.com', '2026-01-05' from fx;

-- Marcus: two threads. t1: you wrote, he replied, you wrote (3 messages). t2: he wrote (1).
insert into public.messages (user_id, contact_id, gmail_message_id, thread_id, direction, sent_at)
select u1, c1, v.id, v.th, v.dir, v.at::timestamptz from fx, (values
  ('m1', 't1', 'out', '2026-03-02 10:00+00'),
  ('m2', 't1', 'in',  '2026-03-03 10:00+00'),
  ('m3', 't1', 'out', '2026-03-04 10:00+00'),
  ('m4', 't2', 'in',  '2026-03-10 10:00+00')) v(id, th, dir, at);
-- Dana: you wrote once, no answer
insert into public.messages (user_id, contact_id, gmail_message_id, thread_id, direction, sent_at)
select u1, c2, 'm5', 't3', 'out', '2026-03-05 09:00+00' from fx;

do $$
declare r record;
begin
  select t.* into r from public.contact_touch t, fx where t.contact_id = fx.c1;
  if r.sent_n <> 2 or r.received_n <> 2 or r.threads_n <> 2 then raise exception 'Marcus counts wrong: % % %', r.sent_n, r.received_n, r.threads_n; end if;
  if r.waiting_on <> 'you' or r.last_from <> 'them' or r.last_at <> '2026-03-10 10:00+00' then raise exception 'Marcus should be waiting on you since Mar 10: %', r; end if;
  if r.last_yours_at <> '2026-03-04 10:00+00' or r.last_theirs_at <> '2026-03-10 10:00+00' then raise exception 'Marcus yours/theirs wrong'; end if;

  select t.* into r from public.contact_touch t, fx where t.contact_id = fx.c2;
  if r.waiting_on <> 'them' or r.last_from <> 'you' or r.sent_n <> 1 or r.received_n <> 0 then raise exception 'Dana should be waiting on them'; end if;

  -- no messages and no application: "Mark contacted today" is the whole history
  select t.* into r from public.contact_touch t, fx where t.contact_id = fx.c3;
  if r.last_at <> '2026-01-05' or r.waiting_on <> 'them' or r.sent_n <> 0 then raise exception 'a person with only a recorded touch is wrong: %', r; end if;
end $$;

-- the rule: one atomic write that validates
do $$
declare u uuid; c uuid; p jsonb;
begin
  select u1, c1 into u, c from fx;
  insert into public.profiles (id) values (u) on conflict (id) do nothing;
  begin perform public.set_network_rule(u, null, '{"after_yours_bd": 0}'); raise exception 'accepted 0 days'; exception when raise_exception then if sqlerrm like 'accepted%' then raise; end if; end;
  begin perform public.set_network_rule(u, null, '{"after_yours_bd": 31}'); raise exception 'accepted 31 days'; exception when raise_exception then if sqlerrm like 'accepted%' then raise; end if; end;
  begin perform public.set_network_rule(u, c, '{"after_theirs_d": 15}'); raise exception 'accepted 15 days'; exception when raise_exception then if sqlerrm like 'accepted%' then raise; end if; end;
  begin perform public.set_network_rule(u, null, '{"turbo": 1}'); raise exception 'accepted an unknown key'; exception when raise_exception then if sqlerrm like 'accepted%' then raise; end if; end;

  perform public.set_network_rule(u, null, '{"on": true, "after_yours_bd": 7}');
  perform public.set_network_rule(u, null, '{"after_theirs_d": 3}');
  select preferences -> 'network' -> 'nudge' into p from public.profiles where id = u;
  if p <> '{"on": true, "after_yours_bd": 7, "after_theirs_d": 3}'::jsonb then raise exception 'global rule wrong: %', p; end if;
  perform public.set_network_rule(u, c, '{"off": true}');
  if (select nudge from public.contacts where id = c) <> '{"off": true}'::jsonb then raise exception 'person rule wrong'; end if;
  -- the person's own rule never touched the global one
  select preferences -> 'network' -> 'nudge' into p from public.profiles where id = u;
  if p -> 'after_yours_bd' <> '7'::jsonb then raise exception 'a person rule changed the global rule'; end if;
  perform public.set_network_rule(u, c, 'null');
  if (select nudge from public.contacts where id = c) is not null then raise exception 'null did not return to the default'; end if;
end $$;

-- the prune keeps a row a memory cites
insert into public.messages (user_id, contact_id, gmail_message_id, thread_id, direction, sent_at, cited)
select u1, c1, v.id, 'old', 'in', now() - interval '500 days', v.cited from fx, (values ('old-cited', true), ('old-plain', false)) v(id, cited);
do $$
begin
  perform public.prune_messages();
  if not exists (select 1 from public.messages where gmail_message_id = 'old-cited') then raise exception 'a cited message was pruned'; end if;
  if exists (select 1 from public.messages where gmail_message_id = 'old-plain') then raise exception 'an uncited old message survived'; end if;
  perform public.prune_stale_rows();
  if not exists (select 1 from public.messages where gmail_message_id = 'old-cited') then raise exception 'prune_stale_rows removed a cited message'; end if;
end $$;

-- deleting a person keeps the mail rows
do $$
declare n integer;
begin
  delete from public.contacts where id = (select c1 from fx);
  select count(*) into n from public.messages where gmail_message_id in ('m1', 'm2', 'm3', 'm4') and contact_id is null;
  if n <> 4 then raise exception 'deleting a person lost mail rows: kept %', n; end if;
  -- one row per address, case aside
  begin
    insert into public.contacts (user_id, name, email) select u1, 'Dana again', 'DANA@ramp.com' from fx;
    raise exception 'a second row for one address was accepted';
  exception when unique_violation then null;
  end;
  -- one kept profile a person
  insert into public.contact_profiles (user_id, contact_id, url, host, state) select u1, c2, 'https://linkedin.com/in/a', 'linkedin.com', 'kept' from fx;
  begin
    insert into public.contact_profiles (user_id, contact_id, url, host, state) select u1, c2, 'https://linkedin.com/in/b', 'linkedin.com', 'kept' from fx;
    raise exception 'two kept profiles for one person';
  exception when unique_violation then null;
  end;
end $$;

rollback;
