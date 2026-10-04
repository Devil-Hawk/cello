-- A free-plan database stops at 500 MB, and nothing in this app ever deleted a
-- row on its own. The scraper adds postings and never retires them, and every
-- agent run leaves trace spans and LangGraph checkpoints behind. The first
-- database Cello ran on filled its 2 GB disk that way and could not boot
-- again. Once a day this removes the rows nothing will read again.

create extension if not exists pg_cron;

create or replace function public.prune_stale_rows()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- How long an unreferenced posting is kept after it was first discovered.
  -- One still listed is re-inserted by the next scrape.
  job_ttl constant interval := '45 days';
  -- Spans are the run journal; checkpoints are only read to resume a thread.
  run_ttl constant interval := '30 days';
  keep_referenced text := '';
  fk record;
  jobs_deleted bigint;
  spans_deleted bigint;
  checkpoints_deleted bigint := 0;
begin
  -- A job that anything points at stays, however old. Most of those foreign
  -- keys cascade, so deleting the job would delete the application, draft or
  -- kit with it. They are read from the catalog on every run instead of being
  -- listed here, where the next new reference would be missed.
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
  loop
    keep_referenced := keep_referenced
      || format(' and not exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;

  execute 'delete from public.jobs j where j.discovered_at < now() - $1' || keep_referenced
    using job_ttl;
  get diagnostics jobs_deleted = row_count;

  delete from public.trace_spans where start_time < now() - run_ttl;
  get diagnostics spans_deleted = row_count;

  -- The checkpointer's tables only exist once scripts/setup-checkpointer.ts
  -- has run, hence the dynamic SQL.
  if to_regclass('langgraph.checkpoints') is not null then
    execute $q$
      with stale as (
        select thread_id::text as id from public.graph_threads
        where coalesce(last_invoked_at, created_at) < now() - $1
      ), w as (
        delete from langgraph.checkpoint_writes where thread_id in (select id from stale)
      ), b as (
        delete from langgraph.checkpoint_blobs where thread_id in (select id from stale)
      )
      delete from langgraph.checkpoints where thread_id in (select id from stale)
    $q$ using run_ttl;
    get diagnostics checkpoints_deleted = row_count;
  end if;

  return jsonb_build_object(
    'jobs', jobs_deleted, 'trace_spans', spans_deleted, 'checkpoints', checkpoints_deleted
  );
end;
$$;

-- Housekeeping, not an API: a function in public is callable over PostgREST
-- unless EXECUTE is taken away.
revoke execute on function public.prune_stale_rows() from public, anon, authenticated;

select cron.schedule('prune-stale-rows', '17 9 * * *', 'select public.prune_stale_rows()');
