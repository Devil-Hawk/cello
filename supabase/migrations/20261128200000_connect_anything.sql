-- Connect anything: a person's own tools and skills.
--
--   * proposals.kind gains 'mcp': a call to one of the person's own tools, held until they press Confirm.
--   * user_mcp_servers.tool_rules: the tools the person marked Never, { "<tool name as the server names it>": "never" }.
--     Only the value "never" exists.
--   * person_skills: skills the person added (a pasted SKILL.md or an imported folder). They read their own rows;
--     every write goes through the service role in the settings route, so there is no insert, update or delete policy.
--
-- Additive and re-runnable. Nothing is granted to anon or public.

alter table public.proposals drop constraint if exists proposals_kind_check;
alter table public.proposals
  add constraint proposals_kind_check
  check (kind in ('search', 'answers', 'material', 'instructions', 'learned', 'start', 'mcp'));

alter table public.user_mcp_servers
  add column if not exists tool_rules jsonb not null default '{}'::jsonb;

create table if not exists public.person_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9-]{1,64}$'),
  description text not null check (char_length(description) between 1 and 1024),
  body text not null check (char_length(body) <= 200000),
  source text not null check (char_length(source) <= 200),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.person_skills enable row level security;
drop policy if exists "own person_skills select" on public.person_skills;
create policy "own person_skills select" on public.person_skills
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.person_skills from public, anon, authenticated;
grant select on table public.person_skills to authenticated;
grant all on table public.person_skills to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.proposals'::regclass and conname = 'proposals_kind_check'
      and pg_get_constraintdef(oid) like '%''mcp''%'
  ) then
    raise exception 'connect_anything: proposals.kind does not accept mcp';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_mcp_servers' and column_name = 'tool_rules'
  ) then
    raise exception 'connect_anything: user_mcp_servers.tool_rules is missing';
  end if;
  if to_regclass('public.person_skills') is null then
    raise exception 'connect_anything: person_skills is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.person_skills'::regclass) then
    raise exception 'connect_anything: person_skills has no row level security';
  end if;
end
$$;
