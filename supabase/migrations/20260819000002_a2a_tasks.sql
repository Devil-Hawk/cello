-- a2a_tasks: ownership + status record for A2A protocol tasks.
--
-- WHAT THIS IS FOR
--   Every A2A message/send call that reaches app/api/a2a/route.ts starts one
--   LangGraph thread (via lib/graph/invoke.ts#invokeGraphForUser, surface
--   'run' — binding ruling 7, no second graph door) running a single-agent
--   harness plan (matcher | company_researcher | interview_prep). An A2A
--   task_id is the caller's handle for polling that thread via tasks/get —
--   this table is the ownership + status record on the `public` side, the
--   same role graph_threads plays for thread_id itself (see that migration's
--   header): a2a_tasks.thread_id points at the graph_threads row the actual
--   checkpoint lives under, so a caller's task_id never doubles as a bare
--   capability onto someone else's thread.
--
-- WHY THIS TABLE IS TREATED AS RULING-5 CLASS (b) — RLS + DEMO WIPE, NOT
-- THE PRIVILEGE-BEARING CLASS graph_threads/api_tokens/apply_phase_tokens GET
--   Possessing a task_id alone is not the whole authority the way a bare
--   api_tokens bearer or a graph_threads thread_id is: every read this table
--   backs (app/api/a2a/route.ts's tasks/get) ALSO re-checks
--   `a2a_tasks.user_id = context.user.userId` before it will even resolve
--   the underlying thread_id (see that route's TaskStore.load), so the
--   ownership check lives at the READ site the same way it would for any
--   other user-owned row (interactions, insights, resume_claims). This row
--   is a status record ABOUT a privilege-bearing thread, not the capability
--   itself — the same distinction api_tokens' migration draws between "the
--   credential" and a row that merely references one. Ruling 5 names
--   a2a_tasks explicitly as one of the nine tables and puts it in the
--   wipe-at-expiry class (see lib/access/demo-wipe.ts's own header, which
--   already reserves this table's slot in RULING_5_TABLES).
--
-- WHY NO INSERT/UPDATE POLICY FOR authenticated
--   Every write is app/api/a2a/route.ts's executor / TaskStore, through the
--   service-role admin client (lib/harness/supabase-admin.ts
--   createAdminClient()) — an A2A caller never holds a Supabase session or
--   cookie (see lib/access/tokens.ts's header: "a human signs in with a
--   session and a cookie; an A2A caller has neither"), so there is no
--   authenticated-role writer to police here at all. Same reasoning, same
--   shape, as graph_threads/api_tokens's "no insert/update policy at all"
--   sections — PostgREST refuses both verbs outright with no `using`
--   expression to get wrong.
--
-- WHY SELECT IS AN OWNER POLICY ANYWAY
--   Nothing in the product surfaces a2a_tasks to a signed-in browser today,
--   but this is user data about the caller's own automation activity — the
--   same "an owner may always read their own rows" default every other
--   ruling-5 table in this codebase carries, kept consistent rather than
--   special-cased to "no policy at all" for a table that isn't
--   privilege-bearing.
--
-- PRECONDITION, same reasoning as every migration in this family: plpgsql
-- resolves column references lazily, at first FIRE rather than at apply
-- time, so a missing dependency would apply cleanly here and fail at
-- runtime on every a2a_tasks write instead of failing the migration itself.
do $$
begin
  perform t.thread_id from public.graph_threads t where false;
end
$$;

create table if not exists public.a2a_tasks (
    task_id uuid primary key default gen_random_uuid(),

    -- Deleting the person deletes their A2A task records.
    user_id uuid not null references public.profiles(id) on delete cascade,

    -- The LangGraph thread this task drives (lib/graph/invoke.ts, surface
    -- 'run'). ON DELETE CASCADE: a task record has no independent meaning
    -- once the thread it polls is gone. Not primary-keyed 1:1 with
    -- thread_id (unlike agent_runs.thread_id) because a future revision
    -- could let one task span a resumed thread across retries — today it is
    -- always exactly one thread per task, minted together in the same
    -- request.
    thread_id uuid not null references public.graph_threads(thread_id) on delete cascade,

    -- Closed set: the three read/draft-only agents A2A exposes (spec
    -- Architecture table — "A2A: real endpoint ... matcher +
    -- company_researcher + interview_prep; read/draft-only agents"). CHECK,
    -- not FK, matching the vocabulary-lives-in-TS idiom graph_threads.surface
    -- and api_tokens.scopes already use — lib/a2a/agent.ts owns this list.
    agent text not null check (agent in ('matcher', 'company_researcher', 'interview_prep')),

    -- A2A TaskState, lowercased to this table's own small vocabulary rather
    -- than the protocol's full enum (submitted/working/input-required/
    -- completed/canceled/failed/rejected/auth-required/unknown) — this
    -- product never asks a human a mid-task question over A2A (no
    -- confirm channel exists there, see app/api/a2a/route.ts's header), so
    -- input-required/auth-required/rejected/unknown never apply.
    status text not null default 'submitted'
      check (status in ('submitted', 'working', 'completed', 'failed', 'cancelled')),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_a2a_tasks_user
  on public.a2a_tasks (user_id, created_at desc);

create index if not exists idx_a2a_tasks_thread
  on public.a2a_tasks (thread_id);

comment on table  public.a2a_tasks         is 'Ownership + status record for A2A protocol tasks (ruling 5, class b: RLS + demo wipe-at-expiry). Written ONLY by app/api/a2a/route.ts through the service-role admin client; a2a_tasks.thread_id points at the graph_threads row invokeGraphForUser actually drives.';
comment on column public.a2a_tasks.agent   is 'matcher|company_researcher|interview_prep — the three read/draft-only agents A2A exposes. Vocabulary enforced in TS (lib/a2a/), not by a lookup table.';
comment on column public.a2a_tasks.status  is 'submitted|working|completed|failed|cancelled — this product''s A2A surface never pauses on a human mid-task question, so the protocol''s input-required/auth-required/rejected/unknown states never apply here.';

alter table public.a2a_tasks enable row level security;

-- SELECT only, own rows only — see the file header for why insert/update/
-- delete deliberately have no policy at all rather than a `false` one.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'a2a_tasks'
      and policyname = 'own a2a_tasks select'
  ) then
    create policy "own a2a_tasks select"
      on public.a2a_tasks for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.a2a_tasks'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.a2a_tasks';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'a2a_tasks' and policyname = 'own a2a_tasks select'
  ) then
    raise exception 'public.a2a_tasks is missing its owner select policy';
  end if;
end
$$;
