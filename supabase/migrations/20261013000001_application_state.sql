-- K13: the application as the unit of work, and the log of every move.
--
-- WHY
--   An application is one role for one person, from the moment they or their rule choose to apply
--   until it closes. Two things describe it and they never share a column. STATE is what Cello is
--   doing and who has the ball; it is null on a row Cello is not working on (saved, added by hand,
--   imported, found in mail). STAGE is where the person's search stands; the person owns it.
--
-- WHAT
--   - the pipeline columns on applications, with the indexes the sweeper and the lists read
--   - applications_protect: the person's session cannot set or change a pipeline column. The
--     sweeper (postgres) and the server (service_role) are not caught
--   - the delete policy: a person may delete only a row Cello has not worked on and that never sent
--   - pipeline_events: one row per move, written only by the functions of the next migration. It
--     survives the deletion of its application, so a deleted row cannot be started again
--     unnoticed (the send block reads it)
--   - the T10 check: an event that moves a count cannot be unconfirmed
--   - profiles.last_seen_at, for "since you were last here"
--   - measure_t10()

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.applications
  add column if not exists state text
    check (state in ('preparing', 'needs_you', 'scheduled', 'ready', 'applying', 'sent', 'confirmed', 'not_sent', 'skipped', 'paused')),
  add column if not exists step text,
  add column if not exists needs_reason text
    check (needs_reason in ('approve_resume', 'answer', 'duplicate', 'your_turn', 'check_sent', 'reconnect', 'budget', 'wait_computer')),
  -- for your_turn: {cause, host, auto}
  add column if not exists needs_detail jsonb,
  -- the form's field list, read while preparing
  add column if not exists form_fields jsonb,
  -- one automatic claim per application, ever; never cleared
  add column if not exists auto_attempted_at timestamptz,
  add column if not exists state_before_pause text,
  add column if not exists next_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists lease_holder uuid,
  add column if not exists attempt integer not null default 0,
  add column if not exists dedupe_key text,
  add column if not exists posting_url_hash text,
  add column if not exists cost_usd numeric(10, 4) not null default 0,
  -- references artifacts once that table exists (K8d); see the block below
  add column if not exists resume_artifact_id uuid,
  add column if not exists last_event_at timestamptz,
  add column if not exists interview_at timestamptz,
  add column if not exists closed_reason text
    check (closed_reason in ('rejected', 'withdrew', 'no_reply', 'posting_closed', 'skipped')),
  -- the person's own words about this application; never read as a command
  add column if not exists instruction text check (char_length(instruction) <= 1000),
  -- an application found in email waits for the person's Confirm
  add column if not exists found_state text check (found_state in ('to_confirm', 'confirmed'));

do $$
begin
  if to_regclass('public.artifacts') is not null then
    alter table public.applications
      add constraint applications_resume_artifact_fkey
      foreign key (resume_artifact_id) references public.artifacts (id) on delete set null;
  end if;
end
$$;

create index if not exists applications_due_idx on public.applications (next_at) where state in ('preparing', 'scheduled');
create index if not exists applications_user_state_idx on public.applications (user_id, state);
-- The same posting at one employer is one live application: set only after the duplicate check passes.
create unique index if not exists applications_dedupe_key_idx
  on public.applications (user_id, dedupe_key)
  where state not in ('skipped', 'not_sent') and dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- The person's session cannot move an application
-- ---------------------------------------------------------------------------
-- A security INVOKER trigger on purpose: current_user is the caller's role. The sweeper runs as
-- postgres and the server as service_role, so neither is caught. The person's own columns (stage,
-- notes, applied_at, interview_at, instruction) stay writable.

create or replace function public.applications_protect()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.state is not null or new.step is not null or new.needs_reason is not null
       or new.needs_detail is not null or new.form_fields is not null or new.auto_attempted_at is not null
       or new.state_before_pause is not null or new.next_at is not null or new.heartbeat_at is not null
       or new.lease_until is not null or new.lease_holder is not null or new.attempt <> 0
       or new.dedupe_key is not null or new.posting_url_hash is not null or new.cost_usd <> 0
       or new.resume_artifact_id is not null or new.last_event_at is not null
       or new.closed_reason is not null or new.found_state is not null then
      raise exception 'The pipeline moves an application, not the session.' using errcode = '42501';
    end if;
  elsif (new.state, new.step, new.needs_reason, new.needs_detail, new.form_fields, new.auto_attempted_at,
         new.state_before_pause, new.next_at, new.heartbeat_at, new.lease_until, new.lease_holder, new.attempt,
         new.dedupe_key, new.posting_url_hash, new.cost_usd, new.resume_artifact_id, new.last_event_at,
         new.closed_reason, new.found_state)
        is distinct from
        (old.state, old.step, old.needs_reason, old.needs_detail, old.form_fields, old.auto_attempted_at,
         old.state_before_pause, old.next_at, old.heartbeat_at, old.lease_until, old.lease_holder, old.attempt,
         old.dedupe_key, old.posting_url_hash, old.cost_usd, old.resume_artifact_id, old.last_event_at,
         old.closed_reason, old.found_state) then
    raise exception 'The pipeline moves an application, not the session.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists applications_protect on public.applications;
create trigger applications_protect
  before insert or update on public.applications
  for each row execute function public.applications_protect();

-- ---------------------------------------------------------------------------
-- pipeline_events
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- set null on delete: a sent application's events outlive it
  application_id uuid references public.applications (id) on delete set null,
  job_id uuid,
  posting_url_hash text,
  company_name text,
  kind text not null check (kind in (
    'application.created', 'application.skipped', 'application.paused', 'application.resumed',
    'application.duplicate', 'application.duplicate_override', 'application.send_allowed',
    'step.started', 'step.finished', 'step.failed',
    'question.asked', 'question.answered',
    'approval.requested', 'approval.decided',
    'fill.started', 'fill.auto_started', 'fill.reported', 'fill.blocked',
    'submission.sending', 'submission.sent', 'submission.unconfirmed', 'submission.confirmed',
    'submission.marked', 'submission.retracted',
    'autonomy.changed', 'stage.suggested', 'stage.changed',
    'message.received', 'draft.ready', 'message.sent', 'follow_up.due',
    'task.finished', 'task.missed', 'find.finished',
    'spend.threshold', 'limit.reached', 'connection.lost',
    'pipeline.paused', 'pipeline.resumed', 'summary.built'
  )),
  actor text not null check (actor in ('person', 'schedule', 'rule', 'cello', 'extension', 'email', 'owner')),
  -- the door the actor came through
  channel text check (channel in ('session', 'chat', 'assistant', 'agent', 'routine', 'extension', 'inbox')),
  -- an A2A token's label
  actor_label text,
  -- a declared step or workflow id
  step text,
  sentence text not null check (char_length(sentence) <= 280),
  from_state text,
  to_state text,
  payload jsonb not null default '{}'::jsonb,
  proof jsonb,
  trace_id text,
  cost_usd numeric(10, 4),
  free_model boolean,
  model_calls integer,
  duration_ms integer,
  -- person made it; proven: a code pattern on a message from the verified sender; confirmed: the person
  -- accepted a model's sort; unconfirmed: everything else
  trust text not null default 'proven' check (trust in ('person', 'proven', 'confirmed', 'unconfirmed')),
  origin text not null default 'code' check (origin in ('person', 'code', 'model')),
  prov jsonb,
  -- DKIM domain and result, for mail events
  header_verdict jsonb,
  idempotency_key text not null check (char_length(idempotency_key) <= 200),
  -- clock_timestamp, not now(): two events of one transaction keep their order
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, idempotency_key),
  -- T10: an event that moves a count is never unconfirmed
  constraint pipeline_events_counts_are_trusted
    check (not (kind in ('stage.changed', 'submission.sent', 'submission.marked', 'submission.confirmed') and trust = 'unconfirmed'))
);

create index if not exists pipeline_events_app_idx on public.pipeline_events (application_id, created_at desc);
create index if not exists pipeline_events_user_idx on public.pipeline_events (user_id, created_at desc);
create index if not exists pipeline_events_user_kind_idx on public.pipeline_events (user_id, kind, created_at);
create index if not exists pipeline_events_posting_idx
  on public.pipeline_events (user_id, posting_url_hash, created_at desc) where kind like 'submission.%';

alter table public.pipeline_events enable row level security;
revoke all on public.pipeline_events from public, anon, authenticated;
grant select on public.pipeline_events to authenticated;
grant all on public.pipeline_events to service_role;

drop policy if exists pipeline_events_select on public.pipeline_events;
create policy pipeline_events_select on public.pipeline_events for select to authenticated
  using ((select auth.uid()) = user_id);

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pipeline_events'
     ) then
    alter publication supabase_realtime add table public.pipeline_events;
  end if;
end
$$;

-- A person deletes only an application Cello has not worked on and that never sent.
drop policy if exists "Users can delete own applications" on public.applications;
create policy "Users can delete own applications" on public.applications for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and state is null
    and not exists (
      select 1 from public.pipeline_events e where e.application_id = applications.id and e.kind like 'submission.%'
    )
  );

-- ---------------------------------------------------------------------------
-- profiles.last_seen_at, and T10
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists last_seen_at timestamptz;

create or replace function public.measure_t10()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_unconfirmed integer;
  n_total integer;
begin
  select count(*) filter (where trust = 'unconfirmed'), count(*)
    into n_unconfirmed, n_total
    from public.pipeline_events
   where kind in ('stage.changed', 'submission.sent', 'submission.marked', 'submission.confirmed');
  return query select n_unconfirmed::numeric, n_unconfirmed = 0, n_total,
    format('%s of %s events that move a count are unconfirmed. The table refuses one, so this stays 0 by construction.', n_unconfirmed, n_total);
end;
$$;

revoke all on function public.applications_protect() from public, anon, authenticated;
revoke all on function public.measure_t10() from public, anon, authenticated;
grant execute on function public.measure_t10() to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'applications_protect' and tgrelid = 'public.applications'::regclass) then
    raise exception 'applications_protect is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'pipeline_events_counts_are_trusted') then
    raise exception 'the T10 check is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'pipeline_events_user_id_idempotency_key_key'
  ) then
    raise exception 'the idempotency key must be unique per user';
  end if;
  if has_function_privilege('authenticated', 'public.measure_t10()', 'execute') then
    raise exception 'measure_t10 must not be executable by client roles';
  end if;
end
$$;
