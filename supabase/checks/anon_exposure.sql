-- Proves the public anon key (the anon role) reaches nothing in public, and
-- that migrations 20261005000001-3 did not take away anything a signed-in
-- session needs. It applies no migration itself: run it on a database that
-- already has them, or inside one transaction after \i-ing them (see the
-- runner below). Everything rolls back, so any database is safe to point it
-- at, but it inserts fixture rows, so never point it at production.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/anon_exposure.sql
--
-- Applying then checking, all rolled back:
--   begin;
--   \i supabase/migrations/20261005000001_drop_unused_security_definer_rpcs.sql
--   \i supabase/migrations/20261005000002_revoke_function_execute_from_anon.sql
--   \i supabase/migrations/20261005000003_close_anon_and_open_jobs_policies.sql
--   \i supabase/checks/anon_exposure.sql
-- (this file's own begin only warns inside an open transaction; its final
-- rollback ends the outer one)

\set ON_ERROR_STOP 1
begin;

-- Runs q as role r and demands SQLSTATE 42501 (privilege or RLS refusal).
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

-- Runs q as role r with a JWT for user uid and demands it succeeds.
create function pg_temp.must_run(r text, uid uuid, q text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', r)::text, true);
  execute format('set local role %I', r);
  execute q;
  reset role;
end $$;

create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as other_user,
       gen_random_uuid() as company_id, gen_random_uuid() as other_company;
grant select on fx to public;

insert into auth.users (id, email)
select user_id, 'anon-check-a@example.invalid' from fx
union all select other_user, 'anon-check-b@example.invalid' from fx;
insert into public.profiles (id, email)
select user_id, 'anon-check-a@example.invalid' from fx
union all select other_user, 'anon-check-b@example.invalid' from fx
on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url)
select company_id, user_id, 'Anon Check A', 'https://example.invalid/a' from fx
union all select other_company, other_user, 'Anon Check B', 'https://example.invalid/b' from fx;

-- ---------------------------------------------------------------------------
-- anon: no table, no sequence, no function
-- ---------------------------------------------------------------------------
select pg_temp.must_be_denied('anon', 'select 1 from public.profiles limit 1');
select pg_temp.must_be_denied('anon', 'select 1 from public.jobs limit 1');
select pg_temp.must_be_denied('anon', 'select 1 from public.companies limit 1');
select pg_temp.must_be_denied('anon', 'select 1 from public.access_codes limit 1');
select pg_temp.must_be_denied('anon',
  format($q$insert into public.jobs (company_id, title, description, url, external_id)
            values (%L, 'poison', 'x', 'https://x', 'anon-check')$q$, (select other_company from fx)));
select pg_temp.must_be_denied('anon', $q$update public.jobs set title = 'x'$q$);
select pg_temp.must_be_denied('anon', 'delete from public.jobs');

select pg_temp.must_be_denied('anon', 'select public.get_client_safe_preferences()');
select pg_temp.must_be_denied('anon', 'select public.set_onboarding_preferences(0.5)');
select pg_temp.must_be_denied('anon', 'select public.profile_is_demo(gen_random_uuid())');
select pg_temp.must_be_denied('anon', 'select public.is_service_role_request()');
select pg_temp.must_be_denied('anon', 'select public.search_insights(gen_random_uuid())');
select pg_temp.must_be_denied('anon', $q$select public.search_jobs_by_title_trgm(gen_random_uuid(), 'x', 5)$q$);
select pg_temp.must_be_denied('anon', $q$select public.search_contacts_by_name_trgm(gen_random_uuid(), 'x', 5)$q$);
select pg_temp.must_be_denied('anon', 'select * from public.find_company_merge_candidates(gen_random_uuid(), 0.6)');
select pg_temp.must_be_denied('anon', 'select * from public.distill_outreach_by_company(gen_random_uuid())');
select pg_temp.must_be_denied('anon', 'select public.prune_stale_rows()');
select pg_temp.must_be_denied('anon', 'select public.handle_new_user()');

-- The three dropped RPCs are gone for everyone.
do $$
begin
  assert not exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('get_application_stats', 'get_upcoming_follow_ups', 'get_ghosted_applications')
  ), 'the unused SECURITY DEFINER RPCs must be dropped';
end $$;

-- graphql_public: anon can still call the entry point, but pg_graphql builds
-- its schema from anon's privileges, so no table or app function may show.
-- (pg_trgm's own functions in public are extension members and stay visible.)
do $$
declare res jsonb;
begin
  if to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') is not null then
    set local role anon;
    select graphql_public.graphql(null, '{ __schema { queryType { fields { name } } } }', null, null) into res;
    reset role;
    assert res::text !~ 'Collection|get_client_safe|set_onboarding|profile_is_demo|is_service_role|search_|upsert_|distill_|find_company',
      'anon graphql must expose no table or app function: ' || res::text;
  end if;
end $$;

-- Catalog-level: no privilege of any kind for anon on a public relation.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
                 else has_table_privilege('anon', c.oid, 'DELETE,TRUNCATE,TRIGGER') end);
  assert bad is null, 'anon holds privileges on: ' || bad;

  assert not exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass and polpermissive and polroles = '{0}'::oid[]
      and (pg_get_expr(polqual, polrelid) = 'true' or pg_get_expr(polwithcheck, polrelid) = 'true')
  ), 'jobs must have no open PUBLIC policy';
end $$;

-- A function or table created from here on must not be anon-reachable either.
create function public.anon_check_future_fn() returns int language sql as 'select 1';
create table public.anon_check_future_tbl (id int);
select pg_temp.must_be_denied('anon', 'select public.anon_check_future_fn()');
select pg_temp.must_be_denied('anon', 'select 1 from public.anon_check_future_tbl');

-- ---------------------------------------------------------------------------
-- authenticated: everything a signed-in session does still works
-- ---------------------------------------------------------------------------
select pg_temp.must_run('authenticated', user_id, 'select public.get_client_safe_preferences()') from fx;
select pg_temp.must_run('authenticated', user_id, 'select public.set_onboarding_preferences(0.5)') from fx;
select pg_temp.must_run('authenticated', user_id,
  format('select public.search_insights(%L)', user_id)) from fx;
select pg_temp.must_run('authenticated', user_id,
  format($q$select public.search_jobs_by_title_trgm(%L, 'x', 5)$q$, user_id)) from fx;
select pg_temp.must_run('authenticated', user_id,
  format($q$select public.search_contacts_by_name_trgm(%L, 'x', 5)$q$, user_id)) from fx;
-- RLS policies that call profile_is_demo() are evaluated as authenticated.
select pg_temp.must_run('authenticated', user_id, 'select count(*) from public.apply_credentials') from fx;
-- A profile write fires update_updated_at and enforce_demo_profile_lockdown
-- (which calls is_service_role_request()) with trigger functions revoked.
select pg_temp.must_run('authenticated', user_id,
  format($q$update public.profiles set full_name = 'Check' where id = %L$q$, user_id)) from fx;
-- Own-company job writes work through the own-company policies alone.
select pg_temp.must_run('authenticated', user_id,
  format($q$insert into public.jobs (company_id, title, description, url, external_id)
            values (%L, 'mine', 'x', 'https://x', 'auth-check')$q$, company_id)) from fx;
select pg_temp.must_run('authenticated', user_id,
  format($q$update public.jobs set title = 'mine 2' where company_id = %L$q$, company_id)) from fx;

-- ...but the open policies are gone: a user cannot write into someone else's
-- company, and cannot move a job there.
do $$
declare f record;
begin
  select * into f from fx;
  perform set_config('request.jwt.claims', json_build_object('sub', f.user_id, 'role', 'authenticated')::text, true);
  perform pg_temp.must_be_denied('authenticated',
    format($q$insert into public.jobs (company_id, title, description, url, external_id)
              values (%L, 'poison', 'x', 'https://x', 'auth-poison')$q$, f.other_company));
  perform pg_temp.must_be_denied('authenticated',
    format($q$update public.jobs set company_id = %L where company_id = %L$q$, f.other_company, f.company_id));
end $$;

-- Signing a user up still creates the profile. The auth service role cannot be
-- assumed from here, but the update above already proved a trigger fires for a
-- role that lacks EXECUTE on its function (update_updated_at).
do $$
declare uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (uid, 'anon-check-signup@example.invalid');
  assert exists (select 1 from public.profiles where id = uid), 'signup trigger must create the profile';
end $$;

do $$ begin raise notice 'ALL ANON EXPOSURE ASSERTIONS PASSED'; end $$;
rollback;
