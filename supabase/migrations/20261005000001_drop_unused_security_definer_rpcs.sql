-- Three SECURITY DEFINER functions from the first schema read any user's
-- pipeline by a caller-supplied UUID: they filter on user_uuid, never on
-- auth.uid(), and the default grants (20240131000000) plus Postgres' implicit
-- PUBLIC EXECUTE made them callable at /rest/v1/rpc/<name> with only the
-- public anon key. Nothing in apps/, packages/, scripts/ or .github calls
-- them (a repo-wide grep finds only their definitions), so they are dropped
-- instead of locked down. No data lives in a function; DROP IF EXISTS makes
-- this safe to re-run and safe on a database that never had them.
drop function if exists public.get_application_stats(uuid);
drop function if exists public.get_upcoming_follow_ups(uuid, integer);
drop function if exists public.get_ghosted_applications(uuid, integer);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_application_stats', 'get_upcoming_follow_ups', 'get_ghosted_applications')
  ) then
    raise exception 'an unused SECURITY DEFINER RPC still exists in public';
  end if;
end
$$;
