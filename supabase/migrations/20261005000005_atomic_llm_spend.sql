-- Atomic LLM spend ledger.
--
-- recordSpend used to read profiles.preferences, add the cost in JS and write the
-- whole blob back. Parallel calls for one user all read the same spentUsd, so
-- only one increment survived (the $1 demo cap and the monthly cap under-counted),
-- and the stale whole-blob write could undo a concurrent settings save.
--
-- This does the same arithmetic as lib/harness/spend.ts (readState + recordSpend)
-- in ONE UPDATE: the row lock serialises concurrent increments and only
-- preferences.budget is touched.
--   * period is the current UTC month, 'YYYY-MM'; a stored period that differs
--     resets the counter to 0 (rollover needs no job)
--   * a stored spentUsd counts only if it is a positive number, otherwise 0
--   * monthlyUsd is kept when it is a positive number, else the default 10
--     (DEFAULT_MONTHLY_USD in spend.ts)
--   * the new total is rounded to 6 decimals
-- SECURITY INVOKER so the demo lockdown trigger sees a service-role request and
-- exempts it, and so nothing here can run with more rights than the caller.

create or replace function public.record_llm_spend(p_user_id uuid, p_cost numeric)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  per text := to_char(now() at time zone 'utc', 'YYYY-MM');
  spent numeric;
begin
  update public.profiles p
  set preferences = jsonb_set(
    coalesce(p.preferences, '{}'::jsonb),
    '{budget}',
    case when jsonb_typeof(p.preferences -> 'budget') = 'object'
         then p.preferences -> 'budget' else '{}'::jsonb end
    || jsonb_build_object(
      'periodStart', per,
      'spentUsd', round(
        case when p.preferences #>> '{budget,periodStart}' = per
              and jsonb_typeof(p.preferences #> '{budget,spentUsd}') = 'number'
              and (p.preferences #>> '{budget,spentUsd}')::numeric > 0
             then (p.preferences #>> '{budget,spentUsd}')::numeric else 0 end
        + greatest(coalesce(p_cost, 0), 0),
        6),
      'monthlyUsd',
        case when jsonb_typeof(p.preferences #> '{budget,monthlyUsd}') = 'number'
              and (p.preferences #>> '{budget,monthlyUsd}')::numeric > 0
             then p.preferences #> '{budget,monthlyUsd}' else to_jsonb(10) end
    )
  )
  where p.id = p_user_id
  returning (p.preferences #>> '{budget,spentUsd}')::numeric into spent;

  return spent;
end;
$$;

revoke all on function public.record_llm_spend(uuid, numeric) from public, anon, authenticated;
grant execute on function public.record_llm_spend(uuid, numeric) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.record_llm_spend(uuid, numeric)'::regprocedure
      and not prosecdef
  ) then
    raise exception 'record_llm_spend is missing or is security definer';
  end if;
  if has_function_privilege('anon', 'public.record_llm_spend(uuid, numeric)', 'execute')
     or has_function_privilege('authenticated', 'public.record_llm_spend(uuid, numeric)', 'execute') then
    raise exception 'record_llm_spend must not be executable by anon or authenticated';
  end if;
end
$$;
