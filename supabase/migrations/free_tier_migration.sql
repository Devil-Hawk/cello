-- Cello Database Schema (Free Tier Compatible)
-- Run this in Supabase SQL Editor

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- Profiles table (extends Supabase auth.users)
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text not null,
    full_name text,
    avatar_url text,
    resume_text text,
    preferences jsonb default '{}',
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- Companies table (user's tracked companies)
create table public.companies (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    name text not null,
    domain text,
    logo_url text,
    career_url text not null,
    scrape_frequency integer default 15 not null,
    last_scraped_at timestamptz,
    is_dream_company boolean default false not null,
    notes text,
    created_at timestamptz default now() not null
);

-- Jobs table (discovered job listings)
create table public.jobs (
    id uuid default uuid_generate_v4() primary key,
    company_id uuid references public.companies(id) on delete cascade not null,
    title text not null,
    description text not null,
    url text not null,
    location text,
    salary_range text,
    job_type text,
    posted_at timestamptz,
    discovered_at timestamptz default now() not null,
    match_score integer,
    match_details jsonb,
    is_new boolean default true not null,
    external_id text,
    constraint unique_job_per_company unique (company_id, external_id)
);

-- Applications table
create table public.applications (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    job_id uuid references public.jobs(id) on delete cascade not null,
    stage text default 'discovered' not null,
    applied_at timestamptz,
    source text,
    notes text,
    resume_version text,
    cover_letter text,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    constraint unique_application_per_job unique (user_id, job_id)
);

-- Activities table
create table public.activities (
    id uuid default uuid_generate_v4() primary key,
    application_id uuid references public.applications(id) on delete cascade not null,
    type text not null,
    title text not null,
    description text,
    metadata jsonb,
    occurred_at timestamptz default now() not null,
    created_at timestamptz default now() not null
);

-- Contacts table
create table public.contacts (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    company_id uuid references public.companies(id) on delete set null,
    name text not null,
    email text,
    linkedin_url text,
    title text,
    relationship text,
    last_contact_at timestamptz,
    notes text,
    created_at timestamptz default now() not null
);

-- Follow-ups table
create table public.follow_ups (
    id uuid default uuid_generate_v4() primary key,
    contact_id uuid references public.contacts(id) on delete cascade,
    application_id uuid references public.applications(id) on delete cascade,
    due_date timestamptz not null,
    note text not null,
    is_completed boolean default false not null,
    completed_at timestamptz,
    created_at timestamptz default now() not null,
    constraint follow_up_has_target check (contact_id is not null or application_id is not null)
);

-- Indexes
create index idx_companies_user_id on public.companies(user_id);
create index idx_jobs_company_id on public.jobs(company_id);
create index idx_jobs_discovered_at on public.jobs(discovered_at desc);
create index idx_applications_user_id on public.applications(user_id);
create index idx_applications_stage on public.applications(stage);
create index idx_activities_application_id on public.activities(application_id);
create index idx_contacts_user_id on public.contacts(user_id);
create index idx_follow_ups_due_date on public.follow_ups(due_date) where not is_completed;

-- Enable Row Level Security
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.applications enable row level security;
alter table public.activities enable row level security;
alter table public.contacts enable row level security;
alter table public.follow_ups enable row level security;

-- RLS Policies
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

create policy "Users can view own companies" on public.companies for select using (auth.uid() = user_id);
create policy "Users can create companies" on public.companies for insert with check (auth.uid() = user_id);
create policy "Users can update own companies" on public.companies for update using (auth.uid() = user_id);
create policy "Users can delete own companies" on public.companies for delete using (auth.uid() = user_id);

create policy "Users can view jobs for own companies" on public.jobs for select
    using (exists (select 1 from public.companies where companies.id = jobs.company_id and companies.user_id = auth.uid()));
create policy "Service role can insert jobs" on public.jobs for insert with check (true);
create policy "Service role can update jobs" on public.jobs for update using (true);

create policy "Users can view own applications" on public.applications for select using (auth.uid() = user_id);
create policy "Users can create applications" on public.applications for insert with check (auth.uid() = user_id);
create policy "Users can update own applications" on public.applications for update using (auth.uid() = user_id);
create policy "Users can delete own applications" on public.applications for delete using (auth.uid() = user_id);

create policy "Users can view own activities" on public.activities for select
    using (exists (select 1 from public.applications where applications.id = activities.application_id and applications.user_id = auth.uid()));
create policy "Users can create activities for own applications" on public.activities for insert
    with check (exists (select 1 from public.applications where applications.id = application_id and applications.user_id = auth.uid()));

create policy "Users can view own contacts" on public.contacts for select using (auth.uid() = user_id);
create policy "Users can create contacts" on public.contacts for insert with check (auth.uid() = user_id);
create policy "Users can update own contacts" on public.contacts for update using (auth.uid() = user_id);
create policy "Users can delete own contacts" on public.contacts for delete using (auth.uid() = user_id);

create policy "Users can view own follow-ups" on public.follow_ups for select
    using ((contact_id is not null and exists (select 1 from public.contacts where contacts.id = follow_ups.contact_id and contacts.user_id = auth.uid()))
        or (application_id is not null and exists (select 1 from public.applications where applications.id = follow_ups.application_id and applications.user_id = auth.uid())));
create policy "Users can create follow-ups" on public.follow_ups for insert
    with check ((contact_id is not null and exists (select 1 from public.contacts where contacts.id = contact_id and contacts.user_id = auth.uid()))
        or (application_id is not null and exists (select 1 from public.applications where applications.id = application_id and applications.user_id = auth.uid())));
create policy "Users can update own follow-ups" on public.follow_ups for update
    using ((contact_id is not null and exists (select 1 from public.contacts where contacts.id = follow_ups.contact_id and contacts.user_id = auth.uid()))
        or (application_id is not null and exists (select 1 from public.applications where applications.id = follow_ups.application_id and applications.user_id = auth.uid())));

-- Functions and Triggers
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.profiles (id, email, full_name, avatar_url)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), new.raw_user_meta_data->>'avatar_url');
    return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.update_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.update_updated_at();
create trigger applications_updated_at before update on public.applications for each row execute procedure public.update_updated_at();
