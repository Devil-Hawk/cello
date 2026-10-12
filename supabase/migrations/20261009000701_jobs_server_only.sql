-- A signed-in session can no longer change or remove a posting row.
--
-- One jobs row is shared by everyone who follows it, with company_id left on
-- whichever person's company row held it first. The default grants
-- (20240131000000) gave authenticated UPDATE, DELETE and TRUNCATE on the table,
-- and the own-company update policy (20260717000003) let that first holder
-- PATCH description or requirements, which the SECURITY DEFINER reset trigger
-- (20261009000200) then answers by clearing every follower's verdict.
--
-- The server (service role) is the only writer of postings: Check now and
-- Refresh write through the ats store's service client. What stays: select
-- (own-company policy), and insert, which the Gmail share and sync routes use.
-- record_job_sightings keeps its grant but is SECURITY INVOKER, so a session
-- calling it on its own now fails on the update. The two DEFINER functions that
-- delete or close postings move to the service role. The update policy stays
-- (inert without the privilege; 20261005000003 asserts it exists).
--
-- Idempotent: repeating a revoke or grant changes nothing, and no row is touched.

revoke update, delete, truncate on public.jobs from anon, authenticated;

revoke execute on function public.evict_company_jobs(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.clear_unverified_board_jobs(uuid, text) from public, anon, authenticated;
grant execute on function public.evict_company_jobs(uuid, text[]) to service_role;
grant execute on function public.clear_unverified_board_jobs(uuid, text) to service_role;

do $$
begin
  assert not has_table_privilege('authenticated', 'public.jobs', 'UPDATE'), 'authenticated can still update jobs';
  assert not has_any_column_privilege('authenticated', 'public.jobs', 'UPDATE'), 'authenticated has a column UPDATE on jobs';
  assert has_table_privilege('authenticated', 'public.jobs', 'INSERT'), 'gmail share and sync still insert';
end $$;

notify pgrst, 'reload schema';
