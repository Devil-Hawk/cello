-- LLM spend ledger: reserve before a model call, settle after it.
--
-- WHY
--   record_llm_spend (20261005000005) charged AFTER a call, and the budget check
--   ran BEFORE it as a separate read. N parallel calls (a fan-out against a $1
--   demo cap) all passed the check and then all charged, so the cap was a
--   suggestion. The counters also lived in profiles.preferences.budget, which the
--   owner of the row can update over the Data API: the demo lockdown trigger
--   returns early for every non-demo profile, so a signed-in user could
--   `update profiles set preferences = jsonb_set(preferences,'{budget,spentUsd}','0')`
--   (proven in supabase/checks/llm_spend_and_access.sql).
--
-- WHAT
--   One row per model attempt is the ledger. Free (R3) and local (R2) calls write a
--   row too, at $0, with the rung that ran, the step that asked and, once commands
--   exist, the door it came through: the daily free-request count is read from
--   these rows (agents-v3 6.3 wins over the first design, which kept free calls out).
--   The database refuses a non-zero amount on any row that is not R4. A month's spend is
--   sum(coalesce(actual_usd, estimate_usd)) over the user's rows for the month, so
--   there is no second counter to drift out of agreement with it.
--   reserve_llm_spend takes an advisory lock per user (and per funding owner for a
--   demo), checks spent + held + estimate <= cap and inserts the reservation in
--   one transaction. settle_llm_spend records the actual cost exactly once. A
--   pg_cron sweeper charges reservations nobody settled (a crashed call) at their
--   estimate after 15 minutes, so a crash can only over-count, never under-count.
--   Only the service role can write the table; the owner can read their own rows.
--   The monthly cap stays in profiles.preferences.budget.monthlyUsd, which is
--   user-editable by design (a demo cannot raise it; the lockdown trigger).
--
-- Safe to run on a database that already has the first shape of this table: the
-- columns, constraints and functions are added only where missing.
--
-- Additive: old code that still calls record_llm_spend keeps working until
-- 20261008030002 retires it.
--
-- Lock order is always user, then pool, and an owner never takes a pool lock, so
-- there is no cycle. SECURITY INVOKER with an empty search_path throughout, for
-- the reason spelled out on is_service_role_request().

create table if not exists public.llm_spend (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The owner whose demo allowance this draws on (null for a non-demo user).
  funder_id uuid references public.profiles(id) on delete set null,
  -- First day of the UTC month the charge belongs to.
  period date not null,
  model text not null check (char_length(model) <= 200),
  estimate_usd numeric(12,6) not null check (estimate_usd >= 0),
  actual_usd numeric(12,6) check (actual_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'expired')),
  trace_id text check (char_length(trace_id) <= 64),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- Which backend ran: R0s in-browser, R1 the person's own key or subscription tool
  -- on the extension, R2 local, R3 free hosted, R4 paid hosted. Set from code.
  rung text,
  -- The declared step that asked (the name the caller already gives Langfuse).
  step text,
  -- The way in: null until commands exist to say which.
  door text,
  -- The HTTP status of a refused attempt, so a day that hit the limit can be counted.
  failed_status smallint
);

alter table public.llm_spend add column if not exists rung text;
alter table public.llm_spend add column if not exists step text;
alter table public.llm_spend add column if not exists door text;
alter table public.llm_spend add column if not exists failed_status smallint;

-- Rows from the first shape were all paid, or carried over from the old counters.
update public.llm_spend
set rung = 'R4',
    step = case when model = 'carried-over' then 'carried-over' else 'unrecorded' end
where rung is null or step is null;

alter table public.llm_spend alter column rung set not null;
alter table public.llm_spend alter column step set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_spend_rung_check' and conrelid = 'public.llm_spend'::regclass) then
    alter table public.llm_spend add constraint llm_spend_rung_check
      check (rung in ('R0s', 'R1', 'R2', 'R3', 'R4'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'llm_spend_step_check' and conrelid = 'public.llm_spend'::regclass) then
    alter table public.llm_spend add constraint llm_spend_step_check
      check (char_length(step) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'llm_spend_door_check' and conrelid = 'public.llm_spend'::regclass) then
    alter table public.llm_spend add constraint llm_spend_door_check
      check (door is null or door in ('session', 'routine', 'rule', 'chat', 'assistant', 'agent', 'extension'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'llm_spend_free_is_zero' and conrelid = 'public.llm_spend'::regclass) then
    alter table public.llm_spend add constraint llm_spend_free_is_zero
      check (rung = 'R4' or (estimate_usd = 0 and coalesce(actual_usd, 0) = 0));
  end if;
end
$$;

create index if not exists llm_spend_user_period on public.llm_spend (user_id, period);
create index if not exists llm_spend_funder_period on public.llm_spend (funder_id, period) where funder_id is not null;
-- Serves "this person's R3 rows since the daily reset".
create index if not exists llm_spend_user_rung_day on public.llm_spend (user_id, rung, created_at);
create index if not exists llm_spend_open on public.llm_spend (created_at) where status = 'reserved';

alter table public.llm_spend enable row level security;

drop policy if exists "owners read their spend" on public.llm_spend;
create policy "owners read their spend" on public.llm_spend
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.llm_spend from public, anon, authenticated;
grant select on public.llm_spend to authenticated;
grant all on public.llm_spend to service_role;

-- ---------------------------------------------------------------------------
-- The pool: what all demos funded by one owner may spend together each month
-- ---------------------------------------------------------------------------
create or replace function public.demo_allowance_usd()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 5::numeric $$;

-- ---------------------------------------------------------------------------
-- reserve_llm_spend: the check and the charge are one transaction
-- ---------------------------------------------------------------------------
-- The first shape took four arguments and settle took two; drop them so the new
-- versions are not ambiguous overloads.
drop function if exists public.reserve_llm_spend(uuid, text, numeric, text);
drop function if exists public.settle_llm_spend(uuid, numeric);

create or replace function public.reserve_llm_spend(
  p_user_id uuid,
  p_model text,
  p_estimate numeric,
  p_rung text,
  p_step text,
  p_trace_id text default null,
  p_door text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  per date := date_trunc('month', now() at time zone 'utc')::date;
  prefs jsonb;
  demo boolean;
  found_profile boolean;
  cap numeric;
  used numeric;
  funder uuid;
  pool_cap numeric := public.demo_allowance_usd();
  pool_used numeric;
  new_id uuid;
begin
  if p_estimate is null or p_estimate < 0 then
    raise exception 'a spend estimate must be a number of at least zero' using errcode = '22023';
  end if;
  if p_rung is distinct from 'R4' and p_estimate > 0 then
    raise exception 'only a paid hosted call (R4) may reserve money' using errcode = '22023';
  end if;

  -- A $0 reservation never waits on a lock and is never refused by a cap: a free
  -- fan-out must not queue behind paid calls, and a demo needs no funder for free work.
  if p_estimate = 0 then
    insert into public.llm_spend (user_id, period, model, estimate_usd, trace_id, rung, step, door)
    select p.id, per, left(p_model, 200), 0, left(p_trace_id, 64), p_rung, left(p_step, 80), p_door
    from public.profiles p where p.id = p_user_id
    returning id into new_id;
    if new_id is null then
      return jsonb_build_object('ok', false, 'scope', 'user', 'spent_usd', 0, 'cap_usd', 0);
    end if;
    return jsonb_build_object('ok', true, 'id', new_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('llm_spend:user:' || p_user_id::text, 0));

  select p.preferences, (coalesce(p.is_demo, false) or p.demo_expires_at is not null), true
    into prefs, demo, found_profile
  from public.profiles p where p.id = p_user_id;
  if found_profile is not true then
    return jsonb_build_object('ok', false, 'scope', 'user', 'spent_usd', 0, 'cap_usd', 0);
  end if;

  cap := case when jsonb_typeof(prefs #> '{budget,monthlyUsd}') = 'number'
                   and (prefs #>> '{budget,monthlyUsd}')::numeric > 0
              then (prefs #>> '{budget,monthlyUsd}')::numeric else 10 end;

  select coalesce(sum(coalesce(s.actual_usd, s.estimate_usd)), 0) into used
  from public.llm_spend s where s.user_id = p_user_id and s.period = per;

  if p_estimate > 0 and used + p_estimate > cap then
    return jsonb_build_object('ok', false, 'scope', 'user', 'spent_usd', used, 'cap_usd', cap);
  end if;

  if demo then
    select c.owner_user_id into funder
    from public.access_codes c where c.demo_user_id = p_user_id
    order by c.created_at desc limit 1;

    if funder is null then
      -- A demo nobody is paying for may not spend (fail closed).
      if p_estimate > 0 then
        return jsonb_build_object('ok', false, 'scope', 'demo-pool', 'spent_usd', 0, 'cap_usd', pool_cap);
      end if;
    else
      perform pg_advisory_xact_lock(hashtextextended('llm_spend:pool:' || funder::text, 0));
      select coalesce(sum(coalesce(s.actual_usd, s.estimate_usd)), 0) into pool_used
      from public.llm_spend s where s.funder_id = funder and s.period = per;
      if p_estimate > 0 and pool_used + p_estimate > pool_cap then
        return jsonb_build_object('ok', false, 'scope', 'demo-pool', 'spent_usd', pool_used, 'cap_usd', pool_cap);
      end if;
    end if;
  end if;

  insert into public.llm_spend (user_id, funder_id, period, model, estimate_usd, trace_id, rung, step, door)
  values (p_user_id, case when demo then funder end, per, left(p_model, 200), p_estimate, left(p_trace_id, 64),
          p_rung, left(p_step, 80), p_door)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- settle_llm_spend: exactly once. A second call, or a call for an unknown id, is a no-op.
-- A late settle still overwrites a row the sweeper already expired, so the real
-- cost replaces the estimate.
-- ---------------------------------------------------------------------------
create or replace function public.settle_llm_spend(p_id uuid, p_actual numeric, p_status smallint default null)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  hit integer;
begin
  update public.llm_spend
  -- Only a paid call (R4) can cost anything; a stray amount on a free row is ignored.
  set actual_usd = case when rung = 'R4' then greatest(coalesce(p_actual, 0), 0) else 0 end,
      status = 'settled',
      settled_at = now(),
      failed_status = p_status
  where id = p_id and status <> 'settled';
  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------
create or replace function public.llm_spend_state(p_user_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  per date := date_trunc('month', now() at time zone 'utc')::date;
  prefs jsonb;
  cap numeric;
  spent numeric;
  held numeric;
begin
  select p.preferences into prefs from public.profiles p where p.id = p_user_id;
  cap := case when jsonb_typeof(prefs #> '{budget,monthlyUsd}') = 'number'
                   and (prefs #>> '{budget,monthlyUsd}')::numeric > 0
              then (prefs #>> '{budget,monthlyUsd}')::numeric else 10 end;
  select coalesce(sum(coalesce(s.actual_usd, s.estimate_usd)) filter (where s.status <> 'reserved'), 0),
         coalesce(sum(s.estimate_usd) filter (where s.status = 'reserved'), 0)
    into spent, held
  from public.llm_spend s where s.user_id = p_user_id and s.period = per;
  return jsonb_build_object('period', per, 'spent_usd', spent, 'held_usd', held, 'cap_usd', cap);
end;
$$;

create or replace function public.demo_allowance_state(p_owner_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'used_usd', coalesce(sum(coalesce(s.actual_usd, s.estimate_usd)), 0),
    'cap_usd', public.demo_allowance_usd())
  from public.llm_spend s
  where s.funder_id = p_owner_id
    and s.period = date_trunc('month', now() at time zone 'utc')::date
$$;

-- ---------------------------------------------------------------------------
-- The sweeper: a reservation nobody settled in 15 minutes belongs to a call that
-- died. Charge its estimate, so a crash can never under-count.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_llm_spend()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expired integer;
  pruned integer;
begin
  update public.llm_spend
  set status = 'expired', actual_usd = estimate_usd, settled_at = now()
  where status = 'reserved' and created_at < now() - interval '15 minutes';
  get diagnostics expired = row_count;

  -- 95 days: a monthly cap only sums the current month, so older rows are history.
  delete from public.llm_spend
  where created_at < now() - interval '95 days';
  get diagnostics pruned = row_count;

  return jsonb_build_object('expired', expired, 'pruned', pruned);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.demo_allowance_usd()',
    'public.reserve_llm_spend(uuid, text, numeric, text, text, text, text)',
    'public.settle_llm_spend(uuid, numeric, smallint)',
    'public.llm_spend_state(uuid)',
    'public.demo_allowance_state(uuid)',
    'public.sweep_llm_spend()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Carry this month's existing counters over, once per user, so the cutover does
-- not hand everyone a fresh allowance. Demos keep their owner as funder.
-- ---------------------------------------------------------------------------
insert into public.llm_spend (user_id, funder_id, period, model, estimate_usd, actual_usd, status, settled_at, rung, step)
select p.id,
       case when coalesce(p.is_demo, false) or p.demo_expires_at is not null
            then (select c.owner_user_id from public.access_codes c
                  where c.demo_user_id = p.id order by c.created_at desc limit 1) end,
       date_trunc('month', now() at time zone 'utc')::date,
       'carried-over',
       (p.preferences #>> '{budget,spentUsd}')::numeric,
       (p.preferences #>> '{budget,spentUsd}')::numeric,
       'settled',
       now(),
       'R4',
       'carried-over'
from public.profiles p
where p.preferences #>> '{budget,periodStart}' = to_char(now() at time zone 'utc', 'YYYY-MM')
  and jsonb_typeof(p.preferences #> '{budget,spentUsd}') = 'number'
  and (p.preferences #>> '{budget,spentUsd}')::numeric > 0
  and not exists (select 1 from public.llm_spend s where s.user_id = p.id and s.model = 'carried-over');

select cron.schedule('llm-spend-sweep', '*/5 * * * *', 'select public.sweep_llm_spend()');

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc
    where oid in ('public.reserve_llm_spend(uuid, text, numeric, text, text, text, text)'::regprocedure,
                  'public.settle_llm_spend(uuid, numeric, smallint)'::regprocedure,
                  'public.sweep_llm_spend()'::regprocedure)
      and prosecdef
  ) then
    raise exception 'spend functions must not be security definer';
  end if;
  if has_function_privilege('anon', 'public.reserve_llm_spend(uuid, text, numeric, text, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.reserve_llm_spend(uuid, text, numeric, text, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.settle_llm_spend(uuid, numeric, smallint)', 'execute')
     or has_function_privilege('authenticated', 'public.sweep_llm_spend()', 'execute') then
    raise exception 'spend functions must be executable by service_role only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.llm_spend'::regclass) then
    raise exception 'RLS is off on public.llm_spend';
  end if;
  if has_table_privilege('authenticated', 'public.llm_spend', 'insert')
     or has_table_privilege('authenticated', 'public.llm_spend', 'update')
     or has_table_privilege('authenticated', 'public.llm_spend', 'delete')
     or has_table_privilege('anon', 'public.llm_spend', 'select') then
    raise exception 'llm_spend must be read-only to signed-in users and invisible to anon';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'llm_spend'
        and column_name in ('rung', 'step', 'door', 'failed_status')) <> 4 then
    raise exception 'llm_spend is missing rung, step, door or failed_status';
  end if;
  if to_regclass('public.llm_spend_user_rung_day') is null then
    raise exception 'the daily-count index llm_spend_user_rung_day is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'llm_spend_free_is_zero') then
    raise exception 'llm_spend_free_is_zero is missing';
  end if;
end
$$;
