-- K13: the functions that move an application.
--
-- WHY
--   Only these functions write an application's state or a pipeline event, so a caller that forgets
--   to ask still cannot pass a cap, Pause, the person-only kinds or the send block. They run for the
--   service role only; lib/pipeline/transition.ts is the one TypeScript caller.
--
-- WHAT
--   pipeline_transition   one move: the lock, the replay, the refusals, the update, the event
--   pipeline_note         one line on the timeline that moves no state (a stage change sets the stage)
--   pipeline_pause/resume the person's Pause, under the same lock
--   pipeline_auto_send_reason   why an application may not be sent without a click, or null
--   pipeline_send_blocked       whether a posting was sent already
--   prune_pipeline_events       the daily trim
--
-- EVERY refusal is an answer, not an error: {ok: false, refusal, sentence}. A move that happens is
-- {ok: true, replay, event}. A replay returns the first event and moves nothing.
--
-- LOCKS are transaction advisory locks only (hashtextextended of the user id): the connection pooler
-- shares server sessions, so a session lock would let two callers both hold it.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.pipeline_refuse(p_code text, p_sentence text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'refusal', p_code, 'sentence', p_sentence)
$$;

-- The person's zone: where their roles.check routine runs, else UTC.
create or replace function public.pipeline_zone(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
begin
  select r.timezone into tz from public.routines r where r.user_id = p_user and r.command = 'roles.check' limit 1;
  if tz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = tz) then
    return 'UTC';
  end if;
  return tz;
end;
$$;

-- One address, one hash: the host without www, the path without a trailing slash, lower case; the
-- query and the fragment dropped, except a Greenhouse job id, which is what tells two postings on one
-- company page apart. lib/pipeline/posting.ts mirrors it and a test pins both to the same value.
create or replace function public.posting_url_hash(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when nullif(btrim(p_url), '') is null then null else
    encode(extensions.digest(convert_to(
      lower(regexp_replace(regexp_replace(regexp_replace(btrim(p_url), '[?#].*$', ''), '^[a-zA-Z]+://(www\.)?', ''), '/+$', ''))
        || coalesce('?gh_jid=' || (regexp_match(p_url, '[?&]gh_jid=([0-9]+)'))[1], ''),
      'utf8'), 'sha256'), 'hex')
  end
$$;

-- Whether a posting was sent already: a send, a send under way or a marked send with no later
-- retraction or override.
create or replace function public.pipeline_send_blocked(p_user uuid, p_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_hash is not null and exists (
    select 1 from public.pipeline_events s
     where s.user_id = p_user
       and s.posting_url_hash = p_hash
       and s.kind in ('submission.sent', 'submission.sending', 'submission.marked')
       and not exists (
         select 1 from public.pipeline_events r
          where r.user_id = p_user
            and r.posting_url_hash = p_hash
            and r.kind in ('submission.retracted', 'application.duplicate_override')
            and r.created_at > s.created_at
       )
  )
$$;

-- ---------------------------------------------------------------------------
-- Why an application may not be sent without a click, or null when it may
-- ---------------------------------------------------------------------------
-- The pure part of the rule (the form's fields, the site) lives in lib/fill/eligibility.ts. This is
-- the part the database can see. Nothing is stored: it is computed when it is read.

create or replace function public.pipeline_auto_send_reason(p_app uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.applications%rowtype;
  pl jsonb;
  send jsonb;
  demo boolean;
  token_seen timestamptz;
  ready_since timestamptz;
  approved_at timestamptz;
  changed_at timestamptz;
  creator text;
  chance text;
  j public.jobs%rowtype;
begin
  select * into a from public.applications where id = p_app;
  if not found then
    return 'That application is gone.';
  end if;
  select p.preferences -> 'pipeline', coalesce(p.is_demo, false) into pl, demo from public.profiles p where p.id = a.user_id;
  send := coalesce(pl -> 'send', '{}'::jsonb);

  if demo then return 'This is a demo, so nothing is sent.'; end if;
  if coalesce(send ->> 'mode', 'me') <> 'auto' then return 'Send for me is off.'; end if;
  if pl ->> 'paused_at' is not null then return 'Cello is paused.'; end if;
  if a.state is distinct from 'ready' then return 'Only a ready application can be sent.'; end if;
  if public.pipeline_send_blocked(a.user_id, a.posting_url_hash) then
    return 'You already sent this one. Cello will not send it twice.';
  end if;
  if a.auto_attempted_at is not null
     or exists (select 1 from public.pipeline_events e where e.application_id = a.id and e.kind = 'submission.sending') then
    return 'Cello already tried this one. Finish it on the site.';
  end if;

  select t.last_used_at into token_seen
    from public.api_tokens t
   where t.id::text = send ->> 'tokenId' and t.user_id = a.user_id and t.revoked_at is null;
  if token_seen is null or token_seen < now() - interval '24 hours' then
    return 'Your browser has not been on since yesterday.';
  end if;

  select max(e.created_at) into ready_since from public.pipeline_events e where e.application_id = a.id and e.to_state = 'ready';
  if ready_since is null or ready_since < now() - interval '24 hours' then
    return 'This has waited more than a day. Open it and click Fill.';
  end if;

  select * into j from public.jobs where id = a.job_id;
  -- ponytail: the stored role carries no closing date yet, so only a posting already closed is caught.
  -- Add the "closes within 2 days" check when the reader stores valid_through.
  if j.closed_at is not null then return 'The posting closed.'; end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'person_roles' and column_name = 'chance'
  ) then
    execute 'select chance from public.person_roles where user_id = $1 and job_id = $2' into chance using a.user_id, a.job_id;
  end if;
  if chance is distinct from 'strong' then
    return 'Cello sends only Strong matches.';
  end if;
  if not exists (
    select 1 from public.companies c
     where c.user_id = a.user_id and c.watching
       and (c.id = j.company_id or (j.employer_id is not null and c.employer_id = j.employer_id))
  ) then
    return 'Cello sends only for employers you follow.';
  end if;

  select e.actor into creator from public.pipeline_events e
   where e.application_id = a.id and e.kind = 'application.created' order by e.created_at limit 1;
  if creator is distinct from 'person' and creator is distinct from 'rule' and creator is distinct from 'extension'
     and not exists (select 1 from public.pipeline_events e where e.application_id = a.id and e.kind = 'application.send_allowed') then
    return 'You did not choose this one. Let Cello send this?';
  end if;

  -- The resume: the base resume, or a tailored one the person approved and that did not change since.
  if a.resume_artifact_id is not null then
    select max(e.created_at) into approved_at from public.pipeline_events e
     where e.application_id = a.id and e.kind = 'approval.decided' and e.actor = 'person' and e.payload ->> 'what' = 'resume';
    if approved_at is null then
      return 'Approve the resume to let Cello send this.';
    end if;
    select max(e.created_at) into changed_at from public.pipeline_events e
     where e.application_id = a.id and e.kind = 'step.finished' and e.payload ->> 'resume_changed' = 'true';
    if changed_at is not null and changed_at > approved_at then
      return 'The resume changed after you approved it.';
    end if;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- pipeline_note: a line on the timeline that moves no state
-- ---------------------------------------------------------------------------

create or replace function public.pipeline_note(p_user uuid, p_app uuid, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev jsonb := coalesce(p_event, '{}'::jsonb);
  v_kind text := ev ->> 'kind';
  v_actor text := ev ->> 'actor';
  v_key text := ev ->> 'idempotency_key';
  a public.applications%rowtype;
  existing public.pipeline_events%rowtype;
  made public.pipeline_events%rowtype;
  v_stage text;
  v_company text;
  v_hash text;
begin
  if v_kind is null or v_actor is null or v_key is null or ev ->> 'sentence' is null then
    raise exception 'an event needs kind, actor, sentence and idempotency_key';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  select * into existing from public.pipeline_events where user_id = p_user and idempotency_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'event', to_jsonb(existing));
  end if;

  -- The kinds only the person writes. A chat answer saved by Cello is a note that moves nothing.
  if v_kind in ('submission.marked', 'submission.retracted', 'approval.decided', 'application.duplicate_override',
                'application.send_allowed', 'autonomy.changed', 'stage.changed', 'question.answered')
     and v_actor <> 'person'
     and not (v_kind = 'question.answered' and v_actor = 'cello') then
    return public.pipeline_refuse('person_only', 'Only you can do this.');
  end if;
  if v_kind in ('fill.auto_started', 'submission.sending') then
    return public.pipeline_refuse('extension_only', 'Only your browser can do this, through the claim.');
  end if;

  if p_app is not null then
    select * into a from public.applications where id = p_app and user_id = p_user for update;
    if not found then
      return public.pipeline_refuse('missing', 'That application is gone.');
    end if;
    select coalesce(d.name, c.name), coalesce(a.posting_url_hash, public.posting_url_hash(j.url)) into v_company, v_hash
      from public.jobs j
      left join public.company_directory d on d.id = j.employer_id
      left join public.companies c on c.id = j.company_id
     where j.id = a.job_id;
    v_hash := coalesce(v_hash, a.posting_url_hash);

    -- A stage the person sets also sets the stage, in the same step.
    if v_kind = 'stage.changed' and ev -> 'payload' ->> 'stage' is not null then
      v_stage := ev -> 'payload' ->> 'stage';
      update public.applications
         set stage = v_stage,
             applied_at = case when v_stage = 'applied' then coalesce(applied_at, now()) else applied_at end,
             closed_reason = case when ev -> 'payload' ? 'closed_reason' then nullif(ev -> 'payload' ->> 'closed_reason', '') else closed_reason end,
             posting_url_hash = v_hash,
             last_event_at = clock_timestamp()
       where id = a.id;
    else
      update public.applications set posting_url_hash = v_hash, last_event_at = clock_timestamp() where id = a.id;
    end if;
  end if;

  insert into public.pipeline_events (
    user_id, application_id, job_id, posting_url_hash, company_name, kind, actor, channel, actor_label, step,
    sentence, from_state, to_state, payload, proof, trace_id, cost_usd, free_model, model_calls, duration_ms,
    trust, origin, prov, header_verdict, idempotency_key
  ) values (
    p_user, p_app, a.job_id, v_hash, coalesce(ev ->> 'company_name', v_company), v_kind, v_actor,
    ev ->> 'channel', ev ->> 'actor_label', ev ->> 'step',
    ev ->> 'sentence', a.state, a.state, coalesce(ev -> 'payload', '{}'::jsonb), ev -> 'proof', ev ->> 'trace_id',
    (ev ->> 'cost_usd')::numeric, (ev ->> 'free_model')::boolean, (ev ->> 'model_calls')::integer, (ev ->> 'duration_ms')::integer,
    coalesce(ev ->> 'trust', case when v_actor = 'person' then 'person' else 'proven' end),
    coalesce(ev ->> 'origin', case when v_actor = 'person' then 'person' else 'code' end),
    ev -> 'prov', ev -> 'header_verdict', v_key
  ) returning * into made;

  return jsonb_build_object('ok', true, 'replay', false, 'event', to_jsonb(made));
end;
$$;

-- ---------------------------------------------------------------------------
-- pipeline_transition: one move
-- ---------------------------------------------------------------------------
--   p_from   the states the move may start from; 'none' stands for a row with no state
--   p_to     the state it moves to
--   p_step   the line shown while it is there
--   p_reason the one thing it waits on (needs_you only)
--   p_detail the detail of that reason (your_turn: {cause, host, auto})
--   p_event  {kind, actor, sentence, idempotency_key, channel, actor_label, step, payload, trust, origin,
--             prov, proof, trace_id, cost_usd, free_model, model_calls, duration_ms, next_at,
--             attempt_inc, closed_reason}
--   p_cap    {kind, actor, max}: a cap the caller states. The ceilings below hold whatever it says.

create or replace function public.pipeline_transition(
  p_app uuid,
  p_from text[],
  p_to text,
  p_step text,
  p_reason text,
  p_detail jsonb,
  p_event jsonb,
  p_cap jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev jsonb := coalesce(p_event, '{}'::jsonb);
  v_kind text := ev ->> 'kind';
  v_actor text := ev ->> 'actor';
  v_key text := ev ->> 'idempotency_key';
  a public.applications%rowtype;
  existing public.pipeline_events%rowtype;
  made public.pipeline_events%rowtype;
  served public.pipeline_events%rowtype;
  pl jsonb;
  send jsonb;
  demo boolean;
  tz text;
  day_start timestamptz;
  n integer;
  ceiling integer;
  send_max integer;
  cap_max integer;
  reason text;
  v_closed text;
  v_lease uuid;
  v_company text;
  v_stage text;
  v_hash text;
begin
  if v_kind is null or v_actor is null or v_key is null or ev ->> 'sentence' is null then
    raise exception 'an event needs kind, actor, sentence and idempotency_key';
  end if;
  if p_to is null then
    raise exception 'a move needs a state to move to; a line without a move is pipeline_note';
  end if;
  if p_to = 'needs_you' and p_reason is null then
    raise exception 'a move to needs_you names its one reason';
  end if;

  select * into a from public.applications where id = p_app;
  if not found then
    return public.pipeline_refuse('missing', 'That application is gone.');
  end if;

  -- One lock per person: caps, Pause and the moves of one person never interleave.
  perform pg_advisory_xact_lock(hashtextextended(a.user_id::text, 0));
  select * into a from public.applications where id = p_app for update;
  v_hash := coalesce(a.posting_url_hash, public.posting_url_hash((select j.url from public.jobs j where j.id = a.job_id)));

  -- A replay returns the first event and moves nothing.
  select * into existing from public.pipeline_events where user_id = a.user_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'event', to_jsonb(existing));
  end if;

  select p.preferences -> 'pipeline', coalesce(p.is_demo, false) into pl, demo from public.profiles p where p.id = a.user_id;
  send := coalesce(pl -> 'send', '{}'::jsonb);

  -- The kinds only the person writes, and the two only the extension writes.
  if v_kind in ('submission.marked', 'submission.retracted', 'approval.decided', 'application.duplicate_override',
                'application.send_allowed', 'autonomy.changed', 'stage.changed', 'question.answered')
     and v_actor <> 'person' then
    return public.pipeline_refuse('person_only', 'Only you can do this.');
  end if;
  if v_kind in ('fill.auto_started', 'submission.sending') and v_actor <> 'extension' then
    return public.pipeline_refuse('extension_only', 'Only your browser can do this.');
  end if;

  -- Pause: nothing moves into Preparing or Applying while it is on.
  if pl ->> 'paused_at' is not null
     and (p_to in ('preparing', 'applying') or v_kind in ('fill.auto_started', 'submission.sending')) then
    return public.pipeline_refuse('paused', 'Cello is paused. Nothing will be prepared.');
  end if;

  -- The move must start where the caller thinks it does.
  if not (coalesce(a.state, 'none') = any (p_from)) then
    return public.pipeline_refuse('stale', 'This changed while you were looking. Open it again.');
  end if;

  -- The send block: no start on a posting already sent. The person's start becomes "Already applied?"
  -- in code (a move to needs_you with application.duplicate); Apply anyway releases the posting.
  if v_kind = 'application.created' and public.pipeline_send_blocked(a.user_id, v_hash) then
    return public.pipeline_refuse('send_block', 'You already sent this one.');
  end if;

  -- Caps. The day is the person's, not the server's.
  tz := public.pipeline_zone(a.user_id);
  day_start := date_trunc('day', now() at time zone tz) at time zone tz;

  ceiling := case
    when v_kind = 'application.created' and demo then 3
    when v_kind = 'application.created' and v_actor in ('cello', 'rule') then 10
    else null
  end;
  if ceiling is not null then
    select count(*) into n from public.pipeline_events e
     where e.user_id = a.user_id and e.kind = v_kind and e.created_at >= day_start
       and (demo or e.actor = v_actor);
    if n >= ceiling then
      return public.pipeline_refuse('cap', format('Today''s limit of %s is reached.', ceiling));
    end if;
  end if;
  if p_cap is not null and p_cap ->> 'max' is not null then
    cap_max := (p_cap ->> 'max')::integer;
    select count(*) into n from public.pipeline_events e
     where e.user_id = a.user_id and e.kind = coalesce(p_cap ->> 'kind', v_kind) and e.created_at >= day_start
       and (p_cap ->> 'actor' is null or e.actor = p_cap ->> 'actor');
    if n >= cap_max then
      return public.pipeline_refuse('cap', format('Today''s limit of %s is reached.', cap_max));
    end if;
  end if;

  -- Send for me: the claim and the Send step.
  if v_kind in ('fill.auto_started', 'submission.sending') then
    if demo then
      return public.pipeline_refuse('demo', 'This is a demo, so nothing is sent.');
    end if;
    if coalesce(send ->> 'mode', 'me') <> 'auto' then
      return public.pipeline_refuse('send_off', 'Send for me is off.');
    end if;
    if ev -> 'payload' ->> 'token_id' is distinct from send ->> 'tokenId' then
      return public.pipeline_refuse('token', 'Send for me is bound to another browser.');
    end if;
    if v_kind = 'fill.auto_started' then
      -- Every other check of the claim: the application's own reason, then the day's tries.
      reason := public.pipeline_auto_send_reason(a.id);
      if reason is not null then
        return public.pipeline_refuse('not_allowed', reason);
      end if;
      send_max := least(coalesce((send ->> 'maxPerDay')::integer, 3), 10);
      select count(*) into n from public.pipeline_events e
       where e.user_id = a.user_id and e.kind = 'fill.auto_started' and e.created_at >= day_start;
      if n >= send_max then
        return public.pipeline_refuse('cap', format('Today''s limit of %s is reached.', send_max));
      end if;
    else
      -- The Send step: the same claim, the same files, nothing changed since.
      if a.auto_attempted_at is null then
        return public.pipeline_refuse('no_claim', 'Cello has not claimed this one.');
      end if;
      if a.lease_holder is null or (ev -> 'payload' ->> 'lease_holder') is distinct from a.lease_holder::text then
        return public.pipeline_refuse('lease', 'Another session holds this application.');
      end if;
      select * into served from public.pipeline_events e
       where e.application_id = a.id and e.kind = 'fill.started' order by e.created_at desc limit 1;
      if not found or (ev -> 'payload' -> 'files') is distinct from (served.payload -> 'files') then
        return public.pipeline_refuse('files', 'The files are not the ones Cello prepared.');
      end if;
      reason := public.pipeline_auto_send_reason_for_send(a.id);
      if reason is not null then
        return public.pipeline_refuse('not_allowed', reason);
      end if;
    end if;
  end if;

  -- The move.
  v_closed := case
    when p_to = 'skipped' then 'skipped'
    when ev ? 'closed_reason' then nullif(ev ->> 'closed_reason', '')
    when a.closed_reason = 'skipped' then null
    else a.closed_reason
  end;
  v_lease := case when v_kind = 'fill.auto_started' then gen_random_uuid() else a.lease_holder end;
  v_stage := a.stage;
  if p_to = 'sent' and a.stage = 'discovered' then
    v_stage := 'applied';
  end if;

  update public.applications
     set state = p_to,
         step = p_step,
         needs_reason = case when p_to = 'needs_you' then p_reason end,
         needs_detail = case when p_to = 'needs_you' then p_detail end,
         state_before_pause = case when p_to = 'paused' then a.state when a.state = 'paused' then null else a.state_before_pause end,
         next_at = coalesce(nullif(ev ->> 'next_at', '')::timestamptz, case when p_to in ('preparing', 'scheduled') then now() end),
         heartbeat_at = clock_timestamp(),
         lease_until = case
           when v_kind = 'fill.auto_started' then now() + interval '10 minutes'
           when p_to in ('applying', 'preparing') then a.lease_until
           else null end,
         lease_holder = case when p_to in ('sent', 'confirmed', 'not_sent', 'skipped', 'needs_you') and v_kind <> 'fill.auto_started' then null else v_lease end,
         auto_attempted_at = case when v_kind = 'fill.auto_started' then now() else a.auto_attempted_at end,
         attempt = a.attempt + case when coalesce((ev ->> 'attempt_inc')::boolean, false) then 1 else 0 end,
         closed_reason = v_closed,
         posting_url_hash = v_hash,
         stage = v_stage,
         applied_at = case when p_to = 'sent' then coalesce(a.applied_at, now()) else a.applied_at end,
         last_event_at = clock_timestamp()
   where id = a.id;

  select coalesce(d.name, c.name) into v_company
    from public.jobs j
    left join public.company_directory d on d.id = j.employer_id
    left join public.companies c on c.id = j.company_id
   where j.id = a.job_id;

  insert into public.pipeline_events (
    user_id, application_id, job_id, posting_url_hash, company_name, kind, actor, channel, actor_label, step,
    sentence, from_state, to_state, payload, proof, trace_id, cost_usd, free_model, model_calls, duration_ms,
    trust, origin, prov, header_verdict, idempotency_key
  ) values (
    a.user_id, a.id, a.job_id, v_hash, coalesce(ev ->> 'company_name', v_company), v_kind, v_actor,
    ev ->> 'channel', ev ->> 'actor_label', ev ->> 'step',
    ev ->> 'sentence', a.state, p_to, coalesce(ev -> 'payload', '{}'::jsonb), ev -> 'proof', ev ->> 'trace_id',
    (ev ->> 'cost_usd')::numeric, (ev ->> 'free_model')::boolean, (ev ->> 'model_calls')::integer, (ev ->> 'duration_ms')::integer,
    coalesce(ev ->> 'trust', case when v_actor = 'person' then 'person' else 'proven' end),
    coalesce(ev ->> 'origin', case when v_actor = 'person' then 'person' else 'code' end),
    ev -> 'prov', ev -> 'header_verdict', v_key
  ) returning * into made;

  return jsonb_build_object('ok', true, 'replay', false, 'event', to_jsonb(made))
         || case when v_kind = 'fill.auto_started' then jsonb_build_object('lease_holder', v_lease) else '{}'::jsonb end;
end;
$$;

-- The Send step is allowed on an application that is Applying under a claim, so the "only a ready
-- application" line of the claim does not apply to it; every other line does.
create or replace function public.pipeline_auto_send_reason_for_send(p_app uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.applications%rowtype;
begin
  select * into a from public.applications where id = p_app;
  if a.state is distinct from 'applying' then return 'This is not being sent now.'; end if;
  if public.pipeline_send_blocked(a.user_id, a.posting_url_hash) then
    return 'You already sent this one. Cello will not send it twice.';
  end if;
  -- ponytail: the claim already proved the rest (Strong, followed, chosen, approved resume); between the
  -- claim and the click only a changed resume, Pause or a taken lease can matter, and the first two are
  -- checked here and by the caller.
  if a.resume_artifact_id is not null and exists (
    select 1 from public.pipeline_events c, public.pipeline_events r
     where c.application_id = a.id and c.kind = 'fill.auto_started'
       and r.application_id = a.id and r.kind = 'step.finished' and r.payload ->> 'resume_changed' = 'true'
       and r.created_at > c.created_at
  ) then
    return 'The resume changed after you approved it.';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pause and resume
-- ---------------------------------------------------------------------------
-- preferences.pipeline.paused_at. K10 guards that object (only set_autonomy writes it); these two
-- are the one other writer, and say so with a transaction-local setting the guard reads.

create or replace function public.pipeline_pause(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pl jsonb;
  at_ timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  at_ := clock_timestamp();
  select coalesce(p.preferences -> 'pipeline', '{}'::jsonb) into pl from public.profiles p where p.id = p_user;
  if not found then
    return public.pipeline_refuse('missing', 'That person is gone.');
  end if;
  if pl ->> 'paused_at' is not null then
    return jsonb_build_object('ok', true, 'already', true, 'paused_at', pl ->> 'paused_at');
  end if;
  perform set_config('cello.autonomy_writer', 'on', true);
  update public.profiles
     set preferences = coalesce(preferences, '{}'::jsonb)
                       || jsonb_build_object('pipeline', pl || jsonb_build_object('paused_at', at_))
   where id = p_user;
  insert into public.pipeline_events (user_id, kind, actor, channel, sentence, trust, origin, idempotency_key)
  values (p_user, 'pipeline.paused', 'person', 'session', 'You paused Cello.', 'person', 'person', 'paused:' || at_::text);
  return jsonb_build_object('ok', true, 'already', false, 'paused_at', at_);
end;
$$;

create or replace function public.pipeline_resume(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pl jsonb;
  at_ timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  at_ := clock_timestamp();
  select coalesce(p.preferences -> 'pipeline', '{}'::jsonb) into pl from public.profiles p where p.id = p_user;
  if not found then
    return public.pipeline_refuse('missing', 'That person is gone.');
  end if;
  if pl ->> 'paused_at' is null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  perform set_config('cello.autonomy_writer', 'on', true);
  update public.profiles
     set preferences = coalesce(preferences, '{}'::jsonb)
                       || jsonb_build_object('pipeline', pl - 'paused_at')
   where id = p_user;
  insert into public.pipeline_events (user_id, kind, actor, channel, sentence, trust, origin, idempotency_key)
  values (p_user, 'pipeline.resumed', 'person', 'session', 'You resumed Cello.', 'person', 'person', 'resumed:' || at_::text);
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- The daily trim
-- ---------------------------------------------------------------------------
-- Step lines and housekeeping events go after 90 days. Milestones stay: created, approvals,
-- submissions, retractions, confirmations, stage changes, and everything the send block reads.

create or replace function public.prune_pipeline_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.pipeline_events
   where created_at < now() - interval '90 days'
     and kind in ('step.started', 'step.finished', 'step.failed', 'fill.reported', 'find.finished',
                  'task.finished', 'task.missed', 'spend.threshold', 'limit.reached', 'summary.built');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the service role only
-- ---------------------------------------------------------------------------

revoke all on function public.posting_url_hash(text) from public, anon, authenticated;
revoke all on function public.pipeline_refuse(text, text) from public, anon, authenticated;
revoke all on function public.pipeline_zone(uuid) from public, anon, authenticated;
revoke all on function public.pipeline_send_blocked(uuid, text) from public, anon, authenticated;
revoke all on function public.pipeline_auto_send_reason(uuid) from public, anon, authenticated;
revoke all on function public.pipeline_auto_send_reason_for_send(uuid) from public, anon, authenticated;
revoke all on function public.pipeline_note(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.pipeline_transition(uuid, text[], text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pipeline_pause(uuid) from public, anon, authenticated;
revoke all on function public.pipeline_resume(uuid) from public, anon, authenticated;
revoke all on function public.prune_pipeline_events() from public, anon, authenticated;

grant execute on function public.posting_url_hash(text) to service_role;
grant execute on function public.pipeline_refuse(text, text) to service_role;
grant execute on function public.pipeline_zone(uuid) to service_role;
grant execute on function public.pipeline_send_blocked(uuid, text) to service_role;
grant execute on function public.pipeline_auto_send_reason(uuid) to service_role;
grant execute on function public.pipeline_auto_send_reason_for_send(uuid) to service_role;
grant execute on function public.pipeline_note(uuid, uuid, jsonb) to service_role;
grant execute on function public.pipeline_transition(uuid, text[], text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.pipeline_pause(uuid) to service_role;
grant execute on function public.pipeline_resume(uuid) to service_role;
grant execute on function public.prune_pipeline_events() to service_role;

notify pgrst, 'reload schema';

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.posting_url_hash(text)',
    'public.pipeline_refuse(text, text)',
    'public.pipeline_zone(uuid)',
    'public.pipeline_send_blocked(uuid, text)',
    'public.pipeline_auto_send_reason(uuid)',
    'public.pipeline_auto_send_reason_for_send(uuid)',
    'public.pipeline_note(uuid, uuid, jsonb)',
    'public.pipeline_transition(uuid, text[], text, text, text, jsonb, jsonb, jsonb)',
    'public.pipeline_pause(uuid)',
    'public.pipeline_resume(uuid)',
    'public.prune_pipeline_events()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be executable by client roles', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '% must be executable by the service role', f;
    end if;
  end loop;
end
$$;
