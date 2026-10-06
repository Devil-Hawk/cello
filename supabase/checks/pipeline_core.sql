-- K13: the pipeline's guards, caps and Send for me refusals (migrations 20261013000000 to 20261013000003).
--
-- Proves, as the roles that meet them:
--   the session cannot set or change a pipeline column, cannot delete what was sent, and still does what
--   the pages already did; every move is one event and a replay moves nothing; the person-only and
--   extension-only kinds refuse every other actor; the caps and the ceilings hold whatever the caller
--   says; Pause refuses a start; a posting sent once cannot be started again and what was sent survives
--   its application; the T10 check refuses an unconfirmed count; following has one writer and at most
--   5 pins; Send for me refuses each case of the list and the claim, the Send step and the replay behave.
-- Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/pipeline_core.sql

\set ON_ERROR_STOP 1
begin;

-- Scoring's chance column arrives with K8a; the check needs it, and the transaction rolls back.
alter table public.person_roles add column if not exists chance text;
-- artifacts arrive with K8d; a resume id here is only a marker.
alter table public.applications drop constraint if exists applications_resume_artifact_fkey;

create temp table fx as
select gen_random_uuid() as u, gen_random_uuid() as v, gen_random_uuid() as demo,
       gen_random_uuid() as co_u, gen_random_uuid() as co_v, gen_random_uuid() as co_demo,
       gen_random_uuid() as tok, gen_random_uuid() as tok2;
grant select on fx to public;

insert into auth.users (id, email)
select u, 'pc-u@example.invalid' from fx union all select v, 'pc-v@example.invalid' from fx
union all select demo, 'pc-demo@example.invalid' from fx;
update public.profiles set is_demo = true where id = (select demo from fx);

insert into public.companies (id, user_id, name, career_url)
select co_u, u, 'Core Co', 'https://core.example/jobs' from fx
union all select co_v, v, 'Other Co', 'https://other.example/jobs' from fx
union all select co_demo, demo, 'Demo Co', 'https://demo.example/jobs' from fx;
select public.companies_follow(array[co_u], true, u) from fx;
select public.companies_follow(array[co_v], true, v) from fx;
select public.companies_follow(array[co_demo], true, demo) from fx;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.as_user(uid uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q;
  get diagnostics n = row_count;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise;
end $$;

-- A role at a company of the person's; the url keeps each posting its own.
create function pg_temp.mkjob(co uuid, n text) returns uuid language plpgsql as $$
declare j uuid := gen_random_uuid();
begin
  insert into public.jobs (id, company_id, title, description, url, external_id)
  values (j, co, 'Engineer ' || n, 'd', 'https://core.example/jobs/' || n, 'pc-' || n || '-' || j);
  return j;
end $$;

create function pg_temp.mkapp(uid uuid, job uuid) returns uuid language plpgsql as $$
declare a uuid;
begin
  insert into public.applications (user_id, job_id) values (uid, job) returning id into a;
  return a;
end $$;

create function pg_temp.ev(k text, a text, key text, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('kind', k, 'actor', a, 'sentence', 'A line for the person.', 'idempotency_key', key) || extra
$$;

create function pg_temp.mv(app uuid, f text[], t text, k text, a text, key text,
                           extra jsonb default '{}', cap jsonb default null, reason text default null, detail jsonb default null)
returns jsonb language sql as $$
  select public.pipeline_transition(app, f, t, 'Working', reason, detail, pg_temp.ev(k, a, key, extra), cap)
$$;

create function pg_temp.note(uid uuid, app uuid, k text, a text, key text, extra jsonb default '{}')
returns jsonb language sql as $$
  select public.pipeline_note(uid, app, pg_temp.ev(k, a, key, extra))
$$;

-- want is 'ok' for a move or the refusal code.
create function pg_temp.expect(j jsonb, want text, what text) returns void language plpgsql as $$
begin
  if want = 'ok' then
    if not coalesce((j ->> 'ok')::boolean, false) then raise exception '%: expected a move, got %', what, j; end if;
  elsif coalesce(j ->> 'refusal', '') <> want then
    raise exception '%: expected the refusal %, got %', what, want, j;
  end if;
end $$;

-- A ready application that Send for me may claim: chosen by the person, Strong, followed, ready now.
create function pg_temp.allowed_app(uid uuid, co uuid, n text, creator text default 'person') returns uuid language plpgsql as $$
declare j uuid := pg_temp.mkjob(co, n); a uuid;
begin
  a := pg_temp.mkapp(uid, j);
  insert into public.person_roles (user_id, job_id, chance) values (uid, j, 'strong')
    on conflict (user_id, job_id) do update set chance = 'strong';
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'preparing', 'application.created', creator, 'c:' || a), 'ok', 'start ' || n);
  perform pg_temp.expect(pg_temp.mv(a, array['preparing'], 'ready', 'step.finished', 'schedule', 'r:' || a), 'ok', 'ready ' || n);
  return a;
end $$;

create function pg_temp.set_send(uid uuid, send jsonb) returns void language plpgsql as $$
begin
  update public.profiles
     set preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object('pipeline', coalesce(preferences -> 'pipeline', '{}'::jsonb) || jsonb_build_object('send', send))
   where id = uid;
end $$;

insert into public.api_tokens (id, user_id, name, token_hash, scopes, last_used_at)
select tok, u, 'laptop', 'hash-' || tok, array['fill:extension'], now() from fx
union all select tok2, u, 'second laptop', 'hash-' || tok2, array['fill:extension'], now() from fx;

-- ---------------------------------------------------------------------------
-- 1. The session: what it cannot do and what it still does
-- ---------------------------------------------------------------------------

do $$
declare f record; j uuid; a uuid; n bigint;
begin
  select * into f from fx;
  j := pg_temp.mkjob(f.co_u, 'g1');

  -- The jobs page's insert: user, job, stage.
  n := pg_temp.as_user(f.u, format('insert into public.applications (user_id, job_id, stage) values (%L, %L, %L)', f.u, j, 'discovered'));
  if n <> 1 then raise exception 'the session must still insert an application row'; end if;
  select id into a from public.applications where job_id = j;

  begin
    perform pg_temp.as_user(f.u, format('insert into public.applications (user_id, job_id, state) values (%L, %L, %L)', f.u, pg_temp.mkjob(f.co_u, 'g1b'), 'preparing'));
    raise exception 'a session insert with state preparing was accepted';
  exception when insufficient_privilege then null; end;

  begin
    perform pg_temp.as_user(f.u, format('insert into public.applications (user_id, job_id, next_at) values (%L, %L, now())', f.u, pg_temp.mkjob(f.co_u, 'g1c')));
    raise exception 'a session insert with next_at was accepted';
  exception when insufficient_privilege then null; end;

  begin
    perform pg_temp.as_user(f.u, format('update public.applications set state = %L where id = %L', 'sent', a));
    raise exception 'a session update of state was accepted';
  exception when insufficient_privilege then null; end;

  begin
    perform pg_temp.as_user(f.u, format('update public.applications set attempt = 5, cost_usd = 1 where id = %L', a));
    raise exception 'a session update of attempt was accepted';
  exception when insufficient_privilege then null; end;

  -- The pipeline page and the Gmail share route write stage, notes, updated_at, applied_at.
  n := pg_temp.as_user(f.u, format('update public.applications set stage = %L, notes = %L, applied_at = now(), updated_at = now(), instruction = %L, interview_at = now() where id = %L',
                                   'applied', 'a note', 'my own words', a));
  if n <> 1 then raise exception 'the session must still write stage, notes and applied_at'; end if;
  -- ...and the sweeper (postgres) and the server pass the trigger.
  update public.applications set state = 'paused', state_before_pause = null where id = a;
  update public.applications set state = null where id = a;
end $$;

-- A person deletes what Cello never worked on, and never what was sent.
do $$
declare f record; j1 uuid; j2 uuid; a1 uuid; a2 uuid; n bigint;
begin
  select * into f from fx;
  j1 := pg_temp.mkjob(f.co_u, 'd1'); j2 := pg_temp.mkjob(f.co_u, 'd2');
  a1 := pg_temp.mkapp(f.u, j1); a2 := pg_temp.mkapp(f.u, j2);
  perform pg_temp.expect(pg_temp.mv(a2, array['none'], 'sent', 'submission.marked', 'person', 'm:' || a2), 'ok', 'mark sent');

  n := pg_temp.as_user(f.u, format('delete from public.applications where id = %L', a2));
  if n <> 0 or not exists (select 1 from public.applications where id = a2) then raise exception 'a session deleted a sent application'; end if;
  n := pg_temp.as_user(f.u, format('delete from public.applications where id = %L', a1));
  if n <> 1 then raise exception 'a session must delete an application Cello never worked on'; end if;

  -- A company with a sent application stays; an empty one goes.
  n := pg_temp.as_user(f.u, format('delete from public.companies where id = %L', f.co_u));
  if n <> 0 or not exists (select 1 from public.companies where id = f.co_u) then raise exception 'a session deleted a company that holds a sent application'; end if;
  insert into public.companies (id, user_id, name, career_url) values (gen_random_uuid(), f.u, 'Empty Co', 'https://empty.example');
  n := pg_temp.as_user(f.u, format('delete from public.companies where user_id = %L and name = %L', f.u, 'Empty Co'));
  if n <> 1 then raise exception 'a session must delete a company that holds nothing'; end if;
end $$;

-- The timeline is the person's to read, and nobody's to write from a session.
do $$
declare f record; n bigint;
begin
  select * into f from fx;
  if pg_temp.as_user(f.u, 'select 1 from public.pipeline_events limit 1') < 1 then raise exception 'the person must read their own events'; end if;
  if pg_temp.as_user(f.v, format('select 1 from public.pipeline_events where user_id = %L', f.u)) <> 0 then raise exception 'a person read another person''s events'; end if;
  begin
    perform pg_temp.as_user(f.u, format('insert into public.pipeline_events (user_id, kind, actor, sentence, idempotency_key) values (%L, %L, %L, %L, %L)', f.u, 'step.started', 'person', 'x', 'direct'));
    raise exception 'a session wrote an event';
  exception when insufficient_privilege then null; end;
  begin
    perform pg_temp.as_user(f.u, format('select public.pipeline_pause(%L)', f.u));
    raise exception 'a session called pipeline_pause';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. One move, one event; a replay moves nothing; the path of an application
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; r jsonb; r2 jsonb; ev public.pipeline_events;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'p1'));

  r := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'p1:start');
  perform pg_temp.expect(r, 'ok', 'a row with no state may start');
  if (select state from public.applications where id = a) <> 'preparing' then raise exception 'the state did not move'; end if;
  if (select count(*) from public.pipeline_events where application_id = a) <> 1 then raise exception 'a move writes one event'; end if;
  select * into ev from public.pipeline_events where application_id = a;
  if ev.from_state is not null or ev.to_state <> 'preparing' or ev.trust <> 'person' or ev.origin <> 'person' then raise exception 'the event records the move and who made it: %', to_jsonb(ev); end if;
  if (select posting_url_hash from public.applications where id = a) is null then raise exception 'the start sets the posting hash'; end if;

  -- replay
  r2 := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'p1:start');
  if not (r2 ->> 'replay')::boolean or r2 -> 'event' ->> 'id' <> r -> 'event' ->> 'id' then raise exception 'a replay must return the first event, got %', r2; end if;
  if (select count(*) from public.pipeline_events where application_id = a) <> 1 then raise exception 'a replay wrote a second event'; end if;

  -- stale: the caller thinks it is ready
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.started', 'extension', 'p1:stale'), 'stale', 'a move from the wrong state');

  -- the path: needs you, an answer, ready, applying, sent by the extension
  perform pg_temp.expect(pg_temp.mv(a, array['preparing'], 'needs_you', 'question.asked', 'schedule', 'p1:ask', '{}', null, 'answer', '{"question": "x"}'), 'ok', 'needs you');
  if (select needs_reason from public.applications where id = a) <> 'answer' then raise exception 'needs_reason holds the one reason'; end if;
  perform pg_temp.expect(pg_temp.mv(a, array['needs_you'], 'preparing', 'question.answered', 'person', 'p1:ans'), 'ok', 'answered');
  if (select needs_reason from public.applications where id = a) is not null then raise exception 'the reason clears when the person answers'; end if;
  perform pg_temp.expect(pg_temp.mv(a, array['preparing'], 'ready', 'step.finished', 'schedule', 'p1:ready'), 'ok', 'ready');
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.started', 'extension', 'p1:fill'), 'ok', 'applying');
  perform pg_temp.expect(pg_temp.mv(a, array['applying'], 'sent', 'submission.sent', 'extension', 'p1:sent'), 'ok', 'sent');
  if (select stage from public.applications where id = a) <> 'applied' or (select applied_at from public.applications where id = a) is null then
    raise exception 'a send sets the stage to applied and applied_at';
  end if;
  if (select count(*) from public.pipeline_events where application_id = a) <> 6 then raise exception 'every move is one event'; end if;
end $$;

-- needs_you without its one reason is a mistake
do $$
declare f record; a uuid;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'p2'));
  begin
    perform pg_temp.mv(a, array['none'], 'needs_you', 'question.asked', 'schedule', 'p2:ask');
    raise exception 'a move to needs_you without a reason was accepted';
  exception when raise_exception then
    if sqlerrm not like '%one reason%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The person-only and extension-only kinds
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; k text;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'k1'));
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'k1:start'), 'ok', 'start');
  perform pg_temp.expect(pg_temp.mv(a, array['preparing'], 'ready', 'step.finished', 'schedule', 'k1:ready'), 'ok', 'ready');

  foreach k in array array['submission.marked', 'submission.retracted', 'approval.decided', 'application.duplicate_override',
                           'application.send_allowed', 'autonomy.changed', 'stage.changed', 'question.answered'] loop
    perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'ready', k, 'cello', 'k1:cello:' || k, '{"channel": "chat"}'), 'person_only', k || ' by cello');
    perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'ready', k, 'rule', 'k1:rule:' || k), 'person_only', k || ' by the rule');
    perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'ready', k, 'extension', 'k1:ext:' || k), 'person_only', k || ' by the extension');
    -- a note refuses them too, except what Cello saved from chat
    if k <> 'question.answered' then
      perform pg_temp.expect(pg_temp.note(f.u, a, k, 'cello', 'k1:note:' || k), 'person_only', k || ' noted by cello');
    end if;
  end loop;

  -- A chat answer saved by Cello is a note that moves nothing.
  perform pg_temp.expect(pg_temp.note(f.u, a, 'question.answered', 'cello', 'k1:chat-answer', '{"payload": {"from": "chat"}}'), 'ok', 'a chat answer noted by cello');
  if (select state from public.applications where id = a) <> 'ready' then raise exception 'a note moved the application'; end if;

  foreach k in array array['fill.auto_started', 'submission.sending'] loop
    perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', k, 'person', 'k1:p:' || k), 'extension_only', k || ' by the person');
    perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', k, 'cello', 'k1:c:' || k), 'extension_only', k || ' by cello');
    perform pg_temp.expect(pg_temp.note(f.u, a, k, 'extension', 'k1:n:' || k), 'extension_only', k || ' noted');
  end loop;

  -- The person writes them all.
  perform pg_temp.expect(pg_temp.note(f.u, a, 'application.send_allowed', 'person', 'k1:allowed'), 'ok', 'the person lets Cello send');
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'sent', 'submission.marked', 'person', 'k1:marked'), 'ok', 'the person marks it sent');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Caps and ceilings, in the person's day
-- ---------------------------------------------------------------------------

do $$
declare f record; i int; a uuid; r jsonb; ok_n int := 0;
begin
  select * into f from fx;
  -- the 11th start by Cello in a day is refused, the first 10 are not
  for i in 1..11 loop
    a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'cap-c-' || i));
    r := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'cello', 'cap-c:' || a, '{"channel": "chat"}');
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 10 or r ->> 'refusal' <> 'cap' then raise exception 'cello may start 10 a day, got % and %', ok_n, r; end if;
  -- a person's own start is not capped
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'cap-p'));
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'cap-p:' || a), 'ok', 'the person starts past cello''s cap');
end $$;

do $$
declare f record; i int; a uuid; r jsonb; ok_n int := 0;
begin
  select * into f from fx;
  -- the rule states a cap of 3; the 4th is refused
  for i in 1..4 loop
    a := pg_temp.mkapp(f.v, pg_temp.mkjob(f.co_v, 'cap-r-' || i));
    r := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'rule', 'cap-r:' || a, '{}', '{"kind": "application.created", "actor": "rule", "max": 3}');
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 3 or r ->> 'refusal' <> 'cap' then raise exception 'the rule stated 3 a day, got % and %', ok_n, r; end if;
  -- the ceiling of 10 holds whatever the caller says
  ok_n := 3;
  for i in 5..12 loop
    a := pg_temp.mkapp(f.v, pg_temp.mkjob(f.co_v, 'cap-r-' || i));
    r := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'rule', 'cap-r:' || a, '{}', '{"kind": "application.created", "actor": "rule", "max": 50}');
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 10 or r ->> 'refusal' <> 'cap' then raise exception 'a rule starts at most 10 a day whatever it says, got % and %', ok_n, r; end if;
end $$;

do $$
declare f record; i int; a uuid; r jsonb; ok_n int := 0;
begin
  select * into f from fx;
  -- a demo starts 3 a day, from any actor
  for i in 1..4 loop
    a := pg_temp.mkapp(f.demo, pg_temp.mkjob(f.co_demo, 'cap-d-' || i));
    r := pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'cap-d:' || a);
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 3 or r ->> 'refusal' <> 'cap' then raise exception 'a demo starts 3 a day, got % and %', ok_n, r; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Pause
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; r jsonb;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.v, pg_temp.mkjob(f.co_v, 'pause-1'));
  r := public.pipeline_pause(f.v);
  if not (r ->> 'ok')::boolean or (r ->> 'already')::boolean then raise exception 'pause: %', r; end if;
  if not (public.pipeline_pause(f.v) ->> 'already')::boolean then raise exception 'a second pause is a no-op'; end if;
  if (select preferences -> 'pipeline' ->> 'paused_at' from public.profiles where id = f.v) is null then raise exception 'pause sets paused_at'; end if;

  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'pause:' || a), 'paused', 'a start while paused');
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'needs_you', 'application.duplicate', 'person', 'pause-d:' || a, '{}', null, 'duplicate'), 'ok', 'a move to needs you is not a start');

  if not (public.pipeline_resume(f.v) ->> 'ok')::boolean then raise exception 'resume'; end if;
  if (select preferences -> 'pipeline' ->> 'paused_at' from public.profiles where id = f.v) is not null then raise exception 'resume clears paused_at'; end if;
  perform pg_temp.expect(pg_temp.mv(a, array['needs_you'], 'preparing', 'application.resumed', 'person', 'resume:' || a), 'ok', 'a start after resume');
  if (select count(*) from public.pipeline_events where user_id = f.v and kind in ('pipeline.paused', 'pipeline.resumed')) <> 2 then raise exception 'pause and resume are events'; end if;
end $$;

-- Paused for one application: it goes back to what it was.
do $$
declare f record; a uuid;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 'pause-2'));
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'preparing', 'application.created', 'person', 'pz:s:' || a), 'ok', 'start');
  perform pg_temp.expect(pg_temp.mv(a, array['preparing'], 'paused', 'application.paused', 'person', 'pz:p:' || a), 'ok', 'pause one');
  if (select state_before_pause from public.applications where id = a) <> 'preparing' then raise exception 'the state before the pause is kept'; end if;
  perform pg_temp.expect(pg_temp.mv(a, array['paused'], 'preparing', 'application.resumed', 'person', 'pz:r:' || a), 'ok', 'resume one');
  if (select state_before_pause from public.applications where id = a) is not null then raise exception 'the kept state clears on resume'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. A posting sent once cannot be started again; what was sent survives its application
-- ---------------------------------------------------------------------------

do $$
declare f record; j1 uuid; j2 uuid; a1 uuid; a2 uuid; hash text; r jsonb;
begin
  select * into f from fx;
  j1 := pg_temp.mkjob(f.co_u, 'blk');
  a1 := pg_temp.mkapp(f.u, j1);
  perform pg_temp.expect(pg_temp.mv(a1, array['none'], 'sent', 'submission.sent', 'extension', 'blk:sent:' || a1), 'ok', 'sent');
  hash := (select posting_url_hash from public.applications where id = a1);
  insert into public.application_attempts (application_id, user_id, submitted_at, destination, documents, attempt_outcome)
  values (a1, f.u, now(), 'company site', '[]', 'sent');

  -- Delete the application and its job: the event and the attempt stay.
  delete from public.jobs where id = j1;
  if exists (select 1 from public.applications where id = a1) then raise exception 'the application should be gone with its job'; end if;
  if not exists (select 1 from public.pipeline_events where kind = 'submission.sent' and posting_url_hash = hash and application_id is null) then raise exception 'submission.sent must survive'; end if;
  if (select count(*) from public.application_attempts where user_id = f.u and application_id is null and attempt_outcome = 'sent') <> 1 then raise exception 'the attempt must survive with no application'; end if;

  -- The same posting again.
  j2 := pg_temp.mkjob(f.co_u, 'blk');
  a2 := pg_temp.mkapp(f.u, j2);
  if public.posting_url_hash((select url from public.jobs where id = j2)) <> hash then raise exception 'the same address must give the same hash'; end if;
  perform pg_temp.expect(pg_temp.mv(a2, array['none'], 'preparing', 'application.created', 'rule', 'blk:rule:' || a2), 'send_block', 'the rule starts a sent posting');
  perform pg_temp.expect(pg_temp.mv(a2, array['none'], 'preparing', 'application.created', 'cello', 'blk:cello:' || a2, '{"channel": "chat"}'), 'send_block', 'chat starts a sent posting');
  -- The person's start is refused here and becomes "Already applied?" in code.
  perform pg_temp.expect(pg_temp.mv(a2, array['none'], 'preparing', 'application.created', 'person', 'blk:person:' || a2), 'send_block', 'the person starts a sent posting');
  perform pg_temp.expect(pg_temp.mv(a2, array['none'], 'needs_you', 'application.duplicate', 'person', 'blk:dup:' || a2, '{}', null, 'duplicate', '{"earlier": true}'), 'ok', 'already applied');
  -- Apply anyway is the person's, and releases the posting.
  perform pg_temp.expect(pg_temp.note(f.u, a2, 'application.duplicate_override', 'cello', 'blk:ov-c:' || a2), 'person_only', 'cello applies anyway');
  perform pg_temp.expect(pg_temp.note(f.u, a2, 'application.duplicate_override', 'person', 'blk:ov:' || a2), 'ok', 'apply anyway');
  perform pg_temp.expect(pg_temp.mv(a2, array['needs_you'], 'preparing', 'application.created', 'rule', 'blk:rule2:' || a2), 'ok', 'a start after apply anyway');

  -- A retraction releases a posting too.
  perform pg_temp.expect(pg_temp.mv(a2, array['preparing'], 'sent', 'submission.marked', 'person', 'blk:m2:' || a2), 'ok', 'marked sent');
  if not public.pipeline_send_blocked(f.u, hash) then raise exception 'a marked send blocks'; end if;
  perform pg_temp.expect(pg_temp.note(f.u, a2, 'submission.retracted', 'cello', 'blk:rt-c:' || a2), 'person_only', 'cello retracts');
  perform pg_temp.expect(pg_temp.note(f.u, a2, 'submission.retracted', 'person', 'blk:rt:' || a2), 'ok', 'the person retracts');
  if public.pipeline_send_blocked(f.u, hash) then raise exception 'a retraction releases the posting'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. T10, stage changes, the hash
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; k text;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.u, pg_temp.mkjob(f.co_u, 't10'));
  foreach k in array array['stage.changed', 'submission.sent', 'submission.marked', 'submission.confirmed'] loop
    begin
      insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, trust, idempotency_key)
      values (f.u, a, k, 'person', 'x', 'unconfirmed', 't10:' || k);
      raise exception 'an unconfirmed % was accepted', k;
    exception when check_violation then null; end;
  end loop;
  -- through the function too
  begin
    perform pg_temp.note(f.u, a, 'stage.changed', 'person', 't10:fn', '{"trust": "unconfirmed", "payload": {"stage": "applied"}}');
    raise exception 'pipeline_note accepted an unconfirmed stage change';
  exception when check_violation then null; end;
  -- a suggestion may be unconfirmed: it moves no count
  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, trust, idempotency_key)
  values (f.u, a, 'stage.suggested', 'email', 'x', 'unconfirmed', 't10:suggest');
  if (select value from public.measure_t10()) <> 0 or not (select passed from public.measure_t10()) then raise exception 'T10 must be 0'; end if;

  -- A stage change by the person sets the stage, applied_at and closed_reason in the same step.
  perform pg_temp.expect(pg_temp.note(f.u, a, 'stage.changed', 'person', 't10:stage', '{"payload": {"stage": "rejected", "closed_reason": "rejected"}}'), 'ok', 'a stage change');
  if (select stage from public.applications where id = a) <> 'rejected' or (select closed_reason from public.applications where id = a) <> 'rejected' then raise exception 'the stage change must set the stage'; end if;
  perform pg_temp.expect(pg_temp.note(f.u, a, 'stage.changed', 'cello', 't10:stage-c', '{"payload": {"stage": "offer"}}'), 'person_only', 'cello changes the stage');
  if (select stage from public.applications where id = a) <> 'rejected' then raise exception 'a refused stage change moved the stage'; end if;
end $$;

do $$
begin
  -- the same address gives the same hash as the code (lib/pipeline/posting.ts pins the same three)
  if public.posting_url_hash('https://www.Example.com/jobs/1/?utm=x#a') <> '146b9aaefc0354376878bb90633bb37a42fcf4d392fe9c7139a04b6ca3960a58' then raise exception 'hash 1'; end if;
  if public.posting_url_hash('https://boards.greenhouse.io/stripe/jobs/123') <> '79bd0d6270c0f4a50e82f1ff93943496b94558ad0d9d315edb699d90e79b6b8c' then raise exception 'hash 2'; end if;
  if public.posting_url_hash('https://careers.example.com/open?gh_jid=987&x=1') <> '92381f34147564b691b88f3afd15096e00c0078dc091847ec56595214dd27db6' then raise exception 'hash 3'; end if;
  if public.posting_url_hash('  ') is not null then raise exception 'an empty address has no hash'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Following has one writer
-- ---------------------------------------------------------------------------

do $$
declare f record; c uuid; r jsonb; i int;
begin
  select * into f from fx;
  begin
    update public.companies set watching = true where id = f.co_u and false;
    insert into public.companies (user_id, name, career_url, watching) values (f.u, 'Sneaky Co', 'https://sneaky.example', true);
    raise exception 'watching = true outside companies_follow was accepted';
  exception when insufficient_privilege then null; end;

  -- a company added by anyone else starts unfollowed
  insert into public.companies (id, user_id, name, career_url) values (gen_random_uuid(), f.u, 'Lead Co', 'https://lead.example') returning id into c;
  if (select watching from public.companies where id = c) then raise exception 'a new company must start unfollowed'; end if;
  begin
    update public.companies set watching = true where id = c;
    raise exception 'an update to watching = true was accepted';
  exception when insufficient_privilege then null; end;

  -- the session follows its own through the function, and not another person's
  if pg_temp.as_user(f.u, format('select public.companies_follow(array[%L::uuid], true)', c)) <> 1 then raise exception 'follow as the person'; end if;
  if not (select watching and followed_at is not null from public.companies where id = c) then raise exception 'follow sets watching and followed_at'; end if;
  begin
    perform pg_temp.as_user(f.u, format('select public.companies_follow(array[%L::uuid], true, %L)', c, f.v));
    raise exception 'a session followed for another person';
  exception when insufficient_privilege then null; end;
  perform public.companies_follow(array[c], false, f.u);
  if (select watching or followed_at is not null from public.companies where id = c) then raise exception 'unfollow clears watching and followed_at'; end if;
  if (select value from public.measure_t9()) <> 0 then raise exception 'T9 must be 0, got %', (select value from public.measure_t9()); end if;

  -- pins: followed companies only, at most 5
  r := public.companies_follow(array[c], null, f.u, true);
  if r ->> 'refusal' <> 'not_followed' then raise exception 'a pin on an unfollowed company: %', r; end if;
  for i in 1..6 loop
    insert into public.companies (id, user_id, name, career_url) values (gen_random_uuid(), f.u, 'Pin ' || i, 'https://pin' || i || '.example') returning id into c;
    perform public.companies_follow(array[c], true, f.u);
    r := public.companies_follow(array[c], null, f.u, true);
    if i <= 5 and r ->> 'ok' is distinct from 'true' then
      raise exception 'pin % should be accepted: %', i, r;
    end if;
  end loop;
  if (select count(*) from public.companies where user_id = f.u and is_dream_company) <> 5 then raise exception 'at most 5 pins, got %', (select count(*) from public.companies where user_id = f.u and is_dream_company); end if;
  if r ->> 'refusal' <> 'pin_cap' then raise exception 'the 6th pin must be refused: %', r; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Send for me
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; r jsonb; claim jsonb; lease text; sending jsonb; again jsonb;
begin
  select * into f from fx;
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', f.tok));
  a := pg_temp.allowed_app(f.u, f.co_u, 's-main');

  if public.pipeline_auto_send_reason(a) is not null then raise exception 'the happy case must be allowed, got: %', public.pipeline_auto_send_reason(a); end if;

  -- the switch off
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'me', 'maxPerDay', 3, 'tokenId', f.tok));
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:off', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'send_off', 'switch off');
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', f.tok));

  -- another extension token
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:tok', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok2))), 'token', 'another token');

  -- paused
  perform public.pipeline_pause(f.u);
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:paused', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'paused', 'paused');
  perform public.pipeline_resume(f.u);

  -- the token unseen for 24 hours
  update public.api_tokens set last_used_at = now() - interval '25 hours' where id = f.tok;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:seen', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'token unseen for 24 hours');
  update public.api_tokens set last_used_at = now() where id = f.tok;

  -- Possible
  update public.person_roles set chance = 'possible' where user_id = f.u and job_id = (select job_id from public.applications where id = a);
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:possible', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'a Possible match');
  update public.person_roles set chance = 'strong' where user_id = f.u and job_id = (select job_id from public.applications where id = a);

  -- a company the person does not follow
  perform public.companies_follow(array[f.co_u], false, f.u);
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:unfollowed', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'an unfollowed company');
  perform public.companies_follow(array[f.co_u], true, f.u);

  -- a Reviewer-only resume: tailored, never approved
  update public.applications set resume_artifact_id = gen_random_uuid() where id = a;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:reviewer', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'a resume the person did not approve');
  if public.pipeline_auto_send_reason(a) <> 'Approve the resume to let Cello send this.' then raise exception 'the sentence for an unapproved resume: %', public.pipeline_auto_send_reason(a); end if;
  -- approved...
  perform pg_temp.expect(pg_temp.note(f.u, a, 'approval.decided', 'person', 's:approve', '{"payload": {"what": "resume", "hash": "h1"}}'), 'ok', 'the person approves the resume');
  if public.pipeline_auto_send_reason(a) is not null then raise exception 'an approved resume must be allowed, got: %', public.pipeline_auto_send_reason(a); end if;
  -- ...then a newer version
  perform pg_temp.note(f.u, a, 'step.finished', 'schedule', 's:retailor', '{"payload": {"resume_changed": "true"}}');
  if public.pipeline_auto_send_reason(a) <> 'The resume changed after you approved it.' then raise exception 'the sentence for a changed resume: %', public.pipeline_auto_send_reason(a); end if;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:changed', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'a resume changed after approval');
  update public.applications set resume_artifact_id = null where id = a;

  -- a send-blocked posting
  insert into public.pipeline_events (user_id, application_id, posting_url_hash, kind, actor, sentence, trust, idempotency_key)
  select f.u, null, posting_url_hash, 'submission.marked', 'person', 'x', 'person', 's:blocked' from public.applications where id = a;
  if public.pipeline_auto_send_reason(a) not like 'You already sent this one%' then raise exception 'a blocked posting: %', public.pipeline_auto_send_reason(a); end if;
  delete from public.pipeline_events where idempotency_key = 's:blocked';

  -- the claim
  if public.pipeline_auto_send_reason(a) is not null then raise exception 'back to allowed, got %', public.pipeline_auto_send_reason(a); end if;
  claim := pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:claim',
                      jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'auto', true, 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'aa')))));
  perform pg_temp.expect(claim, 'ok', 'the claim');
  lease := claim ->> 'lease_holder';
  if lease is null or (select lease_holder::text from public.applications where id = a) <> lease then raise exception 'the claim holds the lease'; end if;
  if (select auto_attempted_at from public.applications where id = a) is null then raise exception 'the claim is recorded and never cleared'; end if;
  if (select lease_until from public.applications where id = a) <= now() + interval '9 minutes' then raise exception 'an automatic lease is 10 minutes'; end if;

  -- a second claim: never
  update public.applications set state = 'ready' where id = a;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's:claim2', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'a second claim');
  update public.applications set state = 'applying' where id = a;

  -- the session serves the files
  perform pg_temp.expect(pg_temp.note(f.u, a, 'fill.started', 'extension', 's:fill', jsonb_build_object('payload', jsonb_build_object('auto', true, 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'aa'))))), 'ok', 'fill started');

  -- the Send step: another lease holder, another file
  perform pg_temp.expect(pg_temp.mv(a, array['applying'], 'applying', 'submission.sending', 'extension', 'sending:' || a,
    jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'lease_holder', gen_random_uuid(), 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'aa'))))), 'lease', 'another lease holder');
  perform pg_temp.expect(pg_temp.mv(a, array['applying'], 'applying', 'submission.sending', 'extension', 'sending:' || a,
    jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'lease_holder', lease, 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'bb'))))), 'files', 'another file hash');
  sending := pg_temp.mv(a, array['applying'], 'applying', 'submission.sending', 'extension', 'sending:' || a,
    jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'lease_holder', lease, 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'aa')))));
  perform pg_temp.expect(sending, 'ok', 'the Send step');
  -- a replay returns the first event: the extension does not click
  again := pg_temp.mv(a, array['applying'], 'applying', 'submission.sending', 'extension', 'sending:' || a,
    jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'lease_holder', lease, 'files', jsonb_build_array(jsonb_build_object('name', 'resume.pdf', 'sha256', 'aa')))));
  if not (again ->> 'replay')::boolean or again -> 'event' ->> 'id' <> sending -> 'event' ->> 'id' then raise exception 'submission.sending must replay its first event, got %', again; end if;
  if (select count(*) from public.pipeline_events where application_id = a and kind = 'submission.sending') <> 1 then raise exception 'one Send step per application'; end if;
  -- Pause between the claim and the click stops the Send step of another key
  perform public.pipeline_pause(f.u);
  perform pg_temp.expect(pg_temp.mv(a, array['applying'], 'applying', 'submission.sending', 'extension', 'sending2:' || a, jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'paused', 'a Send step while paused');
  perform public.pipeline_resume(f.u);
end $$;

-- Chosen by the person, or not
do $$
declare f record; a uuid;
begin
  select * into f from fx;
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', f.tok));
  -- started from chat: not allowed, and allowed after the person lets Cello send it
  delete from public.pipeline_events where user_id = f.u and kind = 'application.created' and actor = 'cello';
  a := pg_temp.allowed_app(f.u, f.co_u, 's-chat', 'cello');
  if public.pipeline_auto_send_reason(a) <> 'You did not choose this one. Let Cello send this?' then raise exception 'a chat start: %', public.pipeline_auto_send_reason(a); end if;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's-chat:claim', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'not_allowed', 'a chat-started application');
  perform pg_temp.expect(pg_temp.note(f.u, a, 'application.send_allowed', 'person', 's-chat:allow'), 'ok', 'let Cello send this');
  if public.pipeline_auto_send_reason(a) is not null then raise exception 'after send_allowed, got %', public.pipeline_auto_send_reason(a); end if;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's-chat:claim2', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'auto', true))), 'ok', 'a claim after send_allowed');
end $$;

-- Waiting more than 24 hours
do $$
declare f record; a uuid;
begin
  select * into f from fx;
  a := pg_temp.allowed_app(f.u, f.co_u, 's-old');
  update public.pipeline_events set created_at = now() - interval '25 hours' where application_id = a and to_state = 'ready';
  if public.pipeline_auto_send_reason(a) not like 'This has waited more than a day%' then raise exception 'ready for 25 hours: %', public.pipeline_auto_send_reason(a); end if;
end $$;

-- A demo is never sent for
do $$
declare f record; a uuid;
begin
  select * into f from fx;
  perform pg_temp.set_send(f.demo, jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', f.tok));
  a := pg_temp.mkapp(f.demo, pg_temp.mkjob(f.co_demo, 'demo-s'));
  update public.applications set state = 'ready' where id = a;
  perform pg_temp.expect(pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 'demo:claim', jsonb_build_object('payload', jsonb_build_object('token_id', f.tok))), 'demo', 'a demo claim');
end $$;

-- The day's tries: 3 under a cap of 3, and 10 under any cap
do $$
declare f record; i int; a uuid; r jsonb; ok_n int := 0;
begin
  select * into f from fx;
  -- a fresh person for a clean day
  delete from public.pipeline_events where user_id = f.u and kind = 'fill.auto_started';
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', f.tok));
  for i in 1..4 loop
    a := pg_temp.allowed_app(f.u, f.co_u, 's-cap3-' || i);
    r := pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's-cap3:' || a, jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'auto', true)));
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 3 or r ->> 'refusal' <> 'cap' then raise exception 'a send cap of 3 admits 3 claims, got % and %', ok_n, r; end if;

  delete from public.pipeline_events where user_id = f.u and kind = 'fill.auto_started';
  perform pg_temp.set_send(f.u, jsonb_build_object('mode', 'auto', 'maxPerDay', 50, 'tokenId', f.tok));
  ok_n := 0;
  for i in 1..11 loop
    a := pg_temp.allowed_app(f.u, f.co_u, 's-cap50-' || i);
    r := pg_temp.mv(a, array['ready'], 'applying', 'fill.auto_started', 'extension', 's-cap50:' || a, jsonb_build_object('payload', jsonb_build_object('token_id', f.tok, 'auto', true)));
    if (r ->> 'ok')::boolean then ok_n := ok_n + 1; end if;
  end loop;
  if ok_n <> 10 or r ->> 'refusal' <> 'cap' then raise exception 'at most 10 automatic claims a day whatever the setting, got % and %', ok_n, r; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. The trim keeps what the send block reads
-- ---------------------------------------------------------------------------

do $$
declare f record; a uuid; n int;
begin
  select * into f from fx;
  a := pg_temp.mkapp(f.v, pg_temp.mkjob(f.co_v, 'trim'));
  perform pg_temp.expect(pg_temp.mv(a, array['none'], 'sent', 'submission.sent', 'extension', 'trim:sent:' || a), 'ok', 'sent');
  perform pg_temp.note(f.v, a, 'step.finished', 'schedule', 'trim:step');
  update public.pipeline_events set created_at = now() - interval '100 days' where application_id = a;
  n := public.prune_pipeline_events();
  if n < 1 then raise exception 'the trim must delete an old step line'; end if;
  if not exists (select 1 from public.pipeline_events where application_id = a and kind = 'submission.sent') then raise exception 'the trim kept no milestone'; end if;
  if exists (select 1 from public.pipeline_events where application_id = a and kind = 'step.finished') then raise exception 'the trim must delete a step line older than 90 days'; end if;
end $$;

rollback;
