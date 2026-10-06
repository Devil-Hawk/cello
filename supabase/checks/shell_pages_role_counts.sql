-- Proves migration 20261024250000: role_counts('employer') equals a hand count of
-- the person's visible, open roles for each of three employers over 26 roles, never
-- counts another person's rows, a hidden role or a stale one; role_counts('outside_week')
-- sums seven days of person_counts and not the eighth; role_counts('role_type') counts by the person's
-- own type over the posting's; anon cannot run it; an unknown
-- grouping is refused; and the two new reasons are accepted by role_reactions.
-- One transaction, rolled back.
--
--   bash supabase/checks/run.sh supabase/checks/shell_pages_role_counts.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b,
       gen_random_uuid() as e1, gen_random_uuid() as e2, gen_random_uuid() as e3,
       gen_random_uuid() as ca1, gen_random_uuid() as ca2, gen_random_uuid() as ca3, gen_random_uuid() as cb1;
grant select on fx to public;

insert into auth.users (id, email)
select a, 'counts-a@example.invalid' from fx
union all select b, 'counts-b@example.invalid' from fx;
insert into public.profiles (id, email) select a, 'counts-a@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select b, 'counts-b@example.invalid' from fx on conflict (id) do nothing;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select e1, 'Counts One', 'counts one', 'counts-one.example', 'greenhouse', 'countsone', 'careers_link', now(), 'person' from fx
union all select e2, 'Counts Two', 'counts two', 'counts-two.example', 'greenhouse', 'countstwo', 'careers_link', now(), 'person' from fx
union all select e3, 'Counts Three', 'counts three', 'counts-three.example', 'greenhouse', 'countsthree', 'careers_link', now(), 'person' from fx;

insert into public.companies (id, user_id, name, domain, career_url, metadata)
select ca1, a, 'Counts One', 'counts-one.example', 'https://counts-one.example/careers', '{}'::jsonb from fx
union all select ca2, a, 'Counts Two', 'counts-two.example', 'https://counts-two.example/careers', '{}'::jsonb from fx
union all select ca3, a, 'Counts Three', 'counts-three.example', 'https://counts-three.example/careers', '{}'::jsonb from fx
union all select cb1, b, 'Counts One', 'counts-one.example', 'https://counts-one.example/careers', '{}'::jsonb from fx;

-- Person A: 26 live roles (10 at one, 9 at two, 7 at three), then a stale one at two. Person B: 4 at one.
-- A writer's insert gives the company's owner a person_roles row (K5a's trigger).
insert into public.jobs (company_id, title, description, url, external_id, discovered_at, posted_at)
select ca1, 'Role ' || g, 'd', 'https://counts-one.example/jobs/' || g, 'c1-' || g, now(), now() - interval '2 days' from fx, generate_series(1, 10) g
union all select ca2, 'Role ' || g, 'd', 'https://counts-two.example/jobs/' || g, 'c2-' || g, now(), null from fx, generate_series(1, 9) g
union all select ca3, 'Role ' || g, 'd', 'https://counts-three.example/jobs/' || g, 'c3-' || g, now(), now() - interval '10 days' from fx, generate_series(1, 7) g
union all select ca2, 'Old role', 'd', 'https://counts-two.example/jobs/old', 'c2-old', now(), now() - interval '200 days' from fx
union all select cb1, 'Role ' || g, 'd', 'https://counts-one.example/jobs/b' || g, 'b1-' || g, now(), now() from fx, generate_series(1, 4) g;

-- One of A's roles at the first employer is hidden.
update public.person_roles set hidden_reason = 'not_for_me'
 where user_id = (select a from fx)
   and job_id = (select id from public.jobs where external_id = 'c1-1');

-- Role types: Cello's type on the posting, then the person's own word over it for two roles at the second
-- employer. One of A's roles at the first employer is hidden (above); the stale role and the untyped third
-- employer do not count.
update public.jobs set role_type = 'ai-engineer' where external_id like 'c1-%' or external_id like 'b1-%' or external_id = 'c2-old';
update public.jobs set role_type = 'data-engineer' where external_id like 'c2-%' and external_id <> 'c2-old';
update public.person_roles set role_type = 'ml-engineer'
 where user_id = (select a from fx) and job_id in (select id from public.jobs where external_id in ('c2-1', 'c2-2'));

-- What a read found outside the targets: the seventh day counts, the eighth does not, other kinds do not.
insert into public.person_counts (user_id, day, employer_id, kind, reason, n)
select a, current_date, e1, 'outside_targets', 'place', 5 from fx
union all select a, current_date - 3, e2, 'outside_targets', 'place', 2 from fx
union all select a, current_date - 6, e3, 'outside_targets', 'level', 3 from fx
union all select a, current_date - 7, e1, 'outside_targets', 'place', 100 from fx
union all select a, current_date, e1, 'untraced', 'untraced', 40 from fx
union all select b, current_date, e1, 'outside_targets', 'place', 9 from fx;

select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
select set_config('chk.employer_a', (select jsonb_object_agg(key, n)::text from public.role_counts('employer')), true);
select set_config('chk.week_a', (select jsonb_object_agg(key, n)::text from public.role_counts('outside_week')), true);
select set_config('chk.type_a', (select jsonb_object_agg(key, n)::text from public.role_counts('role_type')), true);
reset role;

select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', b)::text, true) from fx;
set local role authenticated;
select set_config('chk.employer_b', (select jsonb_object_agg(key, n)::text from public.role_counts('employer')), true);
select set_config('chk.week_b', (select jsonb_object_agg(key, n)::text from public.role_counts('outside_week')), true);
select set_config('chk.type_b', (select jsonb_object_agg(key, n)::text from public.role_counts('role_type')), true);
reset role;

do $$
declare f record; hand text;
begin
  select * into f from fx;

  -- A's three employers, by a hand count of the rows A can see on the page.
  select jsonb_object_agg(e, c)::text into hand
    from (
      select coalesce(j.employer_id, j.company_id)::text as e, count(*) as c
        from public.person_roles pr
        join public.jobs j on j.id = pr.job_id
       where pr.user_id = f.a
         and pr.hidden_reason is null
         and (j.posted_at is null or j.posted_at >= now() - interval '180 days')
       group by 1
    ) t;
  if current_setting('chk.employer_a')::jsonb is distinct from hand::jsonb then
    raise exception 'employer counts for A are %, a hand count says %', current_setting('chk.employer_a'), hand;
  end if;
  if (current_setting('chk.employer_a')::jsonb ->> f.e1::text)::int <> 9
     or (current_setting('chk.employer_a')::jsonb ->> f.e2::text)::int <> 9
     or (current_setting('chk.employer_a')::jsonb ->> f.e3::text)::int <> 7 then
    raise exception 'A should see 9, 9 and 7 (a hidden role and a stale role do not count): %', current_setting('chk.employer_a');
  end if;

  -- B counts only B's own four, never A's rows at the same employer.
  if current_setting('chk.employer_b')::jsonb is distinct from jsonb_build_object(f.e1::text, 4) then
    raise exception 'B should see only their 4 roles at one employer, saw %', current_setting('chk.employer_b');
  end if;

  -- By type: the person's own word wins over the posting's, a hidden, stale or untyped role does not count,
  -- and B's four are B's alone.
  if current_setting('chk.type_a')::jsonb is distinct from jsonb_build_object('ai-engineer', 9, 'data-engineer', 7, 'ml-engineer', 2) then
    raise exception 'role_type counts for A should be ai-engineer 9, data-engineer 7, ml-engineer 2, saw %', current_setting('chk.type_a');
  end if;
  if current_setting('chk.type_b')::jsonb is distinct from jsonb_build_object('ai-engineer', 4) then
    raise exception 'role_type counts for B should be ai-engineer 4, saw %', current_setting('chk.type_b');
  end if;

  -- Seven days of what was left outside, by reason; the eighth day and other kinds are not in it.
  if (current_setting('chk.week_a')::jsonb ->> 'place')::int <> 7 or (current_setting('chk.week_a')::jsonb ->> 'level')::int <> 3 then
    raise exception 'outside_week for A should be place 7 and level 3, saw %', current_setting('chk.week_a');
  end if;
  if current_setting('chk.week_b')::jsonb is distinct from jsonb_build_object('place', 9) then
    raise exception 'outside_week for B should be place 9 only, saw %', current_setting('chk.week_b');
  end if;
end $$;

-- An unknown grouping is refused rather than answered with nothing.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
do $$
begin
  begin
    perform * from public.role_counts('nope');
    raise exception 'an unknown grouping was answered';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
reset role;

set local role anon;
do $$
begin
  begin
    perform * from public.role_counts('role_type');
    raise exception 'anon ran role_counts';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- The two new reasons are accepted on a Not for me; a made-up one is not.
do $$
declare f record; j uuid;
begin
  select * into f from fx;
  select id into j from public.jobs where external_id = 'c1-2';
  insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title) values (f.a, j, 'not_for_me', 'level', 'roles', 'x');
  delete from public.role_reactions where user_id = f.a;
  insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title) values (f.a, j, 'not_for_me', 'role_type', 'roles', 'x');
  delete from public.role_reactions where user_id = f.a;
  begin
    insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title) values (f.a, j, 'not_for_me', 'because', 'roles', 'x');
    raise exception 'a made-up reason was accepted';
  exception when check_violation then null;
  end;
end $$;

\echo shell_pages_role_counts: ok
rollback;
