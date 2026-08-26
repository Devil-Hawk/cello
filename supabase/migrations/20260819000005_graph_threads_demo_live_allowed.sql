-- A live demo may use the product; an expired one may not.
--
-- 20260817000003 installed forbid_demo_graph_threads() with an UNCONDITIONAL
-- deny for any demo profile. That was correct when it shipped: at that point
-- in the port nothing server-side had a reason to write a demo user's
-- graph_threads row. The port then moved every surface (refresh, harness
-- runs, copilot, autopilot) onto graphs, so the unconditional deny quietly
-- locked demo workspaces out of the entire product — found live by the E2E
-- matrix, not by any unit test, because the trigger only exists in Postgres.
--
-- The deny this table actually needs is the EXPIRY line, not the identity
-- line. Writers are service-role only (RLS default-deny covers everyone
-- else), and the one write path — lib/graph/invoke.ts#invokeGraphForUser —
-- already stamps expires_at on demo threads and refuses expired ones
-- app-side. This trigger is the database's own copy of that refusal:
--   - live demo (deadline in the future): allowed, the product works;
--   - expired demo: denied, even if some future code path forgets to check;
--   - malformed demo (flag set but no deadline): denied, fail closed —
--     a demo row without a deadline cannot prove it is still inside its 72h.
--
-- Same function name, so the trigger installed by 20260817000003 picks the
-- new body up without being re-created. SECURITY INVOKER and the empty
-- search_path carry over unchanged, for the same reasons documented there.

do $$
begin
  if to_regclass('public.graph_threads') is null then
    raise exception 'graph_threads missing — apply 20260817000002 first';
  end if;
end
$$;

create or replace function public.forbid_demo_graph_threads()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.profiles p
    where p.id = new.user_id
      and (coalesce(p.is_demo, false) is true or p.demo_expires_at is not null)
      and (p.demo_expires_at is null or p.demo_expires_at <= now())
  ) then
    raise exception 'expired or malformed demo profiles cannot create or modify graph threads'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- Postcondition: the trigger from 20260817000003 still exists and now runs
-- the replaced body (same function OID path — replacing the function is
-- enough; recreating the trigger would only be needed on a rename).
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'forbid_demo_graph_threads_trigger'
      and tgrelid = 'public.graph_threads'::regclass
  ) and not exists (
    select 1 from pg_trigger where tgrelid = 'public.graph_threads'::regclass
      and tgname like '%demo%'
  ) then
    raise exception 'no demo trigger remains on graph_threads — 20260817000003 was never applied?';
  end if;
end
$$;
