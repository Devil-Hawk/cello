-- K5a: the shared employer, person roles, seen postings and counts (migration 20261008050000).
--
-- Proves: two people with overlapping targets share one row after the fold and each reads only their
-- own person_roles; the applications of a folded copy move to the survivor; a saved role survives
-- prune and an unsaved one does not; reactions (saves) stay per person; a role outside someone's
-- targets can be counted and is not a row; the watching backfill follows only what a person added
-- (T9 = 0); a targets change bumps the version and makes the role check due. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/relevance_schema.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b, gen_random_uuid() as c,
       gen_random_uuid() as emp,
       gen_random_uuid() as co_a, gen_random_uuid() as co_b, gen_random_uuid() as co_lead,
       gen_random_uuid() as ja1, gen_random_uuid() as ja2, gen_random_uuid() as jb1;
grant select on fx to public;

insert into auth.users (id, email)
select a, 'rel-a@example.invalid' from fx
union all select b, 'rel-b@example.invalid' from fx
union all select c, 'rel-c@example.invalid' from fx;

-- The shared employer, and two people's companies that are it.
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select emp, 'Overlap Co', 'overlap co', 'overlap.example', 'greenhouse', 'overlapco', 'careers_link', now(), 'person' from fx;

insert into public.companies (id, user_id, name, domain, career_url, metadata)
select co_a, a, 'Overlap Co', 'overlap.example', 'https://overlap.example/careers', '{}'::jsonb from fx
union all select co_b, b, 'Overlap Co', 'Overlap.Example', 'https://overlap.example/careers', '{}'::jsonb from fx;

do $$
declare f record;
begin
  select * into f from fx;
  if (select employer_id from public.companies where id = f.co_a) is distinct from f.emp
     or (select employer_id from public.companies where id = f.co_b) is distinct from f.emp then
    raise exception 'a company whose domain is a directory employer must be linked to it';
  end if;
end $$;

-- Roles: both people hold the same posting; A also holds one B does not.
insert into public.jobs (id, company_id, title, description, url, external_id, job_function, seniority, country, discovered_at)
select ja1, co_a, 'Platform Engineer', 'd', 'https://overlap.example/jobs/req-1', 'req-1', 'engineering', 'senior', 'US', now() - interval '2 days' from fx
union all select ja2, co_a, 'Staff Engineer', 'd', 'https://overlap.example/jobs/req-2', 'req-2', 'engineering', 'staff', 'US', now() - interval '2 days' from fx
union all select jb1, co_b, 'Platform Engineer', 'd', 'https://overlap.example/jobs/req-1', 'req-1', 'engineering', 'senior', 'US', now() from fx;

do $$
declare f record;
begin
  select * into f from fx;
  if (select posting_key from public.jobs where id = f.ja1) <> 'req-1' or (select employer_id from public.jobs where id = f.jb1) is distinct from f.emp then
    raise exception 'a new job must get its employer and posting key';
  end if;
end $$;

select public.sync_person_roles(a, co_a, array['req-1', 'req-2'], 3, array['req-2']) from fx;
select public.sync_person_roles(b, co_b, array['req-1'], 3, '{}') from fx;

-- Applying to a role is the person's own; B applied to their copy, and saved it.
insert into public.applications (user_id, job_id) select b, jb1 from fx;
update public.person_roles set saved_at = now() where user_id = (select b from fx) and job_id = (select jb1 from fx);

do $$
declare f record; r record;
begin
  select * into f from fx;
  if (select count(*) from public.person_roles where user_id = f.a) <> 2 then raise exception 'A must hold two person_roles'; end if;
  select * into r from public.person_roles where user_id = f.a and job_id = f.ja2;
  if r.hidden_reason is distinct from 'unclassified' or r.targets_version <> 3 then raise exception 'a hidden role keeps its reason and version'; end if;
  -- a person cannot write another person's roles
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', f.b, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.sync_person_roles(f.a, f.co_a, array['req-1'], 1, '{}');
    reset role;
    raise exception 'sync_person_roles must refuse another person';
  exception when insufficient_privilege then
    reset role;
  end;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- T17 before the fold: a posting stored once for each person is reported, not judged.
do $$
declare t record;
begin
  select * into t from public.measure_t17();
  if t.value < 1 or t.passed is not null then raise exception 'before the fold T17 reports the copies and does not judge them, got % %', t.value, t.passed; end if;
end $$;

-- The fold.
create temp table res (k text, v jsonb);
insert into res select 'fold', public.fold_shared_postings();

do $$
declare f record; r jsonb;
begin
  select * into f from fx;
  select v into r from res where k = 'fold';
  if (r ->> 'merged')::int < 1 then raise exception 'the fold must merge the copy, got %', r; end if;
  if (select count(*) from public.jobs where employer_id = f.emp and posting_key = 'req-1') <> 1 then raise exception 'one row per posting after the fold'; end if;
  if not exists (select 1 from public.jobs where id = f.ja1) or exists (select 1 from public.jobs where id = f.jb1) then
    raise exception 'the oldest copy must survive';
  end if;
  -- each person has a row for the survivor, and only theirs
  if (select count(*) from public.person_roles where job_id = f.ja1) <> 2 then raise exception 'both people must hold the shared role'; end if;
  if (select count(*) from public.person_roles where job_id = f.ja2) <> 1 then raise exception 'only A holds req-2'; end if;
  -- B's application moved to the survivor
  if (select job_id from public.applications where user_id = f.b) <> f.ja1 then raise exception 'applications.job_id must follow the fold'; end if;
  -- B's save is B's alone
  if (select saved_at from public.person_roles where user_id = f.b and job_id = f.ja1) is null then raise exception 'B''s save must survive the fold'; end if;
  if (select saved_at from public.person_roles where user_id = f.a and job_id = f.ja1) is not null then raise exception 'A must not inherit B''s save'; end if;
end $$;

-- Running it again changes nothing.
do $$
begin
  if (public.fold_shared_postings() ->> 'merged')::int <> 0 then raise exception 'a second fold must merge nothing'; end if;
end $$;

-- Reading: each person reads their own person_roles and the shared role through it; nobody reads another's.
create function pg_temp.as_user(uid uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q into n;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;

do $$
declare f record;
begin
  select * into f from fx;
  if pg_temp.as_user(f.a, 'select count(*) from public.person_roles') <> 2 then raise exception 'A reads only their own person_roles'; end if;
  if pg_temp.as_user(f.b, 'select count(*) from public.person_roles') <> 1 then raise exception 'B reads only their own person_roles'; end if;
  if pg_temp.as_user(f.b, format('select count(*) from public.jobs where id = %L', f.ja1)) <> 1 then raise exception 'B must read the shared role through person_roles'; end if;
  if pg_temp.as_user(f.b, format('select count(*) from public.jobs where id = %L', f.ja2)) <> 0 then raise exception 'B must not read a role only A holds'; end if;
  if pg_temp.as_user(f.c, 'select count(*) from public.jobs') <> 0 then raise exception 'a person with no roles reads none'; end if;
  if pg_temp.as_user(f.c, 'select count(*) from public.person_roles') <> 0 then raise exception 'C reads no person_roles'; end if;
end $$;

-- The directory match: C follows nothing, and gets the roles others' checks stored at verified employers,
-- judged in code; only the ones C does not hold are offered, and giving them is idempotent.
do $$
declare f record; n integer; ids uuid[];
begin
  select * into f from fx;
  select count(*) into n from public.directory_roles_for(f.c, null, 100);
  if n < 2 then raise exception 'C must be offered the stored roles at verified employers, got %', n; end if;
  select array_agg(id) into ids from public.directory_roles_for(f.c, null, 100) where title = 'Platform Engineer';
  if public.add_person_roles(f.c, ids, '{}', 2) <> cardinality(ids) then raise exception 'add_person_roles must give the chosen roles'; end if;
  if exists (select 1 from public.directory_roles_for(f.c, null, 100) where title = 'Platform Engineer') then raise exception 'a role C holds is not offered again'; end if;
  if public.add_person_roles(f.c, ids, '{}', 2) <> 0 then raise exception 'giving a role twice changes nothing'; end if;
  if (select count(*) from public.directory_roles_for(f.c, now() + interval '1 day', 100)) <> 0 then raise exception 'p_since limits the offer to newer roles'; end if;
  delete from public.person_roles where user_id = f.c;
end $$;

-- Counts: a role outside the person's targets is a number. A day's read replaces the day's number.
select public.set_person_counts(a, jsonb_build_array(
  jsonb_build_object('employer_id', emp, 'company_id', co_a, 'kind', 'outside_targets', 'reason', 'place', 'n', 120),
  jsonb_build_object('employer_id', emp, 'company_id', co_a, 'kind', 'outside_targets', 'reason', 'level', 'n', 80))) from fx;
select public.set_person_counts(a, jsonb_build_array(
  jsonb_build_object('employer_id', emp, 'company_id', co_a, 'kind', 'outside_targets', 'reason', 'place', 'n', 124),
  jsonb_build_object('employer_id', emp, 'company_id', co_a, 'kind', 'outside_targets', 'reason', 'level', 'n', 0))) from fx;
do $$
declare f record;
begin
  select * into f from fx;
  if (select count(*) from public.person_counts where user_id = f.a) <> 1 then raise exception 'a reason that found nothing is no row'; end if;
  if (select n from public.person_counts where user_id = f.a and reason = 'place') <> 124 then raise exception 'the day''s read replaces the number'; end if;
  if (select sum(n) from public.person_counts where user_id = f.a and kind = 'outside_targets') <> 124 then raise exception 'the counted line adds up'; end if;
  -- a count for a company that is not the person's is refused quietly
  if public.set_person_counts(f.a, jsonb_build_array(jsonb_build_object('company_id', f.co_b, 'kind', 'cannot_read', 'reason', 'x', 'n', 1))) <> 0 then
    raise exception 'a count must not be written against another person''s company';
  end if;
  if pg_temp.as_user(f.b, 'select count(*) from public.person_counts') <> 0 then raise exception 'B must not read A''s counts'; end if;
end $$;

-- Seen postings: a marker that expires, never a role.
do $$
declare f record; fresh text[];
begin
  select * into f from fx;
  fresh := public.mark_seen_postings(f.emp, array['aaaaaaaa11', 'bbbbbbbb22']);
  if cardinality(fresh) <> 2 then raise exception 'both postings are new the first time'; end if;
  fresh := public.mark_seen_postings(f.emp, array['aaaaaaaa11', 'cccccccc33']);
  if fresh <> array['cccccccc33'] then raise exception 'only the unseen posting is new, got %', fresh; end if;
  update public.seen_postings set last_seen_at = now() - interval '31 days' where posting_hash = 'aaaaaaaa11';
  if cardinality(public.mark_seen_postings(f.emp, array['aaaaaaaa11'])) <> 1 then raise exception 'a marker older than 30 days is new again'; end if;
end $$;

-- Prune: a saved role survives, an unsaved one with nothing pointing at it goes, and a person_roles row is not a reason to keep it.
insert into public.jobs (id, company_id, title, description, url, external_id, last_seen_at)
select gen_random_uuid(), co_a, 'Old saved', 'd', 'https://overlap.example/jobs/old-1', 'old-1', now() - interval '60 days' from fx
union all select gen_random_uuid(), co_a, 'Old unsaved', 'd', 'https://overlap.example/jobs/old-2', 'old-2', now() - interval '60 days' from fx;
select public.sync_person_roles(a, co_a, array['old-1', 'old-2'], 3, '{}') from fx;
update public.person_roles set saved_at = now()
 where user_id = (select a from fx) and job_id = (select id from public.jobs where external_id = 'old-1');
select public.prune_stale_rows();
do $$
begin
  if not exists (select 1 from public.jobs where external_id = 'old-1') then raise exception 'a saved role must survive prune'; end if;
  if exists (select 1 from public.jobs where external_id = 'old-2') then raise exception 'an unsaved old role must be pruned despite its person_roles row'; end if;
  if exists (select 1 from public.person_roles pr where not exists (select 1 from public.jobs j where j.id = pr.job_id)) then raise exception 'person_roles must not outlive its role'; end if;
  if not exists (select 1 from public.seen_postings where posting_hash = 'bbbbbbbb22') then raise exception 'a recent marker must stay'; end if;
end $$;

-- Watching: a lead is not followed; a person's add is; promoting a lead follows it.
insert into public.companies (id, user_id, name, career_url, metadata)
select co_lead, a, 'A Lead', 'https://lead.example/jobs', '{"suggested": true}'::jsonb from fx;
do $$
declare f record;
begin
  select * into f from fx;
  if (select watching from public.companies where id = f.co_lead) then raise exception 'a lead must not be followed'; end if;
  if not (select watching from public.companies where id = f.co_a) then raise exception 'a person''s own company is followed'; end if;
  if (select value from public.measure_t9()) <> 0 then raise exception 'T9 must be 0, got %', (select value from public.measure_t9()); end if;
  update public.companies set metadata = '{}'::jsonb where id = f.co_lead;
  if not (select watching from public.companies where id = f.co_lead) then raise exception 'adding a lead the person chose follows it'; end if;
end $$;

-- A targets change bumps the version and makes the check due now; the same targets again do not.
update public.routines set next_due_at = now() + interval '5 hours' where command = 'roles.check' and user_id = (select a from fx);
update public.profiles
   set preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object('targeting', jsonb_build_object('functions', jsonb_build_array('engineering'), 'countries', jsonb_build_array('US')))
 where id = (select a from fx);
do $$
declare f record;
begin
  select * into f from fx;
  if (select targets_version from public.profiles where id = f.a) <> 1 then raise exception 'saving targets must bump the version'; end if;
  if (select next_due_at from public.routines where user_id = f.a and command = 'roles.check') > now() then raise exception 'saving targets must make the role check due now'; end if;
  update public.routines set next_due_at = now() + interval '5 hours' where command = 'roles.check' and user_id = f.a;
  update public.profiles set preferences = preferences || jsonb_build_object('digest', jsonb_build_object('x', 1)) where id = f.a;
  if (select targets_version from public.profiles where id = f.a) <> 1 then raise exception 'other preferences must not bump the version'; end if;
  if (select next_due_at from public.routines where user_id = f.a and command = 'roles.check') <= now() then raise exception 'other preferences must not start a check'; end if;
end $$;

-- What is outside a person's targets, in SQL: only what a role states and disagrees with.
do $$
declare t jsonb := '{"functions": ["engineering"], "seniority": ["senior"], "countries": ["US"], "remoteOnly": false, "excludedKeywords": ["sales"]}'::jsonb;
begin
  if public.role_outside_targets(t, 'engineering', 'senior', 'US', 'en', null, 'Platform Engineer', 'X') then raise exception 'an inside role is not outside'; end if;
  if not public.role_outside_targets(t, 'sales', 'senior', 'US', 'en', null, 'Account Executive', 'X') then raise exception 'a known other function is outside'; end if;
  if not public.role_outside_targets(t, 'engineering', 'senior', 'DE', 'en', null, 'Platform Engineer', 'X') then raise exception 'a known other country is outside'; end if;
  if public.role_outside_targets(t, 'engineering', null, null, null, null, 'Platform Engineer', 'X') then raise exception 'what a role does not state is not a disagreement'; end if;
  if not public.role_outside_targets(t, 'engineering', 'senior', 'US', 'en', null, 'Sales Engineer', 'X') then raise exception 'an excluded word is outside'; end if;
  if public.has_role_targets('{}'::jsonb) or not public.has_role_targets(t) then raise exception 'has_role_targets'; end if;
end $$;

-- T3: A's targets are engineering in the US. A visible sales role in Germany is outside; once it is hidden it is not counted.
insert into public.jobs (id, company_id, title, description, url, external_id, job_function, seniority, country, posted_at)
select gen_random_uuid(), co_a, 'Account Executive', 'd', 'https://overlap.example/jobs/ae-1', 'ae-1', 'sales', 'senior', 'DE', now() - interval '200 days' from fx;
select public.sync_person_roles(a, co_a, array['ae-1'], 1, '{}') from fx;
do $$
declare t record; s record;
begin
  select * into t from public.measure_t3();
  if t.value < 1 or t.passed is not false then raise exception 'T3 must see the stored role outside targets, got % %', t.value, t.passed; end if;
  select * into s from public.measure_t2();
  if s.value < 1 or s.passed is not false then raise exception 'T2 must see the role older than 180 days, got % %', s.value, s.passed; end if;
  update public.person_roles set hidden_reason = 'not_for_me' where job_id = (select id from public.jobs where external_id = 'ae-1');
  if (select value from public.measure_t3()) <> 0 then raise exception 'a hidden role is not shown, so not counted'; end if;
  if (select value from public.measure_t2()) <> 0 then raise exception 'a hidden role is not shown, so not counted by T2'; end if;
end $$;

-- T7 reports and does not judge.
do $$
declare t record;
begin
  select * into t from public.measure_t7();
  if t.passed is not null or t.value is null then raise exception 'T7 is reported, not judged'; end if;
end $$;

-- No client role runs the fold, the marker or the prune.
create function pg_temp.must_be_denied(r text, q text) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  begin
    execute q;
  exception when insufficient_privilege then
    reset role;
    return;
  end;
  reset role;
  raise exception 'expected 42501 for role %, but it ran: %', r, q;
end $$;
select pg_temp.must_be_denied('authenticated', 'select public.fold_shared_postings()');
select pg_temp.must_be_denied('authenticated', 'select public.prune_stale_rows()');
select pg_temp.must_be_denied('authenticated', 'select * from public.directory_roles_for(gen_random_uuid())');
select pg_temp.must_be_denied('authenticated', $q$select public.add_person_roles(gen_random_uuid(), '{}')$q$);
select pg_temp.must_be_denied('anon', 'select 1 from public.person_roles');
select pg_temp.must_be_denied('anon', 'select 1 from public.company_directory');
select pg_temp.must_be_denied('authenticated', 'select 1 from public.company_directory');
select pg_temp.must_be_denied('authenticated', 'select 1 from public.seen_postings');
select pg_temp.must_be_denied('authenticated', $q$insert into public.person_roles (user_id, job_id) values (gen_random_uuid(), gen_random_uuid())$q$);
select pg_temp.must_be_denied('authenticated', $q$insert into public.person_counts (user_id, day, kind, n) values (gen_random_uuid(), current_date, 'outside_targets', 1)$q$);

rollback;
