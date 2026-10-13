-- Hands-off (migrations 20261125000000 and 20261126000000): an application Chat started under Hands-off passes the
-- "You did not choose this one" check of pipeline_auto_send_reason, its attached tailored resume needs no approval
-- unless the person asks to see each resume first, the newest start's mode is the one read, and nothing else about
-- that function changed: without the payload a Chat start still waits for the person; Send for me off, a role that
-- is not Strong, and an attached resume in Ask first still refuse in their own words. One transaction, rolled back.
--
--   bash supabase/checks/run.sh supabase/checks/hands_off_send.sql

\set ON_ERROR_STOP 1
begin;

-- Scoring's chance column arrives with K8a; the check needs it, and the transaction rolls back.
alter table public.person_roles add column if not exists chance text;

do $$
declare
  u uuid := 'dddddddd-0000-0000-0000-000000000052';
  co uuid := 'dddddddd-1111-0000-0000-000000000052';
  tok uuid := 'dddddddd-2222-0000-0000-000000000052';
  j uuid := 'dddddddd-3333-0000-0000-000000000052';
  a uuid;
  art uuid;
  r jsonb;
  reason text;
begin
  -- preferences.pipeline is guarded: only set_autonomy() writes it, and this check stands in for it for the transaction.
  perform set_config('cello.autonomy_writer', 'on', true);
  insert into auth.users (id, email) values (u, 'hands-off@example.invalid');
  insert into public.profiles (id, email) values (u, 'hands-off@example.invalid') on conflict (id) do nothing;
  insert into public.api_tokens (id, user_id, name, token_hash, scopes, last_used_at) values (tok, u, 'laptop', 'hash-' || tok, array['fill:extension'], now());
  update public.profiles
     set preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('mode', 'auto', 'maxPerDay', 3, 'tokenId', tok, 'agreedAt', now(), 'agreedVersion', 'send-for-me-1'), 'resumeApproval', false))
   where id = u;
  insert into public.companies (id, user_id, name, career_url) values (co, u, 'Hands Co', 'https://hands.example/jobs');
  perform public.companies_follow(array[co], true, u);
  insert into public.jobs (id, company_id, title, description, url, external_id) values (j, co, 'Engineer', 'd', 'https://hands.example/jobs/1', 'hands-1');
  insert into public.person_roles (user_id, job_id, chance) values (u, j, 'strong') on conflict (user_id, job_id) do update set chance = 'strong';
  insert into public.applications (user_id, job_id) values (u, j) returning id into a;

  -- started from Chat, in Ask first: the created event carries no hands_off, so the person still has to choose it
  r := public.pipeline_transition(a, array['none'], 'preparing', 'Starting', null, null,
         jsonb_build_object('kind', 'application.created', 'actor', 'cello', 'channel', 'chat', 'sentence', 'Cello started preparing this.', 'idempotency_key', 'ho:' || a, 'payload', jsonb_build_object('mode', 'ask')), null);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'start: %', r; end if;
  r := public.pipeline_transition(a, array['preparing'], 'ready', 'Ready to send', null, null,
         jsonb_build_object('kind', 'step.finished', 'actor', 'schedule', 'sentence', 'Everything is prepared.', 'idempotency_key', 'ho-ready:' || a), null);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'ready: %', r; end if;
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'You did not choose this one. Let Cello send this?' then raise exception 'an Ask first start must wait for the person, got: %', reason; end if;

  -- the same application started under Hands-off: allowed
  update public.pipeline_events set payload = jsonb_build_object('mode', 'hands_off') where application_id = a and kind = 'application.created';
  reason := public.pipeline_auto_send_reason(a);
  if reason is not null then raise exception 'a Hands-off start must be allowed, got: %', reason; end if;

  -- the tailored resume the tailor step attached under Hands-off: allowed without an approval while the person does
  -- not ask to see each resume first, and asked for when they do, or when the application was started in Ask first
  insert into public.artifacts (user_id, type, title, job_id) values (u, 'resume', 'Resume for Engineer', j) returning id into art;
  update public.applications set resume_artifact_id = art where id = a;
  reason := public.pipeline_auto_send_reason(a);
  if reason is not null then raise exception 'a Hands-off start with its tailored resume attached must be allowed, got: %', reason; end if;
  update public.profiles set preferences = jsonb_set(preferences, '{pipeline,resumeApproval}', 'true') where id = u;
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'Approve the resume to let Cello send this.' then raise exception 'each resume shown first: %', reason; end if;
  -- ...and the person's approval, the one approveDocument writes, satisfies it
  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, trust, idempotency_key, payload)
  values (u, a, 'approval.decided', 'person', 'You approved the resume.', 'person', 'ho-approve:' || a, jsonb_build_object('decision', 'approved', 'what', 'resume', 'hash', 'h1'));
  reason := public.pipeline_auto_send_reason(a);
  if reason is not null then raise exception 'an approved resume must be allowed, got: %', reason; end if;
  delete from public.pipeline_events where idempotency_key = 'ho-approve:' || a;
  update public.profiles set preferences = jsonb_set(preferences, '{pipeline,resumeApproval}', 'false') where id = u;
  -- with resumeApproval unset the person is asked, as the tailor step would have asked
  update public.profiles set preferences = preferences #- '{pipeline,resumeApproval}' where id = u;
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'Approve the resume to let Cello send this.' then raise exception 'resumeApproval unset: %', reason; end if;
  update public.profiles set preferences = jsonb_set(preferences, '{pipeline,resumeApproval}', 'false') where id = u;

  -- a start again in Ask first is the newest created event: the person chooses again, whatever the first start said
  insert into public.pipeline_events (user_id, application_id, kind, actor, sentence, trust, idempotency_key, payload, created_at)
  values (u, a, 'application.created', 'cello', 'Cello started preparing this again.', 'proven', 'ho-again:' || a, jsonb_build_object('mode', 'ask'), now() + interval '1 second');
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'You did not choose this one. Let Cello send this?' then raise exception 'a start again in Ask first must wait for the person, got: %', reason; end if;
  delete from public.pipeline_events where idempotency_key = 'ho-again:' || a;
  update public.applications set resume_artifact_id = null where id = a;

  -- Send for me off: refused in its own words, whatever the mode said
  update public.profiles set preferences = jsonb_set(preferences, '{pipeline,send,mode}', '"me"') where id = u;
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'Send for me is off.' then raise exception 'Send for me off: %', reason; end if;
  update public.profiles set preferences = jsonb_set(preferences, '{pipeline,send,mode}', '"auto"') where id = u;

  -- not a Strong match: refused in its own words
  update public.person_roles set chance = 'possible' where user_id = u and job_id = j;
  reason := public.pipeline_auto_send_reason(a);
  if reason is distinct from 'Cello sends only Strong matches.' then raise exception 'a possible match: %', reason; end if;
  update public.person_roles set chance = 'strong' where user_id = u and job_id = j;

  -- the claim itself goes through, once
  r := public.pipeline_transition(a, array['ready'], 'applying', 'Sending', null, null,
         jsonb_build_object('kind', 'fill.auto_started', 'actor', 'extension', 'channel', 'extension', 'sentence', 'Send for me started this one.', 'idempotency_key', 'ho-claim:' || a, 'payload', jsonb_build_object('token_id', tok, 'auto', true)), null);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'the claim of a Hands-off application: %', r; end if;
end $$;

rollback;

\echo hands-off send checks passed
