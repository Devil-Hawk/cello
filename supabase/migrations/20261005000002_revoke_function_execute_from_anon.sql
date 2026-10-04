-- Functions in public are API endpoints (PostgREST exposes them at
-- /rest/v1/rpc/<name>). Two things made every one of them callable with the
-- public anon key: Postgres grants EXECUTE to PUBLIC on creation, and
-- 20240131000000 added an explicit default grant to anon. Later migrations
-- granted "to authenticated, service_role" and never revoked either, so only
-- prune_stale_rows() was ever closed.
--
-- The decisions below come from reading every .rpc( call in apps/web, every RLS
-- policy and trigger that references a public function, and the function
-- bodies that call each other:
--
--   signed-in browser sessions call: get_client_safe_preferences,
--     set_onboarding_preferences (lib/preferences/client-safe.ts,
--     app/(app)/onboarding/page.tsx)
--   evaluated for the signed-in role: profile_is_demo (apply_credentials RLS
--     policies), is_service_role_request (enforce_demo_profile_lockdown runs
--     as the invoker)
--   service-role client only today, but SECURITY INVOKER so RLS still applies:
--     search_insights, upsert_insight, find_company_merge_candidates,
--     search_kb_chunks, search_jobs_by_title_trgm, search_contacts_by_name_trgm,
--     distill_*. They keep their authenticated grant; the only change is that
--     anon and PUBLIC lose EXECUTE.
--   trigger functions: EXECUTE is checked when a trigger is created, not when
--     it fires, and they are not RPCs, so no API role needs it.
--
-- REVOKE and GRANT are idempotent, so this is safe to re-run.

-- Production was bootstrapped from free_tier_migration.sql, so any function
-- below may be absent there. Every revoke and grant is guarded by
-- to_regprocedure, so a missing function is skipped instead of aborting the
-- whole migration (an unresolvable argument type also yields null).

-- Trigger-only functions: nobody calls these through the API
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.handle_new_user()',
    'public.update_updated_at()',
    'public.log_stage_change()',
    'public.enforce_demo_profile_lockdown()',
    'public.forbid_demo_access_code_issue()',
    'public.forbid_demo_apply_credentials()',
    'public.forbid_demo_graph_threads()',
    'public.forbid_demo_api_tokens()',
    'public.forbid_demo_apply_phase_tokens()'
  ] loop
    if to_regprocedure(sig) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', sig);
    end if;
  end loop;
end
$$;

-- Functions a signed-in session (or an RLS policy / trigger it fires) needs,
-- plus the SECURITY INVOKER search / distill / merge RPCs (RLS applies to the
-- caller). Both groups: anon and PUBLIC lose EXECUTE, authenticated keeps it.
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.get_client_safe_preferences()',
    'public.set_onboarding_preferences(numeric, timestamptz)',
    'public.profile_is_demo(uuid)',
    'public.is_service_role_request()',
    'public.search_insights(uuid, extensions.vector, text[], integer)',
    'public.upsert_insight(uuid, text, text, jsonb, real, text, uuid)',
    'public.find_company_merge_candidates(uuid, real)',
    'public.search_kb_chunks(uuid, text, integer, extensions.vector, uuid)',
    'public.search_jobs_by_title_trgm(uuid, text, integer)',
    'public.search_contacts_by_name_trgm(uuid, text, integer)',
    'public.distill_match_score_by_score_band(uuid)',
    'public.distill_match_score_by_source(uuid)',
    'public.distill_draft_by_seniority(uuid)',
    'public.distill_outreach_by_company(uuid)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute format('revoke execute on function %s from public, anon', sig);
      execute format('grant execute on function %s to authenticated, service_role', sig);
    end if;
  end loop;
end
$$;

-- pg_trgm's set_limit() changes a session-level threshold that the `%`
-- operator in the trgm search RPCs reads, so anon could skew search results on
-- a pooled connection. Revoking only works where postgres owns the extension
-- (hosted Supabase); where another role owns it this is skipped with a notice.
do $$
begin
  if to_regprocedure('public.set_limit(real)') is not null then
    revoke execute on function public.set_limit(real) from public, anon, authenticated;
    grant execute on function public.set_limit(real) to service_role;
  end if;
exception when others then
  raise notice 'set_limit(real) left as is: %', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------
-- Future functions
-- ---------------------------------------------------------------------------
-- 20240131000000 granted anon EXECUTE on every function postgres creates in
-- public. Take that back. PUBLIC's EXECUTE is a built-in default that a
-- schema-scoped statement cannot remove, so it is removed for every function
-- postgres creates, then given back in the one other schema migrations
-- install extensions into (extension functions must stay callable).
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema extensions grant execute on functions to public;
-- service_role is the trusted backend role and kept its default; a new RPC a
-- signed-in session calls needs its own `grant execute ... to authenticated`.
alter default privileges for role postgres in schema public grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- Postconditions
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if bad is not null then
    raise exception 'anon can still execute public functions: %', bad;
  end if;

  -- The grants the app depends on must have survived.
  select string_agg(f, ', ') into bad
  from unnest(array[
    'public.get_client_safe_preferences()',
    'public.set_onboarding_preferences(numeric, timestamptz)',
    'public.profile_is_demo(uuid)',
    'public.is_service_role_request()'
  ]) f
  where to_regprocedure(f) is not null
    and not has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE');
  if bad is not null then
    raise exception 'authenticated lost EXECUTE on: %', bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype = 'trigger'::regtype
    and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if bad is not null then
    raise exception 'authenticated can still execute trigger functions: %', bad;
  end if;
end
$$;
