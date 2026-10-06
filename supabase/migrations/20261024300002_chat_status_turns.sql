-- Chat, part 4: a status turn for each move of an application a chat is about.
--
-- WHY
--   A person who started an application from Chat expects the chat to say what happens to it: "Cello is filling
--   the form", "Your resume is ready to approve", "Sent". Each state change of an application writes one line in
--   every chat that holds that application as a tile, and in no other chat. Code writes it, from the event row,
--   so no model's words or email subject can forge one: the turn only names the event, and the sentence shown
--   is read from the event.
--
--   pipeline_events belongs to the pipeline package and does not exist until it lands. Until then the trigger is
--   not attached: the function is always defined, and the trigger is attached when the table is there. Apply this
--   file again after the pipeline migration to attach it.
--
--   expand only.

create or replace function public.chat_status_turns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.chat_turns (user_id, chat_id, kind, event_id, origin, prov)
  select new.user_id, a.chat_id, 'status', new.id, 'code', jsonb_build_object('rule', 'pipeline_event')
    from public.chat_attachments a
   where a.user_id = new.user_id
     and a.kind = 'application'
     and a.removed_at is null
     and a.ref ->> 'id' = new.application_id::text;
  return new;
end
$$;

revoke all on function public.chat_status_turns() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.pipeline_events') is not null then
    drop trigger if exists chat_status_turns on public.pipeline_events;
    create trigger chat_status_turns
      after insert on public.pipeline_events
      for each row
      when (new.application_id is not null and new.to_state is not null and new.to_state is distinct from new.from_state)
      execute function public.chat_status_turns();
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'chat_status_turns' and pronamespace = 'public'::regnamespace) then
    raise exception 'chat_status_turns is missing';
  end if;
end
$$;
