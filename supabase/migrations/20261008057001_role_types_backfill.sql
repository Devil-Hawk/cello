-- K5c, applied after the code that writes role types is deployed: turn on the backfill. `roles.retype` types
-- every stored role by code and maps each person's old target titles to role types (marked for their review),
-- in slices on the clock. It writes only through apply_title_types and the person's own preferences, never a model.

update public.routines
   set enabled = true, next_due_at = now() + interval '10 minutes'
 where command = 'roles.retype' and user_id is null and not enabled;
