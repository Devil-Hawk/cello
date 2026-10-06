-- "Suggested for you": companies a person does not watch yet, ranked by real
-- hiring evidence, plus the schedule that says when each person's list is next
-- rebuilt.
--
-- company_suggestions: one row per (user, company). Each row stores the tier
-- and rank it was given, the one-line reason, the source link (a live board,
-- a posting or a thread) and a snapshot of the signals behind it. A row the
-- person acted on (added or dismissed) is never rewritten by a refresh, so it
-- doubles as the feedback log for later ranking.
--
-- company_suggestion_state: one row per user. next_refresh_at is set by the
-- daily cron after each build, so a page load never computes anything.
--
-- Writes happen only through the service-role client in server code, and every
-- write filters on user_id. The owner can read their own rows through RLS and
-- nothing else; there is no insert, update or delete policy and nothing is
-- granted to anon.

create table if not exists public.company_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_key text not null check (char_length(company_key) <= 300),
  name text not null check (char_length(name) between 1 and 200),
  domain text,
  logo_url text,
  tier smallint not null check (tier between 1 and 4),
  rank smallint not null check (rank >= 1),
  reason text not null check (char_length(reason) between 1 and 200),
  source_url text not null check (source_url ~ '^https?://'),
  source_label text not null check (char_length(source_label) <= 60),
  signals jsonb not null default '[]',
  ats jsonb,
  status text not null default 'open' check (status in ('open', 'added', 'dismissed')),
  dismiss_reason text check (dismiss_reason in ('not_my_field', 'location', 'company_size', 'know_them', 'other')),
  company_id uuid references public.companies(id) on delete set null,
  computed_at timestamptz not null default now(),
  acted_at timestamptz,
  unique (user_id, company_key)
);

create index if not exists idx_company_suggestions_user_status_rank
  on public.company_suggestions (user_id, status, rank);

create table if not exists public.company_suggestion_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null check (status in ('ok', 'partial', 'failed', 'needs_targeting')),
  computed_at timestamptz,
  next_refresh_at timestamptz not null default now(),
  counts jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.company_suggestions enable row level security;
alter table public.company_suggestion_state enable row level security;

create policy "own company_suggestions select" on public.company_suggestions
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "own company_suggestion_state select" on public.company_suggestion_state
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.company_suggestions from public, anon, authenticated;
revoke all on public.company_suggestion_state from public, anon, authenticated;
grant select on public.company_suggestions to authenticated;
grant select on public.company_suggestion_state to authenticated;
grant all on public.company_suggestions to service_role;
grant all on public.company_suggestion_state to service_role;
