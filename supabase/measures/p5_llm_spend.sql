-- P5: free-model use, from the spend ledger. Read-only: it changes nothing and is
-- not a pass or fail check, so it lives outside supabase/checks. The scorecard
-- (K7) seeds measure P5 from this file.
--
--   psql -X -f supabase/measures/p5_llm_spend.sql "$DATABASE_URL"
--
-- Window: the last 30 days. A person-day is a UTC day on which that person has at
-- least one ledger row.
with rows30 as (
  select user_id, rung, door, failed_status, (created_at at time zone 'utc')::date as day
  from public.llm_spend
  where created_at >= now() - interval '30 days'
),
person_days as (
  select user_id, day,
         count(*) filter (where rung = 'R3') as r3_requests,
         coalesce(bool_or(rung = 'R3' and failed_status = 429), false) as hit_limit
  from rows30
  group by user_id, day
)
select
  'R3 requests per person-day (any row)' as measure,
  coalesce(round(sum(r3_requests)::numeric / nullif(count(*), 0), 2), 0)::text as value,
  count(*)::text as person_days
from person_days
union all
select 'person-days with an R3 row refused with 429', count(*) filter (where hit_limit)::text, count(*)::text
from person_days
union all
select 'rows by door: ' || coalesce(door, 'door not recorded'), count(*)::text, null
from rows30
group by door
union all
select 'Needs you rows that waited for the limit', null, 'cannot read until K13 adds needs_reason';
