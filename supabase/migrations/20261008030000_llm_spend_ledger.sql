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
--   One row per metered call is the ledger. A month's spend is
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
  settled_at timestamptz
);

create index if not exists llm_spend_user_period on public.llm_spend (user_id, period);
create index if not exists llm_spend_funder_period on public.llm_spend (funder_id, period) where funder_id is not null;
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
create or replace function public.reserve_llm_spend(
  p_user_id uuid,
  p_model text,
  p_estimate numeric,
  p_trace_id text default null
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

  insert into public.llm_spend (user_id, funder_id, period, model, estimate_usd, trace_id)
  values (p_user_id, case when demo then funder end, per, left(p_model, 200), p_estimate, left(p_trace_id, 64))
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- settle_llm_spend: exactly once. A second call, or a call for an unknown id, is a no-op.
-- A late settle still overwrites a row the sweeper already expired, so the real
-- cost replaces the estimate.
-- ---------------------------------------------------------------------------
create or replace function public.settle_llm_spend(p_id uuid, p_actual numeric)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  hit integer;
begin
  update public.llm_spend
  set actual_usd = greatest(coalesce(p_actual, 0), 0),
      status = 'settled',
      settled_at = now()
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

  delete from public.llm_spend
  where period < (date_trunc('month', now() at time zone 'utc') - interval '13 months')::date;
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
    'public.reserve_llm_spend(uuid, text, numeric, text)',
    'public.settle_llm_spend(uuid, numeric)',
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
insert into public.llm_spend (user_id, funder_id, period, model, estimate_usd, actual_usd, status, settled_at)
select p.id,
       case when coalesce(p.is_demo, false) or p.demo_expires_at is not null
            then (select c.owner_user_id from public.access_codes c
                  where c.demo_user_id = p.id order by c.created_at desc limit 1) end,
       date_trunc('month', now() at time zone 'utc')::date,
       'carried-over',
       (p.preferences #>> '{budget,spentUsd}')::numeric,
       (p.preferences #>> '{budget,spentUsd}')::numeric,
       'settled',
       now()
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
    where oid in ('public.reserve_llm_spend(uuid, text, numeric, text)'::regprocedure,
                  'public.settle_llm_spend(uuid, numeric)'::regprocedure,
                  'public.sweep_llm_spend()'::regprocedure)
      and prosecdef
  ) then
    raise exception 'spend functions must not be security definer';
  end if;
  if has_function_privilege('anon', 'public.reserve_llm_spend(uuid, text, numeric, text)', 'execute')
     or has_function_privilege('authenticated', 'public.reserve_llm_spend(uuid, text, numeric, text)', 'execute')
     or has_function_privilege('authenticated', 'public.settle_llm_spend(uuid, numeric)', 'execute')
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
end
$$;
