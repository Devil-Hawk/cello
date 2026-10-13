-- Model per role (Chat v2, acceptance A1 to A3): each ledger row says which role asked (chat, researcher, writer, worker)
-- and the thinking effort the call ran with, so the line under an answer is read from rows, step-downs included.
-- Additive: both columns are nullable, and a row written by an older server leaves them empty.

alter table public.llm_spend add column if not exists role text check (role is null or role in ('chat', 'researcher', 'writer', 'worker'));
alter table public.llm_spend add column if not exists effort text check (effort is null or effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'llm_spend' and column_name = 'effort')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'llm_spend' and column_name = 'role') then
    raise exception 'llm_spend is missing role or effort';
  end if;
end $$;
