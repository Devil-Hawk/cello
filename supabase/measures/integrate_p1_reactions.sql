-- P1: what people say about the roles shown to them. Read-only: it changes nothing and is not a
-- pass or fail check, so it lives outside supabase/checks. The scorecard (K7) seeds measure P1
-- from this file.
--
--   psql -X -f supabase/measures/integrate_p1_reactions.sql "$DATABASE_URL"
--
-- Window: the last 42 days. Row 1 is the share of person_roles rows made visible in the window
-- that got an Interested reaction. Rows 2 to 4 are the share of Not for me reactions that carry a
-- reason, split by what the reason is about: level (too_junior, too_senior), place (location,
-- relocation) and function (domain). The last column is n, the rows each share is taken from.
-- With no data a value reads "cannot read", never 0.
with shown as (
  select pr.user_id, pr.job_id
  from public.person_roles pr
  where pr.visible_since >= now() - interval '42 days'
), liked as (
  select count(*) as n
  from shown s
  where exists (
    select 1 from public.role_reactions r
    where r.user_id = s.user_id and r.job_id = s.job_id and r.reaction = 'interested'
  )
), passes as (
  select reason
  from public.role_reactions
  where reaction = 'not_for_me' and reason is not null
    and created_at >= now() - interval '42 days'
)
select 'visible roles marked Interested' as measure,
       case when (select count(*) from shown) = 0 then 'cannot read'
            else round(100.0 * (select n from liked) / (select count(*) from shown), 1)::text || '%' end as value,
       (select count(*) from shown)::text as n
union all
select 'Not for me with a reason: ' || g.label,
       case when (select count(*) from passes) = 0 then 'cannot read'
            else round(100.0 * count(p.reason) / (select count(*) from passes), 1)::text || '%' end,
       (select count(*) from passes)::text
from (values ('level', array['too_junior', 'too_senior']),
             ('place', array['location', 'relocation']),
             ('function', array['domain'])) as g(label, reasons)
left join passes p on p.reason = any (g.reasons)
group by g.label;
