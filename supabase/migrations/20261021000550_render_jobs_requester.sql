-- PR 2 (companies/search-and-add): who asked for a queued read.
--
-- A web search or a careers page the server could not read is queued for the pull worker. When the worker's answer
-- proves an employer, the person who asked is the one who follows it. The person's account going away clears the
-- column; the job stays for the queue.

alter table public.render_jobs
  add column if not exists requested_by uuid references auth.users (id) on delete set null;

do $$
begin
  assert (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'render_jobs' and column_name = 'requested_by') = 1,
    'render_jobs.requested_by is missing';
end $$;
