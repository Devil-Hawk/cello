-- Agentic harness: run queue, step journal, application drafts (additive)

create table if not exists public.agent_runs (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    goal text not null,
    status text default 'queued' not null, -- queued | planning | running | completed | failed | cancelled
    plan jsonb,                            -- planner-produced DAG
    budget_tokens integer default 200000 not null,
    spent_tokens integer default 0 not null,
    result jsonb,
    error text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz default now() not null
);

create table if not exists public.agent_steps (
    id uuid default uuid_generate_v4() primary key,
    run_id uuid references public.agent_runs(id) on delete cascade not null,
    agent_type text not null,              -- planner | sourcer | matcher | enricher | cv_tailor | applier | verifier | follow_upper
    label text not null,
    status text default 'pending' not null, -- pending | running | completed | failed | skipped
    input jsonb,
    output jsonb,
    tokens_used integer default 0 not null,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz default now() not null
);

create table if not exists public.application_drafts (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    job_id uuid references public.jobs(id) on delete cascade not null,
    run_id uuid references public.agent_runs(id) on delete set null,
    resume_summary text,
    cover_letter text,
    answers jsonb,                         -- prefilled ATS question answers
    status text default 'pending_review' not null, -- pending_review | approved | submitted | rejected | failed
    submitted_at timestamptz,
    submission_ref text,                   -- ATS confirmation id
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    constraint unique_draft_per_job unique (user_id, job_id)
);

create index if not exists idx_agent_runs_user on public.agent_runs(user_id, created_at desc);
create index if not exists idx_agent_steps_run on public.agent_steps(run_id, created_at);
create index if not exists idx_app_drafts_user on public.application_drafts(user_id, status);

alter table public.agent_runs enable row level security;
alter table public.agent_steps enable row level security;
alter table public.application_drafts enable row level security;

create policy "own runs select" on public.agent_runs for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own runs insert" on public.agent_runs for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own runs update" on public.agent_runs for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own steps select" on public.agent_steps for select to authenticated
    using (exists (select 1 from public.agent_runs r where r.id = run_id and r.user_id = (select auth.uid())));

create policy "own drafts select" on public.application_drafts for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own drafts insert" on public.application_drafts for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own drafts update" on public.application_drafts for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own drafts delete" on public.application_drafts for delete to authenticated
    using ((select auth.uid()) = user_id);
