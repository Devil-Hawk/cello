-- interactions — the unified per-company/contact timeline (STEP 5 of the
-- langgraph port design doc). One append-only projection row per
-- source-store event: an outreach send, a Gmail-detected stage transition,
-- a completed follow-up reminder, a submitted application. "Everything that
-- happened with a company is one query now" instead of four separate reads
-- (activities filtered by application_id, outreach_messages, follow_ups,
-- stage history buried in activities.metadata).
--
-- WHY A SEPARATE TABLE, NOT A VIEW OVER THE SOURCE TABLES
--   The source tables key on different things (activities on
--   application_id only; outreach_messages/contacts on contact_id) and none
--   of them carry a resolved, MERGE-AWARE company_id — that resolution
--   (lib/entities/companies.ts#resolveCompanyId) happens once, at write
--   time, in lib/interactions/store.ts#recordInteraction, so every reader
--   queries one flat table instead of re-deriving company identity per row.
--
-- WHY (ref_table, ref_id, kind) IS UNIQUE, NOT ref_id ALONE
--   A single source row can plausibly produce more than one projection kind
--   over its lifetime in a future stage (e.g. an outreach_messages row could
--   one day carry both 'outreach_sent' and, on stage 3, 'reply_received');
--   ref_id alone would collide across kinds. (ref_table, ref_id, kind)
--   together is exactly "this source event, this projection" — recordInteraction
--   upserts on it, so a retried request or a replayed graph task updates the
--   same row instead of duplicating the timeline.
--
-- reply_received is DEFERRED to stage 3 (ruling 4 gives the reply columns +
-- Gmail bridge to the rewards area) — listed in the CHECK constraint so that
-- stage's writer needs no schema change, but nothing before stage 3 writes it.
--
-- Demo-lockdown class: user-data table (ruling 5) — RLS scoped to the owner
-- below; the demo wipe-at-expiry sweep lives in
-- apps/web/lib/access/demo-wipe.ts, run as one more pass of the existing
-- scheduled tick (apps/web/app/api/harness/cron/route.ts, invoked daily by
-- .github/workflows/harness-cron.yml) rather than a per-migration mechanism,
-- so it is not duplicated here.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

create table if not exists public.interactions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    company_id uuid references public.companies(id) on delete set null,
    contact_id uuid references public.contacts(id) on delete set null,
    job_id uuid references public.jobs(id) on delete set null,
    application_id uuid references public.applications(id) on delete set null,
    kind text not null check (kind in (
        'outreach_sent',
        'reply_received',
        'interview',
        'stage_change',
        'follow_up_done',
        'note',
        'application_submitted',
        'autopilot_action'
    )),
    occurred_at timestamptz not null,
    title text,
    body text,
    ref_table text not null,
    ref_id uuid not null,
    metadata jsonb,
    created_at timestamptz not null default now()
);

comment on table public.interactions is 'Append-only projection unifying outreach/stage/follow-up/application events into one per-user timeline. Written ONLY through lib/interactions/store.ts#recordInteraction — see that file for the company_id resolution contract.';
comment on column public.interactions.ref_table is 'Source table this row was projected from (outreach_messages, activities, follow_ups, application_receipts, ...).';
comment on column public.interactions.ref_id is 'Source row id within ref_table. (ref_table, ref_id, kind) is the idempotency key recordInteraction upserts on.';

create unique index if not exists uniq_interactions_ref
    on public.interactions (ref_table, ref_id, kind);

create index if not exists idx_interactions_user_company
    on public.interactions (user_id, company_id, occurred_at desc);

create index if not exists idx_interactions_user_contact
    on public.interactions (user_id, contact_id, occurred_at desc);

alter table public.interactions enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'interactions'
          and policyname = 'own interactions select'
    ) then
        create policy "own interactions select"
            on public.interactions for select
            to authenticated
            using ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'interactions'
          and policyname = 'own interactions insert'
    ) then
        create policy "own interactions insert"
            on public.interactions for insert
            to authenticated
            with check ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'interactions'
          and policyname = 'own interactions update'
    ) then
        create policy "own interactions update"
            on public.interactions for update
            to authenticated
            using ((select auth.uid()) = user_id)
            with check ((select auth.uid()) = user_id);
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'interactions'
          and policyname = 'own interactions delete'
    ) then
        create policy "own interactions delete"
            on public.interactions for delete
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
        where oid = 'public.interactions'::regclass and relrowsecurity
    ) then
        raise exception 'row level security is not enabled on public.interactions';
    end if;

    if (
        select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'interactions'
    ) < 4 then
        raise exception 'public.interactions is missing one or more of its 4 RLS policies';
    end if;
end
$$;

notify pgrst, 'reload schema';
