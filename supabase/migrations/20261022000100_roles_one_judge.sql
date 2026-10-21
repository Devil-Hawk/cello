-- roles/one-judge (feature 2, PR 1): one function decides whether a posting is inside a person's targets.
--
-- WHY
--   The judge is apps/web/lib/roles/keep.ts (keepsRole). Everything that stores, lists or counts a role asks it,
--   so the SQL twin that only one measure used is gone and T3 is computed from what the judge says.
--
-- WHAT
--   person_counts.kind     gains the judge's reasons (place, age, excluded, level, dealbreaker, type; untyped was there).
--                          The reads still write kind outside_targets with the reason in `reason`; the kinds are the
--                          words a count can be named by.
--   judge_audit            one row per person per daily roles.audit run: roles looked at, roles outside, by reason.
--                          Written by the service role only. The owned-tables list names it in the same commit.
--   measure_t3()           reads the latest judge_audit row of each person from the last 48 hours.
--   role_outside_targets   dropped (the SQL twin).
--   profiles_targets_changed  starts the re-judge when preferences.constraints changes too, not only preferences.targeting.
--   directory_roles_for    also returns description, location and salary_range, so the directory match judges a role
--                          on what the stored role judges it on (an excluded word in the description, a pay floor).
--   roles.audit            the daily routine (04:30 UTC), enabled; the runner leaves a command it has no handler for alone.

-- ---------------------------------------------------------------------------
-- person_counts.kind
-- ---------------------------------------------------------------------------
alter table public.person_counts drop constraint if exists person_counts_kind_check;
alter table public.person_counts add constraint person_counts_kind_check
  check (kind in ('outside_targets', 'untraced', 'cannot_read', 'untyped', 'shadow_keep', 'shadow_drop',
                  'place', 'age', 'excluded', 'level', 'dealbreaker', 'type'));

-- ---------------------------------------------------------------------------
-- judge_audit
-- ---------------------------------------------------------------------------
create table if not exists public.judge_audit (
  user_id uuid not null references public.profiles (id) on delete cascade,
  audited_at timestamptz not null default now(),
  -- the roles the person can see that were run through the judge, and how many of them it says are outside their targets
  rows integer not null check (rows >= 0),
  outside integer not null check (outside >= 0 and outside <= rows),
  -- the outside roles by the rung that said no: {"place": 12, "level": 3}
  by_reason jsonb not null default '{}'::jsonb,
  primary key (user_id, audited_at)
);

create index if not exists judge_audit_audited_idx on public.judge_audit (audited_at desc);

alter table public.judge_audit enable row level security;
revoke all on public.judge_audit from public, anon, authenticated;
grant all on public.judge_audit to service_role;

-- ---------------------------------------------------------------------------
-- T3 by the one judge; the SQL twin goes
-- ---------------------------------------------------------------------------
create or replace function public.measure_t3()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_people integer;
  n_rows bigint;
  n_outside bigint;
  reasons text;
begin
  with latest as (
    select distinct on (a.user_id) a.user_id, a.rows, a.outside, a.by_reason
      from public.judge_audit a
     where a.audited_at > now() - interval '48 hours'
     order by a.user_id, a.audited_at desc
  ),
  why as (
    select e.key as reason, sum(e.value::integer) as n
      from latest l, jsonb_each_text(l.by_reason) e
     group by e.key
  )
  select (select count(*) from latest),
         (select coalesce(sum(l.rows), 0) from latest l),
         (select coalesce(sum(l.outside), 0) from latest l),
         (select string_agg(w.n || ' ' || w.reason, ', ' order by w.n desc, w.reason) from why w where w.n > 0)
    into n_people, n_rows, n_outside, reasons;
  if n_people = 0 then
    return query select null::numeric, null::boolean, 0, 'No audit of the stored roles has run in the last 48 hours.'::text;
    return;
  end if;
  return query select n_outside::numeric, n_outside = 0, n_rows::integer,
    format('%s of %s stored roles are outside their person''s targets by the one judge, across %s people%s.',
           n_outside, n_rows, n_people, case when reasons is null then '' else ' (' || reasons || ')' end);
end;
$$;

revoke all on function public.measure_t3() from public, anon, authenticated;
grant execute on function public.measure_t3() to service_role;

update public.measures
   set name = 'stored roles outside their person''s targets, by the one judge (the daily audit)', source = 'judge_audit (lib/roles/keep.ts)'
 where id = 'T3';

drop function if exists public.role_outside_targets(jsonb, text, text, text, text, boolean, text, text);

-- ---------------------------------------------------------------------------
-- A change of targets or of dealbreakers starts the re-judge
-- ---------------------------------------------------------------------------
create or replace function public.profiles_targets_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.preferences -> 'targeting') is distinct from (old.preferences -> 'targeting')
     or (new.preferences -> 'constraints') is distinct from (old.preferences -> 'constraints') then
    new.targets_version := coalesce(old.targets_version, 0) + 1;
    -- Cello will re-check at once: the routine is due now, and the sweeper starts it within a minute.
    update public.routines set next_due_at = now(), poked_at = null
     where user_id = new.id and command = 'roles.check' and enabled;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The directory match judges a role on what the stored role is judged on
-- ---------------------------------------------------------------------------
drop function if exists public.directory_roles_for(uuid, timestamptz, integer);
create function public.directory_roles_for(p_user uuid, p_since timestamptz default null, p_limit integer default 2000)
returns table (
  id uuid, title text, job_function text, seniority text, country text, language text,
  is_remote boolean, posted_at timestamptz, employer_name text, title_norm text, role_type text,
  description text, location text, salary_range text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.job_function, j.seniority, j.country, j.language, j.is_remote, j.posted_at, d.name, j.title_norm, j.role_type,
         j.description, j.location, j.salary_range
    from public.jobs j
    join public.company_directory d on d.id = j.employer_id
   where j.still_open is not false
     and (j.posted_at is null or j.posted_at > now() - interval '180 days')
     and (p_since is null or j.discovered_at > p_since)
     and not exists (select 1 from public.person_roles pr where pr.user_id = p_user and pr.job_id = j.id)
   order by j.discovered_at desc
   limit least(greatest(p_limit, 1), 5000)
$$;
revoke execute on function public.directory_roles_for(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.directory_roles_for(uuid, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- The daily audit routine
-- ---------------------------------------------------------------------------
insert into public.routines (user_id, command, local_time, timezone, next_due_at, enabled, origin)
values (null, 'roles.audit', '04:30', 'UTC',
        date_trunc('day', now()) + interval '4 hours 30 minutes' + case when now() >= date_trunc('day', now()) + interval '4 hours 30 minutes' then interval '1 day' else interval '0' end,
        true, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  p uuid;
  n_before integer;
begin
  if to_regprocedure('public.role_outside_targets(jsonb, text, text, text, text, boolean, text, text)') is not null then
    raise exception 'role_outside_targets must be gone';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.judge_audit'::regclass and relrowsecurity) then
    raise exception 'judge_audit must have row level security on';
  end if;
  if has_table_privilege('anon', 'public.judge_audit', 'select') or has_table_privilege('authenticated', 'public.judge_audit', 'select') then
    raise exception 'judge_audit is for the service role only';
  end if;
  if has_function_privilege('anon', 'public.measure_t3()', 'execute') or has_function_privilege('authenticated', 'public.measure_t3()', 'execute') then
    raise exception 'measure_t3 must not be executable by client roles';
  end if;
  if has_function_privilege('authenticated', 'public.directory_roles_for(uuid, timestamptz, integer)', 'execute') then
    raise exception 'directory_roles_for must not be executable by client roles';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'person_counts_kind_check' and pg_get_constraintdef(oid) like '%dealbreaker%') then
    raise exception 'person_counts.kind must name the judge''s reasons';
  end if;
  if pg_get_functiondef('public.profiles_targets_changed()'::regprocedure) not like '%constraints%' then
    raise exception 'a change of dealbreakers must start the re-judge';
  end if;
  if not exists (select 1 from public.routines where command = 'roles.audit' and user_id is null and enabled) then
    raise exception 'roles.audit must be a routine of the instance';
  end if;
  if (select count(*) from pg_proc where proname = 'directory_roles_for' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'directory_roles_for must exist once';
  end if;
  if not exists (select 1 from pg_proc where proname = 'directory_roles_for' and pronamespace = 'public'::regnamespace and pg_get_function_result(oid) like '%description text%') then
    raise exception 'directory_roles_for must return the description';
  end if;

  -- T3 with no audit says it does not know, and with audits counts the latest of each person; set aside inside the block.
  select id into p from public.profiles order by id limit 1;
  if p is null then
    raise notice 'judge_audit self-check skipped: there is no profile to audit';
    return;
  end if;
  select count(*) into n_before from public.judge_audit;
  begin
    delete from public.judge_audit;
    select * into r from public.measure_t3();
    if r.value is not null or r.passed is not null or r.sample_n <> 0 then
      raise exception 'measure_t3 without an audit must not answer, got % % %', r.value, r.passed, r.sample_n;
    end if;
    insert into public.judge_audit (user_id, audited_at, rows, outside, by_reason) values (p, now() - interval '1 hour', 40, 6, '{"place": 5, "level": 1}');
    insert into public.judge_audit (user_id, audited_at, rows, outside, by_reason) values (p, now(), 50, 0, '{}');
    select * into r from public.measure_t3();
    if r.value <> 0 or r.passed is not true or r.sample_n <> 50 then
      raise exception 'measure_t3 must read the latest audit of a person, got % % %', r.value, r.passed, r.sample_n;
    end if;
    insert into public.judge_audit (user_id, audited_at, rows, outside, by_reason) values (p, now() + interval '1 minute', 50, 3, '{"place": 2, "dealbreaker": 1}');
    select * into r from public.measure_t3();
    if r.value <> 3 or r.passed is not false or r.note not like '%2 place, 1 dealbreaker%' then
      raise exception 'measure_t3 must count what is outside and say why, got % % %', r.value, r.passed, r.note;
    end if;
    raise exception 'judge_audit self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'judge_audit self-check passed' then raise; end if;
  end;
  if (select count(*) from public.judge_audit) <> n_before then
    raise exception 'the self-check changed the audit rows';
  end if;
end
$$;

notify pgrst, 'reload schema';
