-- Supabase stopped granting new public-schema tables to the API roles
-- automatically (changelog, 2026-04-28: off for new projects from 2026-05-30,
-- enforced on every project from 2026-10-30). Every migration after this one
-- was written for the old behavior: anon, authenticated and service_role can
-- reach each table, and RLS decides which rows they see. Without these
-- defaults a fresh database (`supabase start`, or a new project) answers
-- "permission denied" to every query the app makes.
--
-- This runs first so the tables below are created with their grants, and the
-- REVOKEs later migrations make still land in the order they were written.
-- Tables that exist when the platform change reaches a project keep their
-- grants. A table added after that needs its own GRANT in its own migration.

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
