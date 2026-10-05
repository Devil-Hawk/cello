-- What people do with Cello's output, queued so it can be scored in Langfuse.
--
-- Approvals, edits, skips, applications, replies and interviews happen in many
-- places: the browser changes a pipeline stage directly, routes approve drafts,
-- the mail check sees a reply days later. Triggers on the rows themselves catch
-- all of them, including screens nobody has built yet. Langfuse cannot be
-- called from SQL, so each event is queued here and lib/quality/feedback.ts
-- sends it as a score on the trace and generation named in the row
-- (migration 20261006000400).
--
-- Signals are named after the behaviour: draft_approved, draft_edited,
-- draft_skipped, job_applied, job_dismissed (migration 402), outreach_replied,
-- interview_scheduled. The edit distance for draft_edited is computed at export
-- from the text the model wrote and the text now in the row.
--
-- Access: signed-in people can read their own events and nothing else. Writes
-- happen only through enqueue_feedback, called by the SECURITY DEFINER trigger
-- functions below (a browser-side stage change runs as the signed-in user, who
-- has no insert right) and by the service role.

create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  signal text not null check (signal in (
    'draft_approved', 'draft_edited', 'draft_skipped', 'job_applied',
    'job_dismissed', 'outreach_replied', 'interview_scheduled'
  )),
  subject_table text not null check (subject_table in ('outreach_messages', 'application_drafts', 'jobs')),
  subject_id uuid not null,
  trace_id text not null check (trace_id ~ '^[0-9a-f]{32}$'),
  observation_id text check (observation_id ~ '^[0-9a-f]{16}$'),
  traced_at timestamptz not null,
  comment text check (char_length(comment) <= 200),
  occurred_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sent', 'expired', 'failed')),
  attempts smallint not null default 0,
  sent_at timestamptz,
  unique (user_id, signal, subject_table, subject_id)
);

create index if not exists feedback_events_status_occurred_idx on public.feedback_events (status, occurred_at);

alter table public.feedback_events enable row level security;
revoke all on public.feedback_events from public, anon;
grant select on public.feedback_events to authenticated;
grant all on public.feedback_events to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'feedback_events' and policyname = 'own feedback_events select'
  ) then
    create policy "own feedback_events select"
      on public.feedback_events for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- One queue entry. A row with no trace (a template, an unexported trace, a row
-- from before this) has nothing to score, so it is skipped. A second event for
-- the same person, signal and subject is dropped: the first one stands.
create or replace function public.enqueue_feedback(
  p_user_id uuid,
  p_signal text,
  p_table text,
  p_id uuid,
  p_trace text,
  p_obs text,
  p_traced_at timestamptz,
  p_comment text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_trace is null or p_user_id is null or p_id is null then
    return;
  end if;
  insert into public.feedback_events
    (user_id, signal, subject_table, subject_id, trace_id, observation_id, traced_at, comment)
  values
    (p_user_id, p_signal, p_table, p_id, p_trace, p_obs, coalesce(p_traced_at, now()), left(p_comment, 200))
  on conflict (user_id, signal, subject_table, subject_id) do nothing;
end;
$$;

revoke all on function public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text) to service_role;

-- Drafts of outreach: approved or sent, edited, skipped by the person, replied to.
-- A skip the system made (it sets `error`, for example a follow-up suppressed
-- because the contact already replied) is not a decision about the draft.
create or replace function public.feedback_from_outreach_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.trace_id is null then
    return new;
  end if;

  if new.status in ('approved', 'sent') and old.status is distinct from new.status then
    perform public.enqueue_feedback(new.user_id, 'draft_approved', 'outreach_messages', new.id,
      new.trace_id, new.observation_id, new.created_at, null);
    if new.generated_body is not null
       and (new.body is distinct from new.generated_body or new.subject is distinct from new.generated_subject) then
      perform public.enqueue_feedback(new.user_id, 'draft_edited', 'outreach_messages', new.id,
        new.trace_id, new.observation_id, new.created_at, null);
    end if;
  end if;

  if new.status = 'skipped' and old.status is distinct from 'skipped' and new.error is null then
    perform public.enqueue_feedback(new.user_id, 'draft_skipped', 'outreach_messages', new.id,
      new.trace_id, new.observation_id, new.created_at, null);
  end if;

  if old.replied_at is null and new.replied_at is not null then
    perform public.enqueue_feedback(new.user_id, 'outreach_replied', 'outreach_messages', new.id,
      new.trace_id, new.observation_id, new.created_at, new.reply_classification);
  end if;

  return new;
end;
$$;

revoke all on function public.feedback_from_outreach_message() from public, anon, authenticated;

drop trigger if exists feedback_outreach_messages on public.outreach_messages;
create trigger feedback_outreach_messages
  after update on public.outreach_messages
  for each row execute function public.feedback_from_outreach_message();

-- Application drafts: approved or submitted, edited, rejected.
create or replace function public.feedback_from_application_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.trace_id is null then
    return new;
  end if;

  if new.status in ('approved', 'submitted') and old.status is distinct from new.status then
    perform public.enqueue_feedback(new.user_id, 'draft_approved', 'application_drafts', new.id,
      new.trace_id, new.observation_id, new.created_at, null);
    if (new.generated_cover_letter is not null and new.cover_letter is distinct from new.generated_cover_letter)
       or (new.generated_resume_summary is not null and new.resume_summary is distinct from new.generated_resume_summary) then
      perform public.enqueue_feedback(new.user_id, 'draft_edited', 'application_drafts', new.id,
        new.trace_id, new.observation_id, new.created_at, null);
    end if;
  end if;

  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    perform public.enqueue_feedback(new.user_id, 'draft_skipped', 'application_drafts', new.id,
      new.trace_id, new.observation_id, new.created_at, null);
  end if;

  return new;
end;
$$;

revoke all on function public.feedback_from_application_draft() from public, anon, authenticated;

drop trigger if exists feedback_application_drafts on public.application_drafts;
create trigger feedback_application_drafts
  after update on public.application_drafts
  for each row execute function public.feedback_from_application_draft();

-- Pipeline stages: the person applied, then a screen or interview was booked.
-- The pipeline page changes stages from the browser, so only the database sees
-- every one. An interview is credited to the draft and the sent message that
-- led to it, when they carry a trace.
create or replace function public.feedback_from_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
  d record;
  m record;
begin
  if new.stage = 'applied' and (tg_op = 'INSERT' or old.stage is distinct from 'applied') and new.job_id is not null then
    select trace_id, observation_id, coalesce(fit_assessed_at, discovered_at) as traced_at
      into j from public.jobs where id = new.job_id;
    if found then
      perform public.enqueue_feedback(new.user_id, 'job_applied', 'jobs', new.job_id,
        j.trace_id, j.observation_id, j.traced_at, null);
    end if;
  end if;

  if new.stage in ('screen', 'interview')
     and (tg_op = 'INSERT' or old.stage is distinct from new.stage)
     and new.job_id is not null then
    select id, trace_id, observation_id, created_at into d
      from public.application_drafts
      where user_id = new.user_id and job_id = new.job_id and trace_id is not null
      order by created_at desc limit 1;
    if found then
      perform public.enqueue_feedback(new.user_id, 'interview_scheduled', 'application_drafts', d.id,
        d.trace_id, d.observation_id, d.created_at, null);
    end if;

    select id, trace_id, observation_id, created_at into m
      from public.outreach_messages
      where user_id = new.user_id and job_id = new.job_id and status = 'sent' and trace_id is not null
      order by sent_at desc nulls last, created_at desc limit 1;
    if found then
      perform public.enqueue_feedback(new.user_id, 'interview_scheduled', 'outreach_messages', m.id,
        m.trace_id, m.observation_id, m.created_at, null);
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.feedback_from_application() from public, anon, authenticated;

drop trigger if exists feedback_applications on public.applications;
create trigger feedback_applications
  after insert or update of stage on public.applications
  for each row execute function public.feedback_from_application();

notify pgrst, 'reload schema';

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.feedback_events'::regclass) then
    raise exception 'feedback_events must have row level security on';
  end if;
  if has_table_privilege('anon', 'public.feedback_events', 'select')
     or has_table_privilege('anon', 'public.feedback_events', 'insert') then
    raise exception 'feedback_events must not be reachable by anon';
  end if;
  if has_table_privilege('authenticated', 'public.feedback_events', 'insert')
     or has_table_privilege('authenticated', 'public.feedback_events', 'update')
     or has_table_privilege('authenticated', 'public.feedback_events', 'delete') then
    raise exception 'authenticated may only read feedback_events';
  end if;
  if has_function_privilege('anon', 'public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text)', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_feedback(uuid, text, text, uuid, text, text, timestamptz, text)', 'execute') then
    raise exception 'enqueue_feedback is for the service role only';
  end if;
  if (select count(*) from pg_trigger
      where tgname in ('feedback_outreach_messages', 'feedback_application_drafts', 'feedback_applications') and not tgisinternal) <> 3 then
    raise exception 'feedback triggers are missing';
  end if;
end
$$;
