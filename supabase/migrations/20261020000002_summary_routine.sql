-- K20: every person gets a daily summary routine.
--
-- WHY
--   summary.send has a handler (lib/clock/routines/summary-send.ts) but a routine with no row is never due,
--   and the handler needs the person it runs for, which only a per-person row supplies. Nothing created
--   that row, so no summary was ever sent.
--
-- WHAT
--   ensure_person_routines() now also creates summary.send: every day at the person's summary time
--   (preferences.pipeline.morning.summaryAt, 08:00 when none is set) in the person's zone (the zone of
--   their roles.check routine, UTC when none is set). The first run is the next time that clock reads it,
--   so a new person does not get a summary the minute they sign up. Whether anything is sent is
--   decided by the handler: the summary switch, the Gmail send grant, a demo, once a day.
--   Every person that already exists gets the row.
--
-- This file is a pre-deploy migration. 20261020000001 is the post-deploy drop of the old view and is
-- applied by hand after the deploy; the two do not depend on each other.

create or replace function public.ensure_person_routines(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_at time;
  v_next timestamptz;
begin
  -- Spread the first checks over ten minutes so a new instance does not read everyone at once.
  insert into public.routines (user_id, command, every, timezone, next_due_at, origin)
  values (p_user, 'roles.check', interval '6 hours', 'UTC', now() + random() * interval '10 minutes', 'default')
  on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;

  select r.timezone into v_tz from public.routines r where r.user_id = p_user and r.command = 'roles.check';
  if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = v_tz) then
    v_tz := 'UTC';
  end if;
  begin
    select coalesce(nullif(p.preferences #>> '{pipeline,morning,summaryAt}', '')::time, time '08:00') into v_at
      from public.profiles p where p.id = p_user;
  exception when others then
    v_at := null;
  end;
  v_at := coalesce(v_at, time '08:00');

  -- the next time the person's clock reads v_at
  v_next := (((now() at time zone v_tz)::date + v_at) at time zone v_tz);
  if v_next <= now() then
    v_next := ((((now() at time zone v_tz)::date + 1) + v_at) at time zone v_tz);
  end if;
  insert into public.routines (user_id, command, local_time, timezone, next_due_at, origin)
  values (p_user, 'summary.send', v_at, v_tz, v_next, 'default')
  on conflict (command, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;
end;
$$;

select public.ensure_person_routines(p.id)
from public.profiles p
where not coalesce(p.is_demo, false);

notify pgrst, 'reload schema';

do $$
begin
  if position('summary.send' in pg_get_functiondef('public.ensure_person_routines(uuid)'::regprocedure)) = 0 then
    raise exception 'ensure_person_routines does not create summary.send';
  end if;
  if exists (
    select 1 from public.profiles p
     where not coalesce(p.is_demo, false)
       and not exists (select 1 from public.routines r where r.user_id = p.id and r.command = 'summary.send')
  ) then
    raise exception 'a person has no summary.send routine';
  end if;
  if has_function_privilege('authenticated', 'public.ensure_person_routines(uuid)', 'execute') then
    raise exception 'ensure_person_routines must stay out of the session''s reach';
  end if;
end
$$;
