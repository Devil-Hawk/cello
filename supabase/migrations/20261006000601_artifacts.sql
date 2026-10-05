-- Agent engine, part 2: artifacts.
--
-- WHY
--   A resume, a cover letter, an outreach email, a dossier, an interview prep
--   kit and a shortlist are things the person keeps, edits and uses, not chat
--   text. Each is one row in `artifacts` with numbered versions in
--   `artifact_versions` (author 'user' or 'cello', so "You edited" and "Cello
--   revised" are facts, not guesses). The agent reaches them through the
--   /artifacts/ path of its file backend (lib/agents/backends.ts), which maps
--   onto these tables.
--
-- Access: the owner can read their own rows. Every write goes through the
-- server (service role), because a version number and its history must stay
-- consistent, and an edit also records a feedback score.

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('resume', 'cover_letter', 'outreach_email', 'dossier', 'interview_prep', 'shortlist')),
  title text not null check (char_length(title) <= 200),
  job_id uuid references public.jobs (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  conversation_id uuid references public.copilot_conversations (id) on delete set null,
  current_version int not null default 1 check (current_version >= 1),
  -- A retried tool call (same thread and tool call id) must not create a second row.
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table if not exists public.artifact_versions (
  artifact_id uuid not null references public.artifacts (id) on delete cascade,
  version int not null check (version >= 1),
  author text not null check (author in ('user', 'cello')),
  content jsonb not null,
  -- The same content as readable markdown: what the agent reads and what is exported.
  content_text text not null,
  note text check (note is null or char_length(note) <= 300),
  -- Reviewer result for a draft: checks, issues, judge verdict.
  review jsonb,
  trace_id text,
  created_at timestamptz not null default now(),
  primary key (artifact_id, version)
);

create index if not exists idx_artifacts_user_updated on public.artifacts (user_id, updated_at desc);
create index if not exists idx_artifacts_user_type on public.artifacts (user_id, type);
create index if not exists idx_artifacts_job on public.artifacts (job_id) where job_id is not null;

alter table public.artifacts enable row level security;
alter table public.artifact_versions enable row level security;

drop policy if exists "own artifacts select" on public.artifacts;
create policy "own artifacts select" on public.artifacts
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own artifact_versions select" on public.artifact_versions;
create policy "own artifact_versions select" on public.artifact_versions
  for select to authenticated
  using (exists (
    select 1 from public.artifacts a
    where a.id = artifact_versions.artifact_id and a.user_id = (select auth.uid())
  ));

revoke all on table public.artifacts from public, anon, authenticated;
revoke all on table public.artifact_versions from public, anon, authenticated;
grant select on table public.artifacts to authenticated;
grant select on table public.artifact_versions to authenticated;
grant all on table public.artifacts to service_role;
grant all on table public.artifact_versions to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.artifacts'::regclass and relrowsecurity)
     or not exists (select 1 from pg_class where oid = 'public.artifact_versions'::regclass and relrowsecurity) then
    raise exception 'row level security is not enabled on the artifact tables';
  end if;
  if has_table_privilege('anon', 'public.artifacts', 'select')
     or has_table_privilege('anon', 'public.artifact_versions', 'select') then
    raise exception 'anon must not read artifacts';
  end if;
end
$$;
