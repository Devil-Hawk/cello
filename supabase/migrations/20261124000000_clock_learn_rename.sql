-- 20261008040000_clock.sql was edited after some databases had applied it: its learning routine is
-- named harness.learn, not harness.distill, and the command slots prune reads window_start, not
-- created_at. A database that ran the old file has neither change, so make both here. Safe to run
-- on a database that ran the new file.

update public.routines r
   set command = 'harness.learn'
 where r.command = 'harness.distill'
   and not exists (
     select 1 from public.routines n
      where n.command = 'harness.learn'
        and coalesce(n.user_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(r.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
   );

create or replace function public.clock_prune()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pruned jsonb;
  runs_deleted bigint;
  measures_deleted bigint;
  slots_deleted bigint := 0;
begin
  pruned := public.prune_stale_rows();

  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics runs_deleted = row_count;

  delete from public.measure_runs where ran_at < now() - interval '400 days';
  get diagnostics measures_deleted = row_count;

  -- Command slots (K10): a window older than two days is never read again.
  if to_regclass('public.command_slots') is not null then
    execute 'delete from public.command_slots where window_start < now() - interval ''2 days''';
    get diagnostics slots_deleted = row_count;
  end if;

  delete from public.clock_meter where month < (date_trunc('month', now()) - interval '13 months')::date;

  return pruned || jsonb_build_object(
    'cron_runs', runs_deleted, 'measure_runs', measures_deleted, 'command_slots', slots_deleted
  );
end;
$$;
