-- Interview prep was removed from Cello. A2A keeps its two research agents,
-- and the prep kits table goes. App code stopped reading both in the same
-- release, so apply this after that release is deployed.

do $$
declare c record;
begin
  if to_regclass('public.a2a_tasks') is not null then
    delete from public.a2a_tasks where agent = 'interview_prep';

    -- The agent check was declared inline, so find it by what it says rather
    -- than by an assumed name.
    for c in
      select conname from pg_constraint
      where conrelid = 'public.a2a_tasks'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%interview_prep%'
    loop
      execute format('alter table public.a2a_tasks drop constraint %I', c.conname);
    end loop;

    alter table public.a2a_tasks drop constraint if exists a2a_tasks_agent_check;
    alter table public.a2a_tasks
      add constraint a2a_tasks_agent_check
      check (agent in ('matcher', 'company_researcher'));

    comment on column public.a2a_tasks.agent is
      'matcher|company_researcher: the read-only agents A2A exposes. Vocabulary owned by lib/a2a/agent.ts.';
  end if;
end $$;

-- No cascade: an unexpected dependent should abort this, not vanish.
drop table if exists public.interview_kits;
