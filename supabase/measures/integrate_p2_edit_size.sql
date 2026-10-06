-- P2: edit size on drafts, from the feedback queue. Read-only: it changes nothing and is
-- not a pass or fail check, so it lives outside supabase/checks. The scorecard (K7) seeds
-- measure P2 from this file.
--
--   psql -X -f supabase/measures/integrate_p2_edit_size.sql "$DATABASE_URL"
--
-- The size is the word-level edit distance (diff-words-v1, 0 to 1) from what the model wrote to
-- what the person approved. Window: the last 30 days. Only edits that were sent to Langfuse carry
-- a size, so with Langfuse off this reads "cannot read" and never 0.
with edits as (
  select edit_size
  from public.feedback_events
  where signal = 'draft_edited' and edit_size is not null
    and occurred_at >= now() - interval '30 days'
)
select 'median edit size on edited drafts (diff-words-v1)' as measure,
       coalesce(round((percentile_cont(0.5) within group (order by edit_size))::numeric, 3)::text, 'cannot read') as value,
       count(*)::text as edited_drafts
from edits
union all
select 'drafts approved', count(*)::text, null
from public.feedback_events
where signal = 'draft_approved' and occurred_at >= now() - interval '30 days';
