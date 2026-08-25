-- Phase 3: interview prep kits + company research dossiers (additive)

create table if not exists public.interview_kits (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    job_id uuid references public.jobs(id) on delete cascade not null,
    company_id uuid references public.companies(id) on delete set null,
    questions jsonb,          -- [{category, question, guidance, sampleAnswer}]
    prep_notes text,
    star_stories jsonb,       -- tailored STAR stories drawn from resume
    status text default 'ready' not null, -- ready | practiced
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    constraint unique_kit_per_job unique (user_id, job_id)
);

create table if not exists public.company_dossiers (
    id uuid default uuid_generate_v4() primary key,
    company_id uuid references public.companies(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    summary text,
    signals jsonb,            -- {funding, headcountTrend, news[], culture, techStack[]}
    comp_intel jsonb,         -- {rangeLow, rangeHigh, source, confidence}
    sponsors_visa text,       -- likely | unlikely | unknown (from public signals)
    sources jsonb,            -- [{title, url}]
    refreshed_at timestamptz default now() not null,
    created_at timestamptz default now() not null,
    constraint unique_dossier_per_company unique (company_id)
);

create index if not exists idx_interview_kits_user on public.interview_kits(user_id, created_at desc);
create index if not exists idx_company_dossiers_company on public.company_dossiers(company_id);

alter table public.interview_kits enable row level security;
alter table public.company_dossiers enable row level security;

create policy "own kits select" on public.interview_kits for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own kits insert" on public.interview_kits for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own kits update" on public.interview_kits for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own kits delete" on public.interview_kits for delete to authenticated
    using ((select auth.uid()) = user_id);

create policy "own dossiers select" on public.company_dossiers for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own dossiers insert" on public.company_dossiers for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own dossiers update" on public.company_dossiers for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
