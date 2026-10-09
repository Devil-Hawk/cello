-- Agent engine, part 5: approvals.
--
-- WHY
--   No agent can send an email or submit an application. When Cello wants to,
--   it writes one row here: the exact artifact version, and a hash of the
--   payload. "Needs you" lists the pending rows. The person's click runs plain
--   code (lib/agents/approvals.ts decideApproval): the send or the submit,
--   idempotent by approval id, with its outcome. Approvals are rows, not parked
--   threads, so they never disappear with an old checkpoint.
--
--   The domain row (an outreach_messages or application_drafts row in
--   pending_review) is created in the same call, so the existing send and
--   submit paths stay the only ones.
--
-- Access: the owner reads their own approvals (and Realtime delivers them).
-- All writes go through the server so a status can only move forward through
-- the single conditional update that executes it.

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.copilot_conversations (id) on delete set null,
  thread_id uuid references public.graph_threads (thread_id) on delete set null,
  scheduled_task_id uuid references public.scheduled_tasks (id) on delete set null,
  action text not null check (action in ('send_email', 'submit_application')),
  artifact_id uuid not null references public.artifacts (id) on delete cascade,
  artifact_version int not null check (artifact_version >= 1),
  -- sha256 of the exact payload the person is approving. A later edit changes it,
  -- and approving then needs the new hash.
  payload_hash text not null check (char_length(payload_hash) = 64),
  target_table text not null check (target_table in ('outreach_messages', 'application_drafts')),
  target_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'executing', 'done', 'failed', 'skipped')),
  decided_by text check (decided_by in ('user', 'rule')),
  decided_at timestamptz,
  executed_at timestamptz,
  -- {what, when, artifact_version, approval_id, result}
  outcome jsonb,
  error text check (error is null or char_length(error) <= 500),
  -- Set once the result has been told to the conversation it came from.
  posted_at timestamptz,
  idempotency_key text not null check (char_length(idempotency_key) <= 160),
  trace_id text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists idx_approvals_pending
  on public.approvals (user_id, created_at desc) where status = 'pending';
create index if not exists idx_approvals_unposted
  on public.approvals (thread_id) where posted_at is null and status in ('done', 'failed', 'skipped');

alter table public.approvals enable row level security;

drop policy if exists "own approvals select" on public.approvals;
create policy "own approvals select" on public.approvals
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.approvals from public, anon, authenticated;
grant select on table public.approvals to authenticated;
grant all on table public.approvals to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'approvals'
  ) then
    alter publication supabase_realtime add table public.approvals;
  end if;
end
$$;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.approvals'::regclass and relrowsecurity) then
    raise exception 'row level security is not enabled on approvals';
  end if;
  if has_table_privilege('anon', 'public.approvals', 'select') then
    raise exception 'anon must not read approvals';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'approvals'
  ) then
    raise exception 'approvals is not in the realtime publication';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approvals' and column_name = 'outcome') then
    raise exception 'approvals.outcome is missing';
  end if;
  -- Taste is read from role_reactions; there is no second store for it.
  if to_regclass('public.taste_statements') is not null then
    raise exception 'taste_statements must not exist';
  end if;
end
$$;
