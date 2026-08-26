-- Deny demo-profile sessions mutating graph_threads.
--
-- WHY THIS TABLE NEEDS ITS OWN LOCKDOWN, ON TOP OF RLS
--   20260817000002_graph_threads.sql already ships graph_threads with RLS
--   enabled and NO insert/update/delete policy for `authenticated` — so a
--   demo session holding only the anon key and its own JWT already cannot
--   reach this table's writes over PostgREST; that path is refused before it
--   gets anywhere near a trigger. What RLS cannot defend against is the
--   SERVICE-ROLE path: this codebase legitimately holds a service key
--   (lib/harness/supabase-admin.ts createAdminClient()), which bypasses every
--   RLS policy on every table, and invokeGraphForUser() (binding ruling 7 —
--   the single graph call site, including MCP and A2A) writes graph_threads
--   through exactly that client. A thread_id is a bare capability (see the
--   comment on graph_threads itself): whoever holds one can ask the
--   checkpointer to resume or replay whatever is stored under it, with no
--   further ownership check of its own. Binding ruling 5 puts this table in
--   the same class as api_tokens and apply_phase_tokens for exactly that
--   reason — RLS + trigger deny + route refusal, not the lighter
--   demo-wipe-at-expiry treatment user-data tables get.
--
-- THIS FILE IS SELF-CONTAINED ON PURPOSE
--   20260803000003_demo_profile_lockdown.sql (profiles column lockdown) has
--   NOT been applied to prod yet, so this migration must not assume its
--   is_service_role_request() helper exists. It defines its own is_demo
--   check, scoped to this table, from the SAME two columns
--   (profiles.is_demo, profiles.demo_expires_at) that 20260803000003 and
--   20260803000002 read, applied in whichever order the two migrations land.
--
-- WHY THIS TRIGGER FUNCTION IS SECURITY INVOKER, NOT SECURITY DEFINER
--   20260803000004_apply_credentials.sql's equivalent trigger is SECURITY
--   DEFINER, because it has to answer "is this a demo?" for a caller that
--   might be `authenticated` and unable to see the target profiles row under
--   RLS (an invoker-rights lookup would then read as "not a demo" and fail
--   open). That case cannot happen here: graph_threads has NO
--   insert/update/delete policy for `authenticated` at all, so RLS has
--   already refused every write this trigger could ever see before it fires,
--   for every role except one that bypasses RLS outright. The only writer
--   that ever reaches this function's body is therefore the service role —
--   which bypasses RLS on public.profiles the same way it bypasses RLS on
--   public.graph_threads — so an INVOKER-rights read of profiles already sees
--   every row, and DEFINER buys nothing here. 20260803000003's long comment
--   on why current_user inside a DEFINER context becomes the function's OWNER
--   (turning every caller into a privileged one) is the reason to prefer
--   INVOKER whenever DEFINER is not actually load-bearing, and here it is not.
--
-- WHY THERE IS NO SERVICE-ROLE EXEMPTION
--   Unlike the profiles lockdown (which must let redemption legitimately
--   provision a demo profile through the service key), nothing server-side
--   has any business minting a persistent, resumable LangGraph thread for a
--   demo workspace at this stage of the port — no route in this codebase
--   calls invokeGraphForUser() with a demo user's id yet. The refusal is
--   therefore unconditional, matching 20260803000004_apply_credentials.sql's
--   forbid_demo_apply_credentials(): "nothing has legitimate business writing
--   this for a demo" is the same argument here as it is for a stored board
--   password. If a demo-facing graph surface is added later, the route in
--   front of it is what has to decide how a demo experiences that surface
--   (an ephemeral, unpersisted thread; a hard refusal with a message) — this
--   trigger is the backstop that makes "wire it up and forget the demo case"
--   fail loudly instead of quietly leaking a resumable thread onto a demo
--   workspace.
--
-- PRECONDITION, same reasoning as 20260803000003 and 20260803000004: plpgsql
-- resolves column references lazily, at first FIRE rather than at apply time,
-- so a missing dependency would apply cleanly here and then fail at runtime
-- on every graph_threads write instead of failing the migration itself.
do $$
begin
  if to_regclass('public.graph_threads') is null then
    raise exception 'apply 20260817000002_graph_threads.sql before this migration'
      using errcode = 'undefined_table';
  end if;

  perform p.is_demo, p.demo_expires_at
  from public.profiles p
  where false;
end
$$;

create or replace function public.forbid_demo_graph_threads()
returns trigger
language plpgsql
-- See the file header: the only writer that can ever reach this function's
-- body is the service role (RLS already refuses every other writer before a
-- row would exist to fire the trigger on), and the service role bypasses RLS
-- on public.profiles the same way it bypasses RLS on public.graph_threads —
-- so an invoker-rights read already sees every row and DEFINER is not needed.
security invoker
set search_path = ''
as $$
begin
  -- Same two-signal demo test as guardrails.ts isDemoProfile() and both prior
  -- lockdown migrations: EITHER the flag or a demo deadline makes it a demo,
  -- so a row that shed the flag but kept the deadline is still caught.
  if exists (
    select 1 from public.profiles p
    where p.id = new.user_id
      and (coalesce(p.is_demo, false) is true or p.demo_expires_at is not null)
  ) then
    raise exception 'demo profiles cannot create or modify graph threads'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists forbid_demo_graph_threads on public.graph_threads;
create trigger forbid_demo_graph_threads
  before insert or update on public.graph_threads
  for each row
  execute function public.forbid_demo_graph_threads();

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
-- "Applied, but the guard is not attached" looks exactly like success and
-- would leave a capability-bearing table with no demo fence beyond RLS.
do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.graph_threads'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.graph_threads';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.graph_threads'::regclass
      and tgname = 'forbid_demo_graph_threads'
      and not tgisinternal
  ) then
    raise exception 'forbid_demo_graph_threads is not attached to public.graph_threads';
  end if;
end
$$;
