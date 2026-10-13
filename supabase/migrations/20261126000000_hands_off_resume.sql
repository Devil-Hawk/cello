-- Hands-off, the resume (Chat v2, acceptance G2, G3): the tailor step now attaches the tailored resume to the
-- application (applications.resume_artifact_id) when the person approved it or Hands-off let it through without a
-- stop, so the extension is handed that version. pipeline_auto_send_reason is copied from 20261125000000 with two
-- clauses changed: the resume clause no longer asks for an approval when the newest start ran under Hands-off and
-- the person does not ask to see each resume first (preferences.pipeline.resumeApproval, the same rule the tailor
-- step applies), and the mode is read from the newest application.created event (a start again writes another), so
-- an application last started in Ask first waits for the person. Every other check stays word for word. Additive:
-- the signature and grants are unchanged.

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
  created_mode text;
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

  -- Chat's start counts as chosen when the turn ran under Hands-off: the newest created event carries the mode code
  -- resolved for that turn (lib/chat/mode.ts), which only the Chat door writes. Every other start by Cello still waits
  -- for the person.
  select e.actor, e.payload ->> 'mode' into creator, created_mode from public.pipeline_events e
   where e.application_id = a.id and e.kind = 'application.created' order by e.created_at desc limit 1;
  if creator is distinct from 'person' and creator is distinct from 'rule' and creator is distinct from 'extension'
     and created_mode is distinct from 'hands_off'
     and not exists (select 1 from public.pipeline_events e where e.application_id = a.id and e.kind = 'application.send_allowed') then
    return 'You did not choose this one. Let Cello send this?';
  end if;

  -- The resume: the base resume, or a tailored one the person approved and that did not change since. Under
  -- Hands-off the tailor step attaches it without a stop unless the person asks to see each resume first
  -- (resumeApproval, true when unset), and this check asks for exactly what that step asked for.
  if a.resume_artifact_id is not null then
    select max(e.created_at) into approved_at from public.pipeline_events e
     where e.application_id = a.id and e.kind = 'approval.decided' and e.actor = 'person' and e.payload ->> 'what' = 'resume';
    if approved_at is null and (created_mode is distinct from 'hands_off' or coalesce((pl ->> 'resumeApproval')::boolean, true)) then
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

do $$
declare
  def text := pg_get_functiondef('public.pipeline_auto_send_reason(uuid)'::regprocedure);
begin
  if position('created_mode is distinct from ''hands_off''' in def) = 0
     or position('coalesce((pl ->> ''resumeApproval'')::boolean, true)' in def) = 0
     or position('order by e.created_at desc limit 1' in def) = 0 then
    raise exception 'pipeline_auto_send_reason lost a hands_off clause';
  end if;
end
$$;
