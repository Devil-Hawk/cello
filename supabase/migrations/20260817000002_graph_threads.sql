-- graph_threads: ownership + lookup for LangGraph checkpointer threads.
--
-- WHAT THIS IS FOR
--   LangGraph's checkpointer (see 20260817000001_langgraph_schema.sql) keys
--   every checkpoint by an opaque `thread_id` string inside the `langgraph`
--   schema, which knows nothing about Cello users, runs or conversations. This
--   table is the ownership record on the `public` side: one row per thread,
--   who it belongs to, which surface created it (run / copilot / refresh /
--   autopilot), and which domain row it corresponds to (agent_runs.id or
--   copilot_conversations.id, added as thread_id columns on those tables by
--   20260817000004_runs_thread_link.sql). invokeGraphForUser() is the single
--   call site (binding ruling 7) and is the only thing that ever mints a row
--   here.
--
-- WHY THIS TABLE IS TREATED AS PRIVILEGE-BEARING (binding ruling 5, class 1)
--   A thread_id is a capability: LangGraph's `getState`/`updateState`/resume
--   APIs take nothing but a thread_id and will happily replay or resume
--   WHATEVER checkpoint is stored under it, with no further ownership check
--   of their own — that check has to live here, in the table that says which
--   user a thread_id belongs to. Same shape as api_tokens and
--   apply_phase_tokens: possession of the identifier is the whole authority,
--   so this table gets the credential-bearing treatment (RLS + trigger deny
--   for demo profiles + route refusal), not the lighter demo-wipe-at-expiry
--   treatment user-data tables get.
--
-- WHY NO INSERT/UPDATE/DELETE POLICY FOR authenticated
--   Every write to this table is invokeGraphForUser() minting or touching a
--   thread record server-side with the service-role admin client
--   (lib/harness/supabase-admin.ts createAdminClient()), which bypasses RLS
--   entirely — policies are irrelevant to that path. What RLS has to prevent
--   is a signed-in browser, holding only the anon key and its own JWT,
--   reaching this table directly over PostgREST. With no authenticated
--   insert/update/delete policy, PostgREST refuses every one of those verbs
--   outright (default-deny: a table with RLS enabled and no policy for a verb
--   allows nothing under that verb for that role) — there is no `using`
--   expression to get wrong. SELECT is allowed, scoped to the caller's own
--   rows, because the UI legitimately needs to know which thread backs the
--   run or conversation it is looking at.
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   `create table if not exists`, `create index if not exists`, and the
--   policy is guarded by the same do-block-over-pg_policies pattern
--   20260724000002_phaseB.sql uses (there is no `create policy if not
--   exists` in Postgres 15). Nothing here drops, renames or rewrites an
--   existing object.

create table if not exists public.graph_threads (
    thread_id uuid primary key default gen_random_uuid(),

    -- Deleting the person deletes their threads; nothing needs to survive
    -- that, the checkpointer rows under `langgraph` are keyed by thread_id
    -- and become orphaned-but-inert once nothing points at them.
    user_id uuid not null references auth.users(id) on delete cascade,

    -- Which invocation surface minted this thread. No FK to a lookup table —
    -- the vocabulary is small, closed, and lives in lib/graph/ alongside the
    -- graph definitions themselves, matching the CHECK-not-FK idiom
    -- application_drafts.status already uses in this codebase.
    surface text not null check (surface in ('run', 'copilot', 'refresh', 'autopilot')),

    -- Back-pointer to the domain row this thread serves, when one exists.
    -- Nullable and un-FK'd here on purpose: the FK lives on the OTHER side
    -- (agent_runs.thread_id / copilot_conversations.thread_id, added by
    -- 20260817000004_runs_thread_link.sql) so that deleting a run or
    -- conversation does not have to know about this table, and a thread
    -- created before its domain row is committed (the graph starts before
    -- the run row exists) is never a dangling reference here.
    run_id uuid,
    conversation_id uuid,

    created_at timestamptz not null default now(),

    -- Stamped on every resume/poll so a stuck or abandoned thread is
    -- distinguishable from an active one without touching the checkpointer
    -- schema.
    last_invoked_at timestamptz,

    -- NULL = no expiry (the common case). Demo threads get a value here so
    -- the demo wipe-at-expiry job (see the demo lockdown migration below)
    -- has something to key off; ordinary threads are not expected to set it
    -- today.
    expires_at timestamptz
);

create index if not exists idx_graph_threads_user
  on public.graph_threads (user_id, created_at desc);

create index if not exists idx_graph_threads_run
  on public.graph_threads (run_id) where run_id is not null;

create index if not exists idx_graph_threads_conversation
  on public.graph_threads (conversation_id) where conversation_id is not null;

comment on table  public.graph_threads               is 'Ownership + lookup for LangGraph checkpointer threads. Privilege-bearing (binding ruling 5): a thread_id is a bare capability, so this table is RLS + trigger-deny + route-refusal, not demo-wipe-at-expiry. Written ONLY by invokeGraphForUser() (lib/graph/*) with the service-role admin client.';
comment on column public.graph_threads.surface       is 'run|copilot|refresh|autopilot. Vocabulary enforced in TS (lib/graph/), not by a lookup table.';
comment on column public.graph_threads.run_id        is 'Back-pointer to agent_runs.id when this thread serves a run. The FK lives on agent_runs.thread_id, not here.';
comment on column public.graph_threads.conversation_id is 'Back-pointer to copilot_conversations.id when this thread serves a copilot chat. The FK lives on copilot_conversations.thread_id, not here.';
comment on column public.graph_threads.expires_at    is 'NULL = no expiry. Demo threads carry a value so the demo wipe-at-expiry path has something to key off.';

alter table public.graph_threads enable row level security;

-- SELECT only, own rows only — see the file header for why insert/update/
-- delete deliberately have no policy at all rather than a `false` one.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'graph_threads'
      and policyname = 'own graph_threads select'
  ) then
    create policy "own graph_threads select"
      on public.graph_threads for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;
