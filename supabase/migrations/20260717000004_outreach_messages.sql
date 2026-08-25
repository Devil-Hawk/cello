-- Cold outreach: per-user, approve-by-default outreach message queue (additive).
--
-- One row per drafted/sent cold email. Sending always goes through the user's
-- OWN Gmail account (Gmail API). Guardrails enforced in code + schema:
--   - approve-queue by default (status starts 'pending_review')
--   - hard dedupe: at most one INITIAL outreach per (user, contact, job)
--   - a single follow-up (kind='follow_up') chained via parent_id
-- All columns nullable except identity/content essentials so the table is a
-- pure additive extension of the existing schema.

create table if not exists public.outreach_messages (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    contact_id uuid references public.contacts(id) on delete set null,
    job_id uuid references public.jobs(id) on delete set null,
    company_id uuid references public.companies(id) on delete set null,
    run_id uuid references public.agent_runs(id) on delete set null,
    to_email text not null,
    to_name text,
    subject text not null,
    body text not null,
    status text default 'pending_review' not null, -- pending_review | approved | sent | failed | skipped
    kind text default 'initial' not null,          -- initial | follow_up
    parent_id uuid references public.outreach_messages(id) on delete set null,
    gmail_message_id text,
    gmail_thread_id text,
    error text,
    sent_at timestamptz,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- Hard dedupe for INITIAL outreach that targets a specific job. NULL job_id rows
-- are deduped in application code (Postgres treats NULLs as distinct).
create unique index if not exists uniq_outreach_initial_contact_job
    on public.outreach_messages (user_id, contact_id, job_id)
    where kind = 'initial' and contact_id is not null and job_id is not null;

-- At most ONE follow-up per parent message.
create unique index if not exists uniq_outreach_followup_parent
    on public.outreach_messages (parent_id)
    where kind = 'follow_up';

create index if not exists idx_outreach_user_status
    on public.outreach_messages (user_id, status, created_at desc);
create index if not exists idx_outreach_user_sent
    on public.outreach_messages (user_id, sent_at)
    where status = 'sent';

alter table public.outreach_messages enable row level security;

create policy "own outreach select" on public.outreach_messages for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own outreach insert" on public.outreach_messages for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own outreach update" on public.outreach_messages for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own outreach delete" on public.outreach_messages for delete to authenticated
    using ((select auth.uid()) = user_id);
