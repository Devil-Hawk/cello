-- Retire the old spend counters. APPLY THIS AFTER THE APP DEPLOY.
--
-- 20261008030000 created the ledger and carried this month's profiles.preferences
-- .budget.spentUsd into it. Until the new app is live, the old code keeps
-- calling record_llm_spend and growing those counters, so this migration:
--   1. tops the ledger up with whatever the old code charged since the carry-over
--      (counter minus what was carried, when positive), so no spend is lost;
--   2. strips spentUsd and periodStart from every profile, leaving the user's
--      editable monthlyUsd cap alone (this runs as the database owner, which the
--      demo lockdown trigger exempts);
--   3. drops record_llm_spend, so a charge without a reservation cannot be written.
-- Idempotent: a second run finds nothing to top up and no counters to strip.

insert into public.llm_spend (user_id, funder_id, period, model, estimate_usd, actual_usd, status, settled_at)
select p.id,
       case when coalesce(p.is_demo, false) or p.demo_expires_at is not null
            then (select c.owner_user_id from public.access_codes c
                  where c.demo_user_id = p.id order by c.created_at desc limit 1) end,
       date_trunc('month', now() at time zone 'utc')::date,
       'carried-over',
       (p.preferences #>> '{budget,spentUsd}')::numeric
         - coalesce((select sum(s.actual_usd) from public.llm_spend s
                     where s.user_id = p.id and s.model = 'carried-over'
                       and s.period = date_trunc('month', now() at time zone 'utc')::date), 0),
       (p.preferences #>> '{budget,spentUsd}')::numeric
         - coalesce((select sum(s.actual_usd) from public.llm_spend s
                     where s.user_id = p.id and s.model = 'carried-over'
                       and s.period = date_trunc('month', now() at time zone 'utc')::date), 0),
       'settled',
       now()
from public.profiles p
where p.preferences #>> '{budget,periodStart}' = to_char(now() at time zone 'utc', 'YYYY-MM')
  and jsonb_typeof(p.preferences #> '{budget,spentUsd}') = 'number'
  and (p.preferences #>> '{budget,spentUsd}')::numeric
        > coalesce((select sum(s.actual_usd) from public.llm_spend s
                    where s.user_id = p.id and s.model = 'carried-over'
                      and s.period = date_trunc('month', now() at time zone 'utc')::date), 0);

update public.profiles
set preferences = jsonb_set(preferences, '{budget}', (preferences -> 'budget') - 'spentUsd' - 'periodStart')
where jsonb_typeof(preferences -> 'budget') = 'object'
  and (preferences -> 'budget') ?| array['spentUsd', 'periodStart'];

drop function if exists public.record_llm_spend(uuid, numeric);

do $$
begin
  if to_regprocedure('public.record_llm_spend(uuid, numeric)') is not null then
    raise exception 'record_llm_spend is still defined';
  end if;
  if exists (
    select 1 from public.profiles
    where jsonb_typeof(preferences -> 'budget') = 'object'
      and (preferences -> 'budget') ?| array['spentUsd', 'periodStart']
  ) then
    raise exception 'spend counters remain on profiles.preferences.budget';
  end if;
end
$$;
