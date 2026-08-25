-- Copilot conversation persistence.
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   Every statement is `create table if not exists` and policies are guarded
--   by a do-block that checks pg_policies first (there is no `create policy
--   if not exists` in Postgres 15), exactly like
--   supabase/migrations/20260724000002_phaseB.sql. Nothing here drops,
--   renames, or rewrites an existing object. Safe to re-run.
--
-- WHAT IT ADDS
--   1. copilot_conversations — one row per chat thread in the /copilot page.
--      `model` / `enabled_agents` are the per-conversation overrides the
--      client can pass on POST /api/copilot (model must be one of
--      lib/models.ts ALLOWED_MODELS; enabled_agents a subset of
--      lib/harness/schemas.ts STEP_AGENT_TYPES — both vocabularies enforced in
--      TS, not by a CHECK, matching the rest of the harness tables).
--   2. copilot_messages — the turn-by-turn transcript. `trace` carries the
--      tool-call trace for assistant turns (array of {tool,args,thought,
--      observation,ok,status}); NULL for user turns.
--
-- RLS: identical per-user CRUD pattern to the phaseB tables (own select /
-- insert / update / delete via auth.uid() = user_id), service_role bypasses
-- RLS entirely (route.ts always writes through the service-role admin client,
-- same as every other harness table) so no explicit service_role policy is
-- required — the do-block below mirrors phaseB's shape for consistency and
-- so `authenticated` clients (e.g. the Supabase JS client running as a signed
-- in user, if ever used directly) work correctly too.

create table if not exists public.copilot_conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,

    title text not null default 'New chat',

    -- Per-conversation LLM model override (lib/models.ts ALLOWED_MODELS).
    -- NULL means "use the request's model, or the user's default preference".
    model text,

    -- Per-conversation agent gating: subset of STEP_AGENT_TYPES enabled for
    -- this conversation's tool calls. NULL means "all agents enabled".
    enabled_agents jsonb,

    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

create index if not exists idx_copilot_conversations_user_updated
  on public.copilot_conversations (user_id, updated_at desc);

comment on table  public.copilot_conversations               is 'One row per Cello Copilot chat thread.';
comment on column public.copilot_conversations.model         is 'Per-conversation model override (lib/models.ts ALLOWED_MODELS). NULL = use request/user default.';
comment on column public.copilot_conversations.enabled_agents is 'JSON array subset of STEP_AGENT_TYPES enabled for this conversation. NULL = all enabled. Vocabulary enforced in TS.';

alter table public.copilot_conversations enable row level security;


create table if not exists public.copilot_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.copilot_conversations(id) on delete cascade,

    -- Denormalized owner so RLS and the recent-history query need no join.
    user_id uuid not null references auth.users(id) on delete cascade,

    role text not null check (role in ('user', 'assistant')),
    content text not null,

    -- Full tool-call trace for an assistant turn: array of
    -- {tool,args,thought,observation,ok,status}. NULL for user turns.
    trace jsonb,

    created_at timestamptz default now() not null
);

create index if not exists idx_copilot_messages_conversation_created
  on public.copilot_messages (conversation_id, created_at);

comment on table  public.copilot_messages       is 'Turn-by-turn transcript for a copilot_conversations thread.';
comment on column public.copilot_messages.trace is 'Assistant-turn tool trace: [{tool,args,thought,observation,ok,status}]. NULL for user turns.';

alter table public.copilot_messages enable row level security;


-- ============================================================================
-- RLS policies — full per-user CRUD, mirroring phaseB's do-block pattern.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['copilot_conversations', 'copilot_messages']
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s select', t)
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
        format('own %s select', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s insert', t)
    ) then
      execute format(
        'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
        format('own %s insert', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s update', t)
    ) then
      execute format(
        'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
        format('own %s update', t), t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = format('own %s delete', t)
    ) then
      execute format(
        'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
        format('own %s delete', t), t
      );
    end if;
  end loop;
end
$$;

-- Make the new tables visible to PostgREST without waiting for its periodic
-- schema-cache refresh.
notify pgrst, 'reload schema';
