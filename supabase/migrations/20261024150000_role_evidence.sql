-- K17b strengths and gaps: what a model judged or the person corrected about one role (blueprint 3.3).
--
-- Code verdicts (a requirement found in the person's own words, with its quote) are computed on read and
-- never stored. Only the two kinds of verdict that cost something or belong to the person are kept:
-- a model step's reading of the requirements code could not settle, and the person's corrections.
-- Each row is stale when the posting's text (`desc_md5`) or the person's material (`material_key`: the base
-- resume version, saved answers, profile facts) changed, and is recomputed only then.
--
-- Owner-only: a person reads and updates their own rows. The server writes with the service role, so a
-- verdict always carries its origin and provenance. Deleted with the role (and with the person's row for it
-- once person_roles exists), and after 30 days when the role has no save, reaction or application.

create table if not exists public.role_evidence (
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  -- per requirement id: strength, gap or unknown, with evidence [{source, ref, quote}] and who decided
  items jsonb not null,
  origin text not null check (origin in ('person', 'code', 'model')),
  prov jsonb,
  confirmed_at timestamptz,
  desc_md5 text,
  material_key text not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create index if not exists idx_role_evidence_computed on public.role_evidence (computed_at);

-- lane-stub: K5a person_roles
do $fk$
begin
  if to_regclass('public.person_roles') is not null
     and not exists (select 1 from pg_constraint where conrelid = 'public.role_evidence'::regclass and conname = 'role_evidence_person_roles_fkey') then
    alter table public.role_evidence
      add constraint role_evidence_person_roles_fkey foreign key (user_id, job_id) references public.person_roles (user_id, job_id) on delete cascade;
  else
    raise notice 'lane-stub: K5a person_roles absent, role_evidence follows the job only';
  end if;
end
$fk$;

alter table public.role_evidence enable row level security;

drop policy if exists "own role_evidence select" on public.role_evidence;
create policy "own role_evidence select" on public.role_evidence
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own role_evidence update" on public.role_evidence;
create policy "own role_evidence update" on public.role_evidence
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on table public.role_evidence from public, anon, authenticated;
grant select, update on table public.role_evidence to authenticated;
grant all on table public.role_evidence to service_role;

-- Rows older than 30 days for a role the person never saved, reacted to or applied for.
create or replace function public.prune_role_evidence()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
  saved_sql text := '';
begin
  if to_regclass('public.person_roles') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'person_roles' and column_name = 'saved_at') then
    saved_sql := ' and not exists (select 1 from public.person_roles p where p.user_id = e.user_id and p.job_id = e.job_id and p.saved_at is not null)';
  end if;
  execute 'with gone as (delete from public.role_evidence e where e.computed_at < now() - interval ''30 days''' ||
          ' and not exists (select 1 from public.role_reactions r where r.user_id = e.user_id and r.job_id = e.job_id)' ||
          ' and not exists (select 1 from public.applications a where a.user_id = e.user_id and a.job_id = e.job_id)' ||
          saved_sql || ' returning 1) select count(*) from gone' into removed;
  return removed;
end
$$;
revoke all on function public.prune_role_evidence() from public, anon, authenticated;
grant execute on function public.prune_role_evidence() to service_role;

-- Daily, when the database has a clock.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('prune-role-evidence', '17 4 * * *', 'select public.prune_role_evidence()');
  end if;
exception when others then
  raise notice 'role_evidence prune not scheduled: %', sqlerrm;
end
$cron$;

-- The model step stays off until the owner turns it on (S20). Absent row reads as off, so this is only the
-- visible row. instance_flags comes with K5c: where it is not there yet, the row is added when it lands.
do $flag$
begin
  if to_regclass('public.instance_flags') is not null then
    execute 'insert into public.instance_flags (key, "on", note) values ($1, false, $2) on conflict (key) do nothing'
      using 'role_evidence_live', 'role.evidence model step (strengths and gaps), off until S20 passes';
  end if;
exception when others then
  raise notice 'role_evidence_live flag not added: %', sqlerrm;
end
$flag$;

notify pgrst, 'reload schema';

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.role_evidence'::regclass) then
    raise exception 'row level security is off on role_evidence';
  end if;
  if has_table_privilege('anon', 'public.role_evidence', 'select') or has_table_privilege('authenticated', 'public.role_evidence', 'insert') then
    raise exception 'role_evidence is open to the wrong roles';
  end if;
end
$$;
