-- Chat, part 5: a status turn for each step an application finishes, not only for each change of state.
--
-- WHY
--   An application's Preparing is several steps (the posting is open, no earlier application, the base resume, the
--   tailored resume). They happen inside one state, so the trigger of 20261024300002 wrote nothing for them and a
--   person watching the chat saw "Started" and then nothing until a change of state. A finished step, an approval
--   asked for and a question asked now write their line too. The sentence is still read from the event, never typed.
--
--   expand only: the trigger is replaced in place, the function is unchanged.

do $$
begin
  if to_regclass('public.pipeline_events') is not null then
    drop trigger if exists chat_status_turns on public.pipeline_events;
    create trigger chat_status_turns
      after insert on public.pipeline_events
      for each row
      when (
        new.application_id is not null
        and new.to_state is not null
        and (new.to_state is distinct from new.from_state or new.kind in ('step.finished', 'approval.requested', 'question.asked'))
      )
      execute function public.chat_status_turns();
  end if;
end
$$;
