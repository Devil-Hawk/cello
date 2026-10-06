-- P4 (watch): replies per 10 applications sent, over trusted mail only (person, proven, confirmed),
-- per person with at least one sent application. Read only. "cannot read" when there is nothing to count.
-- The pre-Cello baseline is the same count over the mailbox before the first Cello application; the owner
-- supplies it, so the comparison is his to make.
--
--   psql "$DATABASE_URL" -f supabase/measures/network_p4_replies.sql

with sent as (
  select user_id, count(*) as n from public.applications where stage in ('applied', 'screen', 'interview', 'offer', 'accepted') group by user_id
), replied as (
  select m.user_id, count(distinct m.application_id) as n
    from public.messages m
   where m.direction = 'in' and m.application_id is not null and m.trust in ('person', 'proven', 'confirmed') and m.kind in ('reply', 'interview', 'offer', 'recruiter')
   group by m.user_id
)
select s.user_id,
       s.n as applications_sent,
       coalesce(r.n, 0) as with_a_reply,
       round(10.0 * coalesce(r.n, 0) / s.n, 2) as replies_per_10_sent,
       case when s.n < 1 then 'cannot read' else 'read' end as state
  from sent s
  left join replied r using (user_id)
 order by s.n desc;
