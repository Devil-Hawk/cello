-- K5c: role types (migration 20261008057000).
--
-- Proves: two untyped titles at one employer and level add to one employer_stats row; a person's
-- correction moves only that person's roles with that title, writes their own synonym and nobody else's,
-- and never touches title_types; two people give one shared role two different types; the live switch
-- starts off and no signed-in person can read or flip it; role_types is readable by every signed-in
-- person and writable by none; T19 and T20 run. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/relevance_role_types.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b,
       gen_random_uuid() as emp, gen_random_uuid() as co_a, gen_random_uuid() as co_b,
       gen_random_uuid() as j1, gen_random_uuid() as j2, gen_random_uuid() as j3;
grant select on fx to public;

insert into auth.users (id, email) select a, 'types-a@example.invalid' from fx union all select b, 'types-b@example.invalid' from fx;

-- the migration seeds the taxonomy; one more type, retired, for the refusal below
insert into public.role_types (id, label, family, related, taxonomy_version) values ('retired-type', 'Retired', 'engineering', '{}', 1);
update public.role_types set retired_at = now(), replaced_by = 'ai-engineer' where id = 'retired-type';
do $$ begin
  if (select count(*) from public.role_types where retired_at is null) < 30 then raise exception 'the migration must seed the taxonomy'; end if;
end $$;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select emp, 'Typed Co', 'typed co', 'typed.example', 'greenhouse', 'typedco', 'careers_link', now(), 'person' from fx;
insert into public.companies (id, user_id, name, domain, career_url, metadata)
select co_a, a, 'Typed Co', 'typed.example', 'https://typed.example/careers', '{}'::jsonb from fx
union all select co_b, b, 'Typed Co', 'typed.example', 'https://typed.example/careers', '{}'::jsonb from fx;

-- one shared role j1 and a second role j2 with the same title (both held by A and B), and j3 with another title (held by A)
insert into public.jobs (id, company_id, title, description, url, external_id, title_norm, dept_norm)
select j1, co_a, 'Member of Technical Staff', 'd', 'https://typed.example/jobs/1', 'r1', 'member of technical staff', 'applied ai' from fx
union all select j2, co_a, 'Member of Technical Staff', 'd', 'https://typed.example/jobs/2', 'r2', 'member of technical staff', 'infrastructure' from fx
union all select j3, co_a, 'Backend Engineer', 'd', 'https://typed.example/jobs/3', 'r3', 'backend engineer', '' from fx;
insert into public.person_roles (user_id, job_id, hidden_reason) select b, j1, 'unclassified' from fx on conflict do nothing;
insert into public.person_roles (user_id, job_id) select b, j2 from fx on conflict do nothing;
insert into public.title_types (title_norm, dept_norm, role_type, origin, taxonomy_version, status, n_seen, typed_at)
values ('backend engineer', '', null, 'code', 1, 'pending', 3, null);

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

-- 1. Titles not yet typed count in one row per employer and level.
do $$
declare f record;
begin
  select * into f from fx;
  insert into public.employer_stats (employer_id, role_type, seniority, open_count) values (f.emp, null, 'senior', 1)
    on conflict (employer_id, role_type, seniority) do update set open_count = public.employer_stats.open_count + excluded.open_count;
  insert into public.employer_stats (employer_id, role_type, seniority, open_count) values (f.emp, null, 'senior', 1)
    on conflict (employer_id, role_type, seniority) do update set open_count = public.employer_stats.open_count + excluded.open_count;
  if (select count(*) from public.employer_stats where employer_id = f.emp and role_type is null and seniority = 'senior') <> 1 then
    raise exception 'two untyped titles at one employer and level must be one row';
  end if;
  if (select open_count from public.employer_stats where employer_id = f.emp and role_type is null) <> 2 then raise exception 'the counter adds'; end if;
  -- a typed row of the same employer and level is another row
  insert into public.employer_stats (employer_id, role_type, seniority, open_count) values (f.emp, 'ai-engineer', 'senior', 1);
  if (select count(*) from public.employer_stats where employer_id = f.emp) <> 2 then raise exception 'a typed row is its own row'; end if;
end $$;

-- 2. A correction moves only that person's roles with that title, and writes only their synonym.
do $$
declare f record; n integer;
begin
  select * into f from fx;
  -- A holds j1, j2 (their own copies) and j3; B holds j1 and j2 too
  insert into public.person_roles (user_id, job_id) select f.a, id from public.jobs where id in (f.j1, f.j2, f.j3) on conflict do nothing;
  update public.profiles set preferences = jsonb_build_object('targeting', jsonb_build_object('role_types', jsonb_build_array('ai-engineer'))) where id = f.b;

  n := public.set_person_role_type(f.a, f.j1, 'ai-engineer');
  if n <> 2 then raise exception 'A''s two member-of-technical-staff roles move, got %', n; end if;
  if (select count(*) from public.person_roles where user_id = f.a and role_type = 'ai-engineer') <> 2 then raise exception 'A''s rows with that title carry the type'; end if;
  if exists (select 1 from public.person_roles where user_id = f.a and job_id = f.j3 and role_type is not null) then raise exception 'A''s role with another title does not move'; end if;
  if exists (select 1 from public.person_roles where user_id = f.b and role_type is not null) then raise exception 'B''s roles do not move'; end if;
  if (select count(*) from public.role_type_synonyms where user_id = f.a) <> 1 or exists (select 1 from public.role_type_synonyms where user_id = f.b) then raise exception 'only A has a synonym'; end if;
  if (select role_type from public.title_types where title_norm = 'backend engineer') is not null then raise exception 'a correction never changes title_types'; end if;
  if exists (select 1 from public.title_types where title_norm = 'member of technical staff') then raise exception 'a correction never writes title_types'; end if;

  -- B chooses ai-engineer: a role they held hidden as unclassified is shown when the type is theirs
  perform public.set_person_role_type(f.b, f.j1, 'ai-engineer');
  if (select hidden_reason from public.person_roles where user_id = f.b and job_id = f.j1) is not null then raise exception 'a type B chose shows the role'; end if;

  -- two people, one shared role, two types
  perform public.set_person_role_type(f.b, f.j1, 'ml-engineer');
  if (select count(distinct role_type) from public.person_roles where job_id = f.j1) <> 2 then raise exception 'two people may type one shared role differently'; end if;
  if pg_temp.as_user(f.b, format($q$select count(*) from public.person_jobs where id = %L and viewer_role_type = 'ml-engineer'$q$, f.j1)) <> 1 then raise exception 'B reads their own type through person_jobs'; end if;
  if pg_temp.as_user(f.a, format($q$select count(*) from public.person_jobs where id = %L and viewer_role_type = 'ai-engineer'$q$, f.j1)) <> 1 then raise exception 'A reads their own type through person_jobs'; end if;

  -- "none of the types" removes the synonym
  perform public.set_person_role_type(f.b, f.j1, null);
  if exists (select 1 from public.role_type_synonyms where user_id = f.b) then raise exception 'none removes the synonym'; end if;
end $$;

-- A person cannot correct another person's roles, name a type that is not there or a retired one, or correct a role they do not hold.
do $$
declare f record;
begin
  select * into f from fx;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', f.b, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.set_person_role_type(f.a, f.j1, 'ai-engineer');
    reset role;
    raise exception 'another person''s roles must be refused';
  exception when insufficient_privilege then
    reset role;
  end;
  perform set_config('request.jwt.claims', '', true);
  begin perform public.set_person_role_type(f.a, f.j1, 'no-such-type'); raise exception 'an unknown type must be refused';
  exception when sqlstate '22023' then null; end;
  begin perform public.set_person_role_type(f.a, f.j1, 'retired-type'); raise exception 'a retired type must be refused';
  exception when sqlstate '22023' then null; end;
  delete from public.person_roles where user_id = f.b and job_id = f.j3;
  begin perform public.set_person_role_type(f.b, f.j3, 'ai-engineer'); raise exception 'a role the person does not hold must be refused';
  exception when sqlstate '22023' then null; end;
end $$;

-- Typing stored roles by code: a role a model typed is left alone, and title_types follows what code decided.
do $$
declare f record;
begin
  select * into f from fx;
  update public.jobs set role_type = 'ml-engineer', type_origin = 'model', type_prov = '{"step": "role.type"}'::jsonb where id = f.j2;
  perform public.apply_title_types(jsonb_build_array(
    jsonb_build_object('id', f.j1, 'title_norm', 'member of technical staff', 'dept_norm', 'applied ai', 'role_type', 'ai-engineer', 'type_origin', 'code', 'type_prov', jsonb_build_object('rule', 'department', 'taxonomy_version', 1)),
    jsonb_build_object('id', f.j2, 'title_norm', 'member of technical staff', 'dept_norm', 'infrastructure', 'role_type', 'platform-engineer', 'type_origin', 'code', 'type_prov', jsonb_build_object('rule', 'department', 'taxonomy_version', 1)),
    jsonb_build_object('id', f.j3, 'title_norm', 'backend engineer', 'dept_norm', '', 'role_type', null, 'type_origin', null, 'type_prov', jsonb_build_object('taxonomy_version', 1))
  ));
  if (select role_type from public.jobs where id = f.j1) <> 'ai-engineer' or (select type_origin from public.jobs where id = f.j1) <> 'code' then raise exception 'code types a role'; end if;
  if (select role_type from public.jobs where id = f.j2) <> 'ml-engineer' or (select type_origin from public.jobs where id = f.j2) <> 'model' then raise exception 'a role a model typed keeps its type'; end if;
  if (select status from public.title_types where title_norm = 'member of technical staff' and dept_norm = 'applied ai') <> 'typed' then raise exception 'title_types follows the answer'; end if;
  if (select status from public.title_types where title_norm = 'backend engineer' and dept_norm = '') <> 'pending' or (select n_seen from public.title_types where title_norm = 'backend engineer' and dept_norm = '') <> 4 then raise exception 'an untyped title stays pending and counts'; end if;
end $$;

-- 3. The switch starts off and is the owner's alone; the taxonomy is readable and not writable.
do $$
begin
  if (select "on" from public.instance_flags where key = 'role_types_live') then raise exception 'role_types_live starts off'; end if;
  if pg_temp.as_user((select a from fx), 'select count(*) from public.role_types') < 2 then raise exception 'a signed-in person reads the taxonomy'; end if;
end $$;

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
select pg_temp.must_be_denied('authenticated', 'select 1 from public.instance_flags');
select pg_temp.must_be_denied('authenticated', $q$update public.instance_flags set "on" = true$q$);
select pg_temp.must_be_denied('authenticated', $q$insert into public.role_types (id, label, family, taxonomy_version) values ('x-type', 'X', 'engineering', 1)$q$);
select pg_temp.must_be_denied('authenticated', 'select 1 from public.title_types');
select pg_temp.must_be_denied('authenticated', 'select 1 from public.employer_stats');
select pg_temp.must_be_denied('anon', 'select 1 from public.role_types');

-- A person's synonyms are theirs.
do $$
declare f record;
begin
  select * into f from fx;
  if pg_temp.as_user(f.b, 'select count(*) from public.role_type_synonyms') <> 0 then raise exception 'B reads only their own synonyms'; end if;
  if pg_temp.as_user(f.a, 'select count(*) from public.role_type_synonyms') <> 1 then raise exception 'A reads their own synonym'; end if;
end $$;

-- 4. T19 and T20 run and only report.
do $$
declare t record;
begin
  select * into t from public.measure_t19();
  if t.passed is not null or t.sample_n is null then raise exception 'T19 is reported, not judged'; end if;
  select * into t from public.measure_t20();
  if t.passed is not null or t.value is null then raise exception 'T20 is reported, not judged'; end if;
end $$;

-- The retype routine is a row of the clock; the post migration (20261008057001) turns it on.
do $$
begin
  if not exists (select 1 from public.routines where command = 'roles.retype' and user_id is null) then raise exception 'roles.retype must be a routine of the instance'; end if;
  if not (select enabled from public.routines where command = 'roles.retype' and user_id is null) then raise exception 'the post migration enables roles.retype'; end if;
end $$;

rollback;
