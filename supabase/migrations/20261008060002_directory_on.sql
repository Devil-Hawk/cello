-- K6, applied after the seed load is measured and the slice size is committed: start the directory's three routines.
-- The sweep verifies candidates and reads employers in slices every 30 minutes, the seed refreshes its lists on its own
-- schedule, and the suggestions refresh rebuilds each person's "Suggested for you" once a day.

update public.routines
   set enabled = true,
       next_due_at = case command
         when 'directory.sweep' then now() + interval '10 minutes'
         else date_trunc('day', now()) + interval '1 day' + case command when 'directory.seed' then interval '4 hours' else interval '14 hours 30 minutes' end
       end
 where user_id is null and command in ('directory.sweep', 'directory.seed', 'suggestions.refresh') and not enabled;

-- The directory_leads flag stays off here: leads keep their old path until the directory has filled (20261008060003).
