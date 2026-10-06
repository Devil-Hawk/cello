-- A shared role keeps its stored match score and details, and scoring keeps writing them (blueprint R2) until the
-- scoring package moves them to person_roles. Earlier versions of 20261008060007 added a trigger that emptied them.
drop trigger if exists jobs_no_shared_score on public.jobs;
drop function if exists public.jobs_no_shared_score();
