-- Agent engine, part 6: taste statements.
--
-- WHY
--   What Cello has learned about what the person wants is shown as plain
--   sentences with their evidence ("Prefers small teams: passed on 3 roles at
--   5,000+ person companies"), and the person can edit or delete any of them.
--   A background pass proposes statements from typed reactions (Interested,
--   Not for me with a reason, Applied), never from the text of a posting.
--   The agent reads them as /memories/taste.md, read-only.
--
-- Access: the owner can read, edit the sentence, delete and add their own.
-- Proposals are written by the server.

create table if not exists public.taste_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  statement text not null check (char_length(statement) between 1 and 200),
  evidence jsonb not null default '[]'::jsonb,
  source text not null default 'proposed' check (source in ('proposed', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_taste_statements_user on public.taste_statements (user_id, created_at desc);

alter table public.taste_statements enable row level security;

drop policy if exists "own taste_statements select" on public.taste_statements;
create policy "own taste_statements select" on public.taste_statements
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own taste_statements insert" on public.taste_statements;
create policy "own taste_statements insert" on public.taste_statements
  for insert to authenticated
  with check ((select auth.uid()) = user_id and source = 'user');

drop policy if exists "own taste_statements update" on public.taste_statements;
create policy "own taste_statements update" on public.taste_statements
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own taste_statements delete" on public.taste_statements;
create policy "own taste_statements delete" on public.taste_statements
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.taste_statements from public, anon, authenticated;
grant select, insert, delete on table public.taste_statements to authenticated;
-- Only the sentence is editable by the person; evidence and source are not.
grant update (statement, updated_at) on table public.taste_statements to authenticated;
grant all on table public.taste_statements to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.taste_statements'::regclass and relrowsecurity) then
    raise exception 'row level security is not enabled on taste_statements';
  end if;
  if has_table_privilege('anon', 'public.taste_statements', 'select') then
    raise exception 'anon must not read taste_statements';
  end if;
end
$$;
