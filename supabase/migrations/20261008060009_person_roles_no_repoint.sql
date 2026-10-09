-- A person may save or hide the roles they hold, not repoint their row at another job: the select policy and person_jobs
-- show whatever job a person_roles row names.
revoke update on public.person_roles from authenticated;
grant update (saved_at, hidden_reason) on public.person_roles to authenticated;
