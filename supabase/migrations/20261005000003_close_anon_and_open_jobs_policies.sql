-- Two defects on public.jobs and the tables around it.
--
-- 1. "Service role can insert jobs" / "Service role can update jobs"
--    (20240131000001) have no TO clause, so they apply to PUBLIC: anon and
--    every signed-in user. They are not service-role policies at all, since
--    service_role bypasses RLS. Permissive policies are OR-ed, so they
--    overrode the own-company policies added in 20260717000003: anyone could
--    insert a job under any company_id, and a user could move their job to
--    another user's company.
--
-- 2. 20240131000000 gave anon ALL on every table and sequence, so RLS was the
--    only thing between the public anon key and each table. The app never
--    queries a table as anon: every client that carries the anon key either
--    only calls the auth API (login, the /auth/callback exchange, redeem's
--    verifyOtp) or reads after a session exists (the middleware demo-window
--    read, the server and browser clients behind getUser()). Everything else
--    uses the service key. profiles already had anon revoked (20260803000005)
--    and the app works, which is the same proof for the rest.
--
-- All statements are idempotent and delete no data.

-- The own-company policies must exist before the open ones go, or signed-in
-- job writes would lose their only permissive policy.
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass and polname = 'Users can insert jobs for own companies'
  ) or not exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass and polname = 'Users can update jobs for own companies'
  ) then
    raise exception 'jobs own-company write policies (20260717000003) are missing; refusing to drop the open ones';
  end if;
end
$$;

drop policy if exists "Service role can insert jobs" on public.jobs;
drop policy if exists "Service role can update jobs" on public.jobs;

-- Takes column-level grants with it. USAGE on the schema stays: PostgREST and
-- pg_graphql resolve names through it, and without table privileges there is
-- nothing left for anon to see.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- ---------------------------------------------------------------------------
-- Postconditions
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'));
  if bad is not null then
    raise exception 'anon still has table privileges on: %', bad;
  end if;

  select string_agg(c.relname, ', ') into bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind = 'S'
    and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') end;
  if bad is not null then
    raise exception 'anon still has sequence privileges on: %', bad;
  end if;

  if exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass
      and polpermissive
      and polroles = '{0}'::oid[]
      and (pg_get_expr(polqual, polrelid) = 'true' or pg_get_expr(polwithcheck, polrelid) = 'true')
  ) then
    raise exception 'a permissive jobs policy for PUBLIC with a true predicate remains';
  end if;
end
$$;
