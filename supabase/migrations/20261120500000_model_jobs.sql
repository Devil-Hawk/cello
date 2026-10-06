-- K22a: the relay queue. A model step on the hosted app can run on the person's own
-- computer (R2, a local Ollama or LM Studio) or in their browser (R1, WebLLM): the
-- server writes a job, a carrier (the open Cello page, or the extension) claims it,
-- runs it on loopback, and returns text. Nothing here holds a key or a tool.
--
-- Two parts, because pgmq has no per-row result store and Realtime needs a table
-- with row level security:
--   * the pgmq queue `model_jobs` carries {job_id, user_id, rung}. Its visibility
--     timeout is the lease; read_ct is the attempt count. A claim is pgmq's
--     conditional read (pgmq 1.5 and later), so a carrier can only ever read its
--     own person's messages at its own rung. The one call that depends on it is
--     inside relay_claim.
--   * public.model_jobs holds the request, the status and the result. The server
--     writes it through the functions below; the person can only read their own.
--
-- Expand only: every object is new. Guarded to re-run, and to apply on a database
-- without pgmq (the checks harness): there the queue is not created and relay_claim
-- fails when called, which the relay check says out loud rather than faking.

do $pgmq$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    create extension if not exists pgmq;
    -- relay_claim needs pgmq's conditional read (1.5 and later). Fail here, when the
    -- migration is applied, not later when the first job is claimed.
    alter extension pgmq update;
    if string_to_array((select extversion from pg_extension where extname = 'pgmq'), '.')::int[] < array[1, 5, 0] then
      raise exception 'The relay queue needs pgmq 1.5 or later; this database has %.',
        (select extversion from pg_extension where extname = 'pgmq');
    end if;
    if not exists (select 1 from pgmq.meta where queue_name = 'model_jobs') then
      perform pgmq.create('model_jobs');
    end if;
  end if;
end
$pgmq$;

create table if not exists public.model_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id text not null,
  rung text not null check (rung in ('R1', 'R2')),
  prompt_hash text not null,
  request jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'done', 'failed')),
  claim_id uuid,
  result jsonb,
  error text,
  -- Provenance (directive 20): every result here is model text. prov says which model
  -- answered, as {step, model, rung, evidence, at}; relay_complete writes it.
  origin text not null default 'model' check (origin = 'model'),
  prov jsonb,
  confirmed_at timestamptz,
  msg_id bigint,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz,
  -- A carrier's answer is text for one step. 64 KB is far more than any step asks for.
  -- Measured on the text itself: jsonb escapes quotes and newlines, so the stored
  -- form can be longer than the 64 KB the route and the carriers allow.
  constraint model_jobs_result_size check (result is null or octet_length(result ->> 'text') <= 65536)
);

-- One job in flight per person, step and prompt: a step that re-runs finds its job.
create unique index if not exists model_jobs_one_in_flight
  on public.model_jobs (user_id, step_id, prompt_hash)
  where status in ('queued', 'claimed');
create index if not exists model_jobs_user_created on public.model_jobs (user_id, created_at desc);

alter table public.model_jobs enable row level security;
drop policy if exists model_jobs_select_own on public.model_jobs;
create policy model_jobs_select_own on public.model_jobs
  for select to authenticated using (user_id = auth.uid());
-- No insert, update or delete policy: only the functions below, run by the server, write.
revoke all on public.model_jobs from anon, authenticated;
grant select on public.model_jobs to authenticated;
grant all on public.model_jobs to service_role;

-- The page carrier hears inserts over Realtime, and the server hears the result.
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'model_jobs'
     ) then
    alter publication supabase_realtime add table public.model_jobs;
  end if;
end
$rt$;

-- relay_enqueue: write a job and its queue message, or hand back the one already
-- there. A job in flight for this person, step and prompt is returned as is; a
-- finished answer from the last ten minutes is returned with its result, so a step
-- that timed out and re-runs reads its answer instead of asking again.
create or replace function public.relay_enqueue(
  p_user uuid, p_step text, p_rung text, p_hash text, p_request jsonb
) returns table (job_id uuid, status text, result jsonb, created boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  v_row public.model_jobs;
  v_msg bigint;
  v_old bigint;
begin
  if p_rung not in ('R1', 'R2') then
    raise exception 'the relay carries R1 and R2 only';
  end if;

  -- The prune: this person's jobs older than a week go, with their queue messages.
  -- It runs on the person's own next ask, so no schedule is needed.
  for v_old in
    delete from public.model_jobs where user_id = p_user and created_at < now() - interval '7 days' returning msg_id
  loop
    if v_old is not null then perform pgmq.delete('model_jobs', v_old); end if;
  end loop;

  select * into v_row from public.model_jobs m
   where m.user_id = p_user and m.step_id = p_step and m.prompt_hash = p_hash
     and m.status in ('queued', 'claimed')
   limit 1;
  if found then
    return query select v_row.id, v_row.status, v_row.result, false;
    return;
  end if;

  select * into v_row from public.model_jobs m
   where m.user_id = p_user and m.step_id = p_step and m.prompt_hash = p_hash
     and m.status = 'done' and m.done_at > now() - interval '10 minutes'
   order by m.done_at desc
   limit 1;
  if found then
    return query select v_row.id, v_row.status, v_row.result, false;
    return;
  end if;

  begin
    insert into public.model_jobs (user_id, step_id, rung, prompt_hash, request)
    values (p_user, p_step, p_rung, p_hash, p_request)
    returning * into v_row;
  exception when unique_violation then
    -- Two asks at once: the other one won, so this one reads its job.
    select * into v_row from public.model_jobs m
     where m.user_id = p_user and m.step_id = p_step and m.prompt_hash = p_hash
       and m.status in ('queued', 'claimed')
     limit 1;
    return query select v_row.id, v_row.status, v_row.result, false;
    return;
  end;

  select pgmq.send('model_jobs', jsonb_build_object('job_id', v_row.id, 'user_id', p_user, 'rung', p_rung))
    into v_msg;
  update public.model_jobs set msg_id = v_msg where id = v_row.id;
  return query select v_row.id, 'queued'::text, null::jsonb, true;
end
$fn$;

-- relay_claim: one job for this person at this rung, or nothing. pgmq's conditional
-- read (the one line that needs pgmq 1.5 or later) only sees messages that contain
-- the person and the rung, so a carrier can never read anyone else's. The lease is
-- 150 seconds; a job read more than three times is failed instead of read again.
create or replace function public.relay_claim(p_user uuid, p_rung text)
returns table (job_id uuid, claim_id uuid, step_id text, rung text, request jsonb)
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  m record;
  v_job public.model_jobs;
  v_claim uuid;
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    exit when v_try > 5;

    select r.msg_id, r.read_ct, r.message into m
      from pgmq.read('model_jobs', 150, 1, jsonb_build_object('user_id', p_user, 'rung', p_rung)) r;
    exit when m.msg_id is null;

    select * into v_job from public.model_jobs j
     where j.id = (m.message ->> 'job_id')::uuid and j.user_id = p_user;
    if not found or v_job.status not in ('queued', 'claimed') then
      perform pgmq.delete('model_jobs', m.msg_id);
      continue;
    end if;
    if m.read_ct > 3 then
      update public.model_jobs set status = 'failed', error = 'No carrier finished this job.', done_at = now()
       where id = v_job.id;
      perform pgmq.delete('model_jobs', m.msg_id);
      continue;
    end if;

    v_claim := gen_random_uuid();
    update public.model_jobs set status = 'claimed', claim_id = v_claim, claimed_at = now()
     where id = v_job.id;
    return query select v_job.id, v_claim, v_job.step_id, v_job.rung, v_job.request;
    return;
  end loop;
  return;
end
$fn$;

-- relay_complete: finish a claimed job once. Refuses the wrong person, the wrong
-- claim, and any job that is not claimed (so a second answer, or a forged one for a
-- job nobody claimed, changes nothing), and an answer that names no model. Returns
-- whether it took the answer.
create or replace function public.relay_complete(
  p_user uuid, p_job uuid, p_claim uuid, p_result jsonb, p_model text, p_error text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  v_row public.model_jobs;
begin
  if p_model is null or p_model = '' then
    raise exception 'a result must name the model that answered';
  end if;
  -- The model rides in the result as well as in prov, so every reader of a finished
  -- job (the waiter, the re-run, the ledger) has it without another column.
  update public.model_jobs
     set status = case when p_error is null then 'done' else 'failed' end,
         result = case when p_error is null then p_result || jsonb_build_object('model', p_model) else null end,
         prov = jsonb_build_object('step', step_id, 'model', p_model, 'rung', rung, 'evidence', '[]'::jsonb, 'at', now()),
         error = p_error,
         done_at = now()
   where id = p_job and user_id = p_user and claim_id = p_claim and status = 'claimed'
  returning * into v_row;
  if not found then
    return false;
  end if;
  if v_row.msg_id is not null then
    perform pgmq.delete('model_jobs', v_row.msg_id);
  end if;
  return true;
end
$fn$;

revoke all on function public.relay_enqueue(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.relay_claim(uuid, text) from public, anon, authenticated;
revoke all on function public.relay_complete(uuid, uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.relay_enqueue(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.relay_claim(uuid, text) to service_role;
grant execute on function public.relay_complete(uuid, uuid, uuid, jsonb, text, text) to service_role;

notify pgrst, 'reload schema';
