-- roles/judge (feature 2, PR 4): the evidence step on the free path.
--
-- WHAT
--   person_roles gains band, readings, prov and judged_at: the chance as the matcher writes it (strong | possible | stretch |
--   cannot_assess), one reading per requirement with its resume line and quote, where the reading came from, and when.
--   judge_budget counts the free model calls of each day, in total and per person, behind take_judge_call().
--   The reset trigger on a changed posting also clears the four new columns, so a role is judged again when its text changes.
--   A changed resume (profiles.resume_text, which every resume write mirrors into) marks the person's roles as waiting again by
--   clearing judged_at only: the old band and readings stay until the new reading lands.
--   The roles.match routine (every 30 minutes) is seeded on.
--
-- The legacy chance and chance_detail columns stay and are still written beside band until the pages read band (PR 6).
-- Nothing a person can write reaches the new columns: the authenticated role keeps update on hidden_reason and saved_at only.

alter table public.person_roles
  add column if not exists band text,
  add column if not exists readings jsonb,
  add column if not exists prov jsonb,
  add column if not exists judged_at timestamptz;

alter table public.person_roles drop constraint if exists person_roles_band_values;
alter table public.person_roles
  add constraint person_roles_band_values check (band is null or band in ('strong', 'possible', 'stretch', 'cannot_assess'));

comment on column public.person_roles.band is
  'strong | possible | stretch | cannot_assess: the chance rule (labelChance) over the readings. Null means not judged yet.';
comment on column public.person_roles.readings is
  '[{id, text, kind, status, line, quote, source, confirm}]: each requirement read against the resume. A met or partial status always carries a quote found on its resume line. confirm marks work authorization and place items, which never move the band.';
comment on column public.person_roles.prov is
  '{step, model, rung, evidence, at} of the evidence step that wrote the band (lib/provenance/types.ts). Null for a band that predates provenance.';
comment on column public.person_roles.judged_at is
  'When the matcher last judged this role for this person. Null means waiting.';

-- The bands the paid assessment already wrote keep their meaning. They have no provenance, so they are judged again (judged_at stays null).
update public.person_roles set band = chance where band is null and chance in ('strong', 'possible', 'stretch', 'cannot_assess');

create index if not exists idx_person_roles_unjudged on public.person_roles (user_id) where judged_at is null and hidden_reason is null;

-- A changed posting invalidates what was concluded from it, for everyone who sees it.
create or replace function public.reset_person_roles_on_posting_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.person_roles
  set chance = null, chance_detail = null, assessed_at = null,
      band = null, readings = null, prov = null, judged_at = null
  where job_id = new.id;
  return null;
end;
$fn$;

revoke all on function public.reset_person_roles_on_posting_change() from public, anon, authenticated;

create or replace function public.reset_judged_on_resume_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.person_roles set judged_at = null where user_id = new.id and judged_at is not null;
  return null;
end;
$fn$;

revoke all on function public.reset_judged_on_resume_change() from public, anon, authenticated;

drop trigger if exists profiles_reset_judged_on_resume on public.profiles;
create trigger profiles_reset_judged_on_resume
  after update of resume_text on public.profiles
  for each row
  when (old.resume_text is distinct from new.resume_text)
  execute function public.reset_judged_on_resume_change();

-- ---------------------------------------------------------------------------
-- The day's free calls
-- ---------------------------------------------------------------------------
create table if not exists public.judge_budget (
  day date primary key,
  calls integer not null default 0 check (calls >= 0),
  by_user jsonb not null default '{}'::jsonb
);

comment on table public.judge_budget is
  'Free model calls made for judging, per UTC day: the total and each person''s share used. Written only through take_judge_call().';

alter table public.judge_budget enable row level security;
revoke all on public.judge_budget from public, anon, authenticated;
grant all on public.judge_budget to service_role;

-- Takes one call from the day's budget for one person. False when the day's cap or the person's share is used.
create or replace function public.take_judge_call(p_day date, p_user uuid, p_share integer, p_cap integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  used integer;
  mine integer;
begin
  insert into public.judge_budget (day) values (p_day) on conflict (day) do nothing;
  select calls, coalesce((by_user ->> p_user::text)::integer, 0) into used, mine
    from public.judge_budget where day = p_day for update;
  if used >= p_cap or mine >= p_share then
    return false;
  end if;
  update public.judge_budget
     set calls = calls + 1, by_user = jsonb_set(by_user, array[p_user::text], to_jsonb(mine + 1), true)
   where day = p_day;
  return true;
end;
$fn$;

revoke all on function public.take_judge_call(date, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.take_judge_call(date, uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- The routine
-- ---------------------------------------------------------------------------
insert into public.routines (user_id, command, every, local_time, timezone, next_due_at, enabled, origin)
values (null, 'roles.match', interval '30 minutes', null, 'UTC', now() + interval '5 minutes', true, 'default')
on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare
  probe constant date := date '1999-01-01';
  who constant uuid := '00000000-0000-4000-8000-000000000001';
  other constant uuid := '00000000-0000-4000-8000-000000000002';
  ok1 boolean; ok2 boolean; ok3 boolean; ok4 boolean; ok5 boolean;
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'person_roles' and column_name in ('band', 'readings', 'prov', 'judged_at')) <> 4 then
    raise exception 'person_roles is missing a judge column';
  end if;
  if has_column_privilege('authenticated', 'public.person_roles', 'band', 'UPDATE')
     or has_column_privilege('authenticated', 'public.person_roles', 'readings', 'UPDATE')
     or has_column_privilege('authenticated', 'public.person_roles', 'prov', 'UPDATE')
     or has_column_privilege('authenticated', 'public.person_roles', 'judged_at', 'UPDATE') then
    raise exception 'a session can write a judgement';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.judge_budget'::regclass) then
    raise exception 'row level security is off on judge_budget';
  end if;
  if has_table_privilege('anon', 'public.judge_budget', 'select') or has_table_privilege('authenticated', 'public.judge_budget', 'select') then
    raise exception 'judge_budget is readable by a session';
  end if;
  if pg_get_functiondef('public.reset_person_roles_on_posting_change()'::regprocedure) not like '%judged_at = null%'
     or pg_get_functiondef('public.reset_person_roles_on_posting_change()'::regprocedure) not like '%band = null%' then
    raise exception 'the posting change trigger does not clear the judgement';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'jobs_reset_person_roles_on_change') then
    raise exception 'posting change reset trigger is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'profiles_reset_judged_on_resume') then
    raise exception 'the resume change trigger is missing';
  end if;
  if not exists (select 1 from public.routines where command = 'roles.match' and user_id is null and enabled) then
    raise exception 'the roles.match routine is not seeded on';
  end if;

  -- The budget: the day's cap and a person's share each stop a call, and one person's use leaves the others' share alone.
  delete from public.judge_budget where day = probe;
  ok1 := public.take_judge_call(probe, who, 20, 3);
  ok2 := public.take_judge_call(probe, who, 1, 3);
  ok3 := public.take_judge_call(probe, other, 1, 3);
  ok4 := public.take_judge_call(probe, other, 20, 3);
  ok5 := public.take_judge_call(probe, who, 20, 3);
  delete from public.judge_budget where day = probe;
  if not (ok1 and not ok2 and ok3 and ok4 and not ok5) then
    raise exception 'take_judge_call gave % % % % %', ok1, ok2, ok3, ok4, ok5;
  end if;
end;
$$;

notify pgrst, 'reload schema';
