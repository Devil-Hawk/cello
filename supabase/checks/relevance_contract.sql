-- K5b: the contract (migration 20261008055000). A role is one row per posting, read through person_roles.
--
-- Proves: after the fold two people's copies of one posting are one row with two person_roles rows and
-- the application repointed; a signed-in person reads a role only through their person_roles row (not
-- through the company that stored it); upsert_shared_jobs twice for two followers leaves one row with
-- the first company; a second follower's check can be given the shared row; prune deletes a role older
-- than 30 days at an employer nobody follows, keeps a saved one and a 170-day-old one at a followed
-- employer, and deletes a 190-day-old one; every signed-in person reads the employer directory; a role stored with
-- no company is read by its holders and cannot be updated by a person; a shared role survives its first follower
-- removing the company or the account.
-- Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/relevance_contract.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b,
       gen_random_uuid() as emp, gen_random_uuid() as emp2,
       gen_random_uuid() as co_a, gen_random_uuid() as co_b,
       gen_random_uuid() as ja, gen_random_uuid() as jb;
grant select on fx to public;

insert into auth.users (id, email)
select a, 'contract-a@example.invalid' from fx union all select b, 'contract-b@example.invalid' from fx;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select emp, 'Shared Co', 'shared co', 'shared.example', 'greenhouse', 'sharedco', 'careers_link', now(), 'person' from fx
union all
select emp2, 'Nobody Follows', 'nobody follows', 'nobody.example', 'greenhouse', 'nobodyfollows', 'careers_link', now(), 'seed' from fx;

insert into public.companies (id, user_id, name, domain, career_url, metadata)
select co_a, a, 'Shared Co', 'shared.example', 'https://shared.example/careers', '{}'::jsonb from fx
union all select co_b, b, 'Shared Co', 'shared.example', 'https://shared.example/careers', '{}'::jsonb from fx;

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

-- 1. The fold. The unique index would refuse the copies, so it is dropped for the setup and made again after.
drop index public.jobs_employer_posting_key;

insert into public.jobs (id, company_id, title, description, url, external_id, job_function, seniority, country, discovered_at)
select ja, co_a, 'Platform Engineer', 'd', 'https://shared.example/jobs/req-1', 'req-1', 'engineering', 'senior', 'US', now() - interval '2 days' from fx
union all select jb, co_b, 'Platform Engineer', 'd', 'https://shared.example/jobs/req-1', 'req-1', 'engineering', 'senior', 'US', now() from fx;
insert into public.applications (user_id, job_id) select b, jb from fx;

do $$
declare f record; r jsonb;
begin
  select * into f from fx;
  r := public.fold_shared_postings();
  if (r ->> 'merged')::int < 1 then raise exception 'the fold must merge the copy, got %', r; end if;
  if (select count(*) from public.jobs where employer_id = f.emp and posting_key = 'req-1') <> 1 then raise exception 'one row per posting after the fold'; end if;
  if (select count(*) from public.person_roles where job_id = f.ja) <> 2 then raise exception 'both people hold the shared row'; end if;
  if (select job_id from public.applications where user_id = f.b) <> f.ja then raise exception 'the application follows the fold'; end if;
end $$;

create unique index jobs_employer_posting_key on public.jobs (employer_id, posting_key);

-- 2. Reading is through person_roles.
do $$
declare f record; j9 uuid := gen_random_uuid();
begin
  select * into f from fx;
  if pg_temp.as_user(f.b, format('select count(*) from public.jobs where id = %L', f.ja)) <> 1 then raise exception 'B reads the shared role through their person_roles row'; end if;
  if pg_temp.as_user(f.b, format('select count(*) from public.person_jobs where id = %L', f.ja)) <> 1 then raise exception 'B reads the shared role through person_jobs'; end if;
  -- a role at A's own company that A holds no person_roles row for is not A's to read
  insert into public.jobs (id, company_id, title, description, url, external_id) values (j9, f.co_a, 'Unheld', 'd', 'https://shared.example/jobs/req-9', 'req-unheld');
  delete from public.person_roles where job_id = j9;
  if pg_temp.as_user(f.a, format('select count(*) from public.jobs where id = %L', j9)) <> 0 then raise exception 'a role without a person_roles row is not returned from jobs'; end if;
  if pg_temp.as_user(f.a, format('select count(*) from public.person_jobs where id = %L', j9)) <> 0 then raise exception 'a role without a person_roles row is not returned from person_jobs'; end if;
  delete from public.jobs where id = j9;
  -- a role can be stored with no company at all
  insert into public.jobs (id, company_id, employer_id, title, description, url, external_id) values (j9, null, f.emp2, 'No company', 'd', 'https://nobody.example/jobs/1', 'dir-1');
  delete from public.jobs where id = j9;
end $$;

-- 3. upsert_shared_jobs: two followers, one row, the first company stays; the second follower is given it.
do $$
declare f record; row_a jsonb; row_b jsonb; first_seen timestamptz;
begin
  select * into f from fx;
  row_a := jsonb_build_array(jsonb_build_object('company_id', f.co_a, 'external_id', 'req-5', 'title', 'Staff Engineer', 'description', 'd',
            'url', 'https://shared.example/jobs/req-5', 'is_new', true, 'discovered_at', now(), 'source', 'greenhouse', 'last_seen_at', now()));
  row_b := jsonb_build_array(jsonb_build_object('company_id', f.co_b, 'external_id', 'req-5', 'title', 'Staff Engineer II', 'description', 'd2',
            'url', 'https://shared.example/jobs/req-5', 'is_new', true, 'discovered_at', now() + interval '1 day', 'source', 'greenhouse', 'last_seen_at', now()));
  perform public.upsert_shared_jobs(row_a);
  select discovered_at into first_seen from public.jobs where employer_id = f.emp and posting_key = 'req-5';
  update public.jobs set is_new = false where employer_id = f.emp and posting_key = 'req-5';
  perform public.upsert_shared_jobs(row_b);
  if (select count(*) from public.jobs where employer_id = f.emp and posting_key = 'req-5') <> 1 then raise exception 'one row per posting for two followers'; end if;
  if (select company_id from public.jobs where employer_id = f.emp and posting_key = 'req-5') <> f.co_a then raise exception 'the first follower''s company stays on the row'; end if;
  if (select title from public.jobs where employer_id = f.emp and posting_key = 'req-5') <> 'Staff Engineer II' then raise exception 'the second read updates the row'; end if;
  if (select discovered_at from public.jobs where employer_id = f.emp and posting_key = 'req-5') <> first_seen then raise exception 'discovered_at is not rewritten'; end if;
  if (select is_new from public.jobs where employer_id = f.emp and posting_key = 'req-5') then raise exception 'is_new is not rewritten'; end if;

  -- B's check keeps the shared row; A's is not touched
  if public.sync_person_roles(f.b, f.co_b, array['req-5'], 2, '{}') <> 1 then raise exception 'B must be given the shared role stored under A''s company'; end if;
  if (select count(*) from public.person_roles pr join public.jobs j on j.id = pr.job_id where j.posting_key = 'req-5' and pr.user_id = f.b) <> 1 then raise exception 'B holds req-5'; end if;

  -- a person cannot write another person's company
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', f.a, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.upsert_shared_jobs(row_b);
    reset role;
    raise exception 'upsert_shared_jobs must refuse a company that is not the caller''s';
  exception when insufficient_privilege then
    reset role;
  end;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 4. Prune by the window rule.
do $$
declare f record;
begin
  select * into f from fx;
  -- nobody follows emp2: 31 days old goes, 29 stays, a saved one stays
  insert into public.jobs (company_id, employer_id, title, description, url, external_id, posted_at, last_seen_at)
  values (null, f.emp2, 'Directory 31', 'd', 'https://nobody.example/jobs/31', 'dir-31', now() - interval '31 days', now()),
         (null, f.emp2, 'Directory 29', 'd', 'https://nobody.example/jobs/29', 'dir-29', now() - interval '29 days', now()),
         (null, f.emp2, 'Directory saved', 'd', 'https://nobody.example/jobs/s', 'dir-saved', now() - interval '40 days', now());
  insert into public.person_roles (user_id, job_id, saved_at) select f.a, id, now() from public.jobs where external_id = 'dir-saved';
  -- A follows emp: 170 days old stays, 190 days old goes
  insert into public.jobs (company_id, title, description, url, external_id, posted_at, last_seen_at)
  values (f.co_a, 'Followed 170', 'd', 'https://shared.example/jobs/170', 'fol-170', now() - interval '170 days', now()),
         (f.co_a, 'Followed 190', 'd', 'https://shared.example/jobs/190', 'fol-190', now() - interval '190 days', now());
  -- closed for 8 days goes; closed yesterday stays
  insert into public.jobs (company_id, title, description, url, external_id, still_open, last_seen_at)
  values (f.co_a, 'Closed 8', 'd', 'https://shared.example/jobs/c8', 'closed-8', false, now() - interval '8 days'),
         (f.co_a, 'Closed 1', 'd', 'https://shared.example/jobs/c1', 'closed-1', false, now() - interval '1 day');
  perform public.prune_stale_rows();
  if exists (select 1 from public.jobs where external_id = 'dir-31') then raise exception 'a 31-day-old role at an employer nobody follows must go'; end if;
  if not exists (select 1 from public.jobs where external_id = 'dir-29') then raise exception 'a 29-day-old role stays'; end if;
  if not exists (select 1 from public.jobs where external_id = 'dir-saved') then raise exception 'a saved role stays however old'; end if;
  if not exists (select 1 from public.jobs where external_id = 'fol-170') then raise exception 'a 170-day-old role at a followed employer stays'; end if;
  if exists (select 1 from public.jobs where external_id = 'fol-190') then raise exception 'a 190-day-old role at a followed employer goes'; end if;
  if exists (select 1 from public.jobs where external_id = 'closed-8') then raise exception 'a role closed for 8 days goes'; end if;
  if not exists (select 1 from public.jobs where external_id = 'closed-1') then raise exception 'a role closed yesterday stays'; end if;
  -- an applied role stays whatever its age
  if not exists (select 1 from public.jobs where id = f.ja) then raise exception 'the role with an application stays'; end if;
end $$;

-- 5. The employer directory is readable by every signed-in person, and writable by none.
do $$
declare f record;
begin
  select * into f from fx;
  if pg_temp.as_user(f.a, 'select count(*) from public.company_directory') < 2 then raise exception 'a signed-in person reads the employer directory'; end if;
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
select pg_temp.must_be_denied('authenticated', $q$insert into public.company_directory (name, name_norm) values ('x', 'x')$q$);
select pg_temp.must_be_denied('authenticated', $q$select public.set_employer_open_count(gen_random_uuid(), 3)$q$);
select pg_temp.must_be_denied('anon', 'select 1 from public.company_directory');

select public.set_employer_open_count((select emp from fx), 636);
do $$
begin
  if (select open_count from public.company_directory where id = (select emp from fx)) <> 636 then raise exception 'open_count is the last read''s total'; end if;
end $$;

-- 6. A role the sweep stored (company_id null, employer_id set) is read by its holders, and a person cannot write it.
do $$
declare f record; jn uuid := gen_random_uuid(); e uuid := gen_random_uuid();
begin
  select * into f from fx;
  insert into auth.users (id, email) values (e, 'contract-e@example.invalid');
  insert into public.jobs (id, company_id, employer_id, title, description, url, external_id) values (jn, null, f.emp, 'Sweep role', 'd', 'https://shared.example/jobs/sweep', 'sweep-1');
  insert into public.person_roles (user_id, job_id) values (f.a, jn), (e, jn);
  -- a holder who follows the employer sees it with their own company's name, one who does not sees it without
  if (select viewer_company_name from public.person_jobs where viewer_id = f.a and id = jn) is distinct from 'Shared Co' then raise exception 'a follower reads the sweep role with their company name'; end if;
  if pg_temp.as_user(e, format('select count(*) from public.person_jobs where id = %L', jn)) <> 1 then raise exception 'a holder who does not follow the employer still reads the sweep role'; end if;
  if (select viewer_company_name from public.person_jobs where viewer_id = e and id = jn) is not null then raise exception 'a holder who does not follow has no company name'; end if;
  -- the employer's name is reachable for everyone through jobs.employer_id
  if pg_temp.as_user(e, format('select count(*) from public.jobs j join public.company_directory d on d.id = j.employer_id where j.id = %L', jn)) <> 1 then raise exception 'the employer is readable through jobs.employer_id'; end if;
  -- a signed-in update of a shared role changes nothing: writes go through the service role
  if pg_temp.as_user(f.a, format('with u as (update public.jobs set match_score = 88 where id = %L returning 1) select count(*) from u', jn)) <> 0 then raise exception 'a person must not update a shared role'; end if;
  if (select match_score from public.jobs where id = jn) is not null then raise exception 'the shared role is unchanged'; end if;
end $$;

-- 6b. The company that stored a shared role cannot rewrite it for the others who hold it.
do $$
declare f record; jw uuid := gen_random_uuid(); jl uuid := gen_random_uuid();
begin
  select * into f from fx;
  insert into public.jobs (id, company_id, employer_id, title, description, url, external_id) values (jw, f.co_a, f.emp, 'Held by two', 'd', 'https://shared.example/jobs/held', 'held-1');
  insert into public.person_roles (user_id, job_id) values (f.a, jw), (f.b, jw);
  if (select company_id from public.jobs where id = jw) is distinct from f.co_a then raise exception 'the role is stored under A''s own company'; end if;
  if pg_temp.as_user(f.a, format('with u as (update public.jobs set url = ''https://evil.example/phish'', title = ''Hacked'' where id = %L returning 1) select count(*) from u', jw)) <> 0 then raise exception 'the first storer must not update a role another person holds'; end if;
  if (select url from public.jobs where id = jw) <> 'https://shared.example/jobs/held' then raise exception 'the shared apply link is unchanged'; end if;
  -- a role with no employer is nobody else's: its own company still writes it
  insert into public.jobs (id, company_id, title, description, url, external_id) values (jl, f.co_a, 'Legacy', 'd', 'https://legacy.example/1', 'legacy-1');
  update public.jobs set employer_id = null where id = jl;
  if pg_temp.as_user(f.a, format('with u as (update public.jobs set title = ''Legacy two'' where id = %L returning 1) select count(*) from u', jl)) <> 1 then raise exception 'a person still updates a role with no employer'; end if;
end $$;

-- 7. A shared role outlives the follower whose company stored it: removing the company, or the account, keeps it for the others.
do $$
declare f record; jd uuid := gen_random_uuid(); jp uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); co_c uuid := gen_random_uuid(); co_d uuid := gen_random_uuid();
begin
  select * into f from fx;
  -- A's company goes: B keeps the role, the person_roles row and the application
  insert into public.jobs (id, company_id, title, description, url, external_id) values (jd, f.co_a, 'Shared one', 'd', 'https://shared.example/jobs/del-1', 'del-1');
  insert into public.person_roles (user_id, job_id) values (f.b, jd) on conflict do nothing;
  insert into public.applications (user_id, job_id) values (f.b, jd);
  delete from public.companies where id = f.co_a;
  if not exists (select 1 from public.jobs where id = jd) then raise exception 'the shared role survives its first follower removing the company'; end if;
  if (select company_id from public.jobs where id = jd) is distinct from f.co_b then raise exception 'the role is handed to another holder''s company'; end if;
  if not exists (select 1 from public.person_roles where job_id = jd and user_id = f.b) then raise exception 'B keeps the person_roles row'; end if;
  if not exists (select 1 from public.applications where job_id = jd and user_id = f.b) then raise exception 'B keeps the application'; end if;
  if exists (select 1 from public.person_roles where job_id = jd and user_id = f.a) then raise exception 'A no longer holds a role of the company A removed'; end if;

  -- a role only the leaving person holds still goes with the company
  insert into public.jobs (id, company_id, title, description, url, external_id) values (jp, f.co_b, 'Only B', 'd', 'https://shared.example/jobs/only-b', 'only-b');

  -- the account goes: the same for another pair
  insert into auth.users (id, email) values (c, 'contract-c@example.invalid'), (d, 'contract-d@example.invalid');
  insert into public.companies (id, user_id, name, domain, career_url, metadata) values
    (co_c, c, 'Shared Co', 'shared.example', 'https://shared.example/careers', '{}'::jsonb),
    (co_d, d, 'Shared Co', 'shared.example', 'https://shared.example/careers', '{}'::jsonb);
  insert into public.jobs (id, company_id, title, description, url, external_id) values (gen_random_uuid(), co_c, 'Shared two', 'd', 'https://shared.example/jobs/acct-1', 'acct-1');
  insert into public.person_roles (user_id, job_id) select d, id from public.jobs where external_id = 'acct-1' on conflict do nothing;
  insert into public.applications (user_id, job_id) select d, id from public.jobs where external_id = 'acct-1';
  delete from public.profiles where id = c;
  if not exists (select 1 from public.jobs where external_id = 'acct-1') then raise exception 'the shared role survives its first follower deleting their account'; end if;
  if not exists (select 1 from public.person_roles pr join public.jobs j on j.id = pr.job_id where j.external_id = 'acct-1' and pr.user_id = d) then raise exception 'D keeps the person_roles row'; end if;
  if not exists (select 1 from public.applications a join public.jobs j on j.id = a.job_id where j.external_id = 'acct-1' and a.user_id = d) then raise exception 'D keeps the application'; end if;
  delete from public.companies where id = f.co_b;
  if exists (select 1 from public.jobs where id = jp) then raise exception 'a role only the leaving person held goes with the company'; end if;
end $$;

rollback;
