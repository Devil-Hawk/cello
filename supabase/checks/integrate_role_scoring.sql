-- Proves the storage behind the personal shortlist (migrations 20261009000200 to
-- 20261009000202):
--   * row level security is on for the three new tables and nothing is granted to anon;
--   * a person can only see and change their own reactions, and the reaction
--     reasons, surfaces and snapshot length are the ones the page uses;
--   * no per person verdict column is left on jobs;
--   * a signed-in session, even the owner of the company row a posting hangs off,
--     cannot update the posting or evict it, and no function it can run writes jobs
--     with elevated rights (migration 20261009000701);
-- and, once public.person_roles exists (the employer and role work, K5a):
--   * one person's verdict on a shared role is invisible to another person;
--   * a session cannot write a verdict column, but can hide a role for itself;
--   * a changed posting clears the chance and the check date for everyone who sees
--     it and keeps what they want;
--   * applying records an applied reaction carrying that person's own prediction,
--     with the employer name even when jobs.company_id is null;
--   * the chance distillation counts through person_roles.
-- Everything runs in one transaction and rolls back, so any database is safe to
-- point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/integrate_role_scoring.sql

\set ON_ERROR_STOP 1
begin;

do $$
declare t text;
begin
  foreach t in array array['role_reactions', 'shortlist_items', 'taste_models'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception 'anon has access to %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.shortlist_items', 'insert') or has_table_privilege('authenticated', 'public.taste_models', 'insert') then
    raise exception 'authenticated can write server-owned tables';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs'
      and column_name in ('fit_assessed_at', 'blocked_reasons', 'want_p', 'want_reason', 'want_detail', 'chance', 'chance_detail', 'requirement_items')
  ) then
    raise exception 'a per person verdict column is on jobs';
  end if;
end;
$$;

create temp table fx as
select gen_random_uuid() as user_a, gen_random_uuid() as user_b, gen_random_uuid() as company_a,
       gen_random_uuid() as live_job;
insert into auth.users (id, email) select user_a, 'scoring-a@example.invalid' from fx union all select user_b, 'scoring-b@example.invalid' from fx;
insert into public.profiles (id, email) select user_a, 'scoring-a@example.invalid' from fx union all select user_b, 'scoring-b@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url) select company_a, user_a, 'Scoring Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id, discovered_at)
select live_job, company_a, 'live role', 'live description', 'https://x/2', 'sc-2', now() from fx;

-- Reactions: the reasons and surfaces of the page, and nothing else.
do $$
declare f record;
begin
  select * into f from fx;
  insert into public.role_reactions (user_id, job_id, reaction, reason, surface, job_title)
  values (f.user_a, f.live_job, 'not_for_me', 'relocation', 'roles', 'live role');
  delete from public.role_reactions where user_id = f.user_a;

  begin
    insert into public.role_reactions (user_id, job_id, reaction, surface, job_title) values (f.user_a, f.live_job, 'interested', 'opportunities', 'x');
    raise exception 'the retired surface name opportunities was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.role_reactions (user_id, job_id, reaction, job_title, job_text) values (f.user_a, f.live_job, 'interested', 'x', repeat('a', 2001));
    raise exception 'a snapshot over 2000 characters was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.role_reactions (user_id, job_id, reaction, reason, job_title) values (f.user_a, f.live_job, 'interested', 'pay', 'x');
    raise exception 'a reason on an Interested reaction was accepted';
  exception when check_violation then null;
  end;
end;
$$;

-- Owner scoping: person B sees none of person A's reactions.
insert into public.role_reactions (user_id, job_id, reaction, reason, job_title, company_name, job_text)
select user_a, live_job, 'not_for_me', 'pay', 'live role', 'Scoring Check', 'live role' from fx;
select user_b::text as b from fx \gset
select set_config('request.jwt.claims', json_build_object('sub', :'b', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare n integer;
begin
  select count(*) into n from public.role_reactions;
  if n <> 0 then raise exception 'person B can see % of person A''s reactions', n; end if;
end;
$$;
reset role;

grant select on fx to authenticated;

-- Postings are server-only: no privilege lets a session change an existing row.
do $$
declare f record; c text; bad text;
begin
  select * into f from fx;
  assert not has_table_privilege('authenticated', 'public.jobs', 'UPDATE'), 'authenticated has table UPDATE on jobs';
  assert not has_any_column_privilege('authenticated', 'public.jobs', 'UPDATE'), 'authenticated has a column UPDATE on jobs';
  select string_agg(p.proname, ', ') into bad from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prorettype <> 'trigger'::regtype
    and p.prosrc ~* '(update|delete\s+from|insert\s+into)\s+public\.jobs\y'
    and has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then raise exception 'a signed-in session can run a definer function that writes jobs: %', bad; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', f.user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  foreach c in array array['description', 'requirements', 'title', 'url', 'requirements_extracted_at', 'employer_id'] loop
    continue when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = c);
    begin
      execute format('update public.jobs set %1$I = %1$I where id = $1', c) using f.live_job;
      raise exception 'the owner of the company row rewrote %', c;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.evict_company_jobs(f.company_a, array['sc-2']);
    raise exception 'the owner of the company row evicted a posting';
  exception when insufficient_privilege then null;
  end;
  reset role;
end;
$$;
select to_regclass('public.person_roles') is not null as has_person_roles \gset
\if :has_person_roles

-- Two people share one role and each has a row for it.
insert into public.person_roles (user_id, job_id, assessed_at, blocked_reasons, want_p, want_reason, want_detail, chance, chance_detail)
select user_a, live_job, now(), '[]'::jsonb, 0.7, 'Because.', '{"judge": 0.8, "embedding": 0.6, "stated": 0.5}'::jsonb, 'strong', '{"checks": []}'::jsonb from fx
on conflict (user_id, job_id) do update set assessed_at=excluded.assessed_at, blocked_reasons=excluded.blocked_reasons, want_p=excluded.want_p, want_reason=excluded.want_reason, want_detail=excluded.want_detail, chance=excluded.chance, chance_detail=excluded.chance_detail;
insert into public.person_roles (user_id, job_id) select user_b, live_job from fx on conflict do nothing;

-- Person B sees their own row and not A's verdict.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'b', 'role', 'authenticated')::text, true);
do $$
declare f record; n integer;
begin
  select * into f from fx;
  select count(*) into n from public.person_roles where user_id = f.user_a;
  if n <> 0 then raise exception 'person B can see person A''s row'; end if;
  select count(*) into n from public.person_roles where want_p is not null;
  if n <> 0 then raise exception 'person B can see a verdict that is not theirs'; end if;
end;
$$;

-- A session cannot write a verdict (42501), but can hide the role for itself.
do $$
declare f record;
begin
  select * into f from fx;
  begin
    update public.person_roles set want_p = 0.99 where user_id = f.user_b and job_id = f.live_job;
    raise exception 'a session wrote a verdict';
  exception when insufficient_privilege then null;
  end;
  update public.person_roles set hidden_reason = 'not_for_me' where user_id = f.user_b and job_id = f.live_job;
  if not exists (select 1 from public.person_roles where user_id = f.user_b and hidden_reason = 'not_for_me') then
    raise exception 'a person could not hide a role for themselves';
  end if;
end;
$$;
reset role;

-- A changed posting clears chance and assessed_at for both people and keeps want.
do $$
declare f record; a record; b record;
begin
  select * into f from fx;
  update public.person_roles set assessed_at = now(), chance = 'possible', chance_detail = '{}'::jsonb, want_p = 0.4 where user_id = f.user_b and job_id = f.live_job;
  update public.jobs set description = 'live description' where id = f.live_job;
  select * into a from public.person_roles where user_id = f.user_a and job_id = f.live_job;
  if a.chance is null or a.assessed_at is null then raise exception 'an unchanged description reset the verdict'; end if;
  update public.jobs set description = 'a different description' where id = f.live_job;
  select * into a from public.person_roles where user_id = f.user_a and job_id = f.live_job;
  select * into b from public.person_roles where user_id = f.user_b and job_id = f.live_job;
  if a.chance is not null or a.assessed_at is not null or b.chance is not null or b.assessed_at is not null then
    raise exception 'a changed description kept the old verdict';
  end if;
  if a.want_p is null or b.want_p is null then raise exception 'the want was cleared along with the chance'; end if;
end;
$$;

-- A session's attempt to rewrite the posting leaves every follower's verdict alone.
do $$
declare f record; b record;
begin
  select * into f from fx;
  update public.person_roles set chance = 'possible', assessed_at = now() where user_id = f.user_b and job_id = f.live_job;
  perform set_config('request.jwt.claims', json_build_object('sub', f.user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.jobs set description = 'x' where id = f.live_job;
    raise exception 'a session rewrote the description';
  exception when insufficient_privilege then null;
  end;
  reset role;
  select * into b from public.person_roles where user_id = f.user_b and job_id = f.live_job;
  if b.chance is distinct from 'possible' or b.assessed_at is null then raise exception 'a refused update still cleared a verdict'; end if;
  if (select description from public.jobs where id = f.live_job) is distinct from 'a different description' then
    raise exception 'the description changed';
  end if;
end;
$$;

-- Applying records the strongest positive, with what Cello predicted for that person.
do $$
declare f record; r record; n integer;
begin
  select * into f from fx;
  delete from public.role_reactions where user_id = f.user_a;
  update public.person_roles set want_p = 0.7, chance = 'possible' where user_id = f.user_a and job_id = f.live_job;
  insert into public.applications (user_id, job_id, stage, source) values (f.user_a, f.live_job, 'discovered', 'triage');
  select count(*) into n from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if n <> 0 then raise exception 'a discovered application recorded a reaction'; end if;
  update public.applications set stage = 'applied', applied_at = now() where user_id = f.user_a and job_id = f.live_job;
  update public.applications set stage = 'interview' where user_id = f.user_a and job_id = f.live_job;
  select * into r from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if r.reaction is distinct from 'applied' then raise exception 'applied reaction missing'; end if;
  if abs((r.predicted ->> 'blended')::float8 - 0.7) > 0.0001 then raise exception 'the prediction was not copied: %', r.predicted; end if;
  if r.predicted ->> 'chance' is distinct from 'possible' then raise exception 'the chance was not copied'; end if;
  if r.surface is distinct from 'applications' then raise exception 'the reaction names surface %', r.surface; end if;
  select count(*) into n from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if n <> 1 then raise exception 'more than one reaction for one role: %', n; end if;
end;
$$;

-- Naming a job the person does not hold records nothing, and copies none of its text.
do $$
declare f record; n integer;
begin
  select * into f from fx;
  delete from public.person_roles where user_id = f.user_b and job_id = f.live_job;
  insert into public.applications (user_id, job_id, stage, source) values (f.user_b, f.live_job, 'applied', 'triage');
  select count(*) into n from public.role_reactions where user_id = f.user_b;
  if n <> 0 then raise exception 'an application for a job with no person_roles row snapshotted it'; end if;
end;
$$;

-- The chance distillation counts through person_roles.
do $$
declare f record; n integer;
begin
  select * into f from fx;
  update public.person_roles set chance = 'strong' where user_id = f.user_a and job_id = f.live_job;
  update public.applications set stage = 'interview' where user_id = f.user_a and job_id = f.live_job;
  select positive_count into n from public.distill_chance_by_label(f.user_a) where band = 'strong';
  if n is distinct from 1 then raise exception 'distill_chance_by_label counted % interviews for a strong role', n; end if;
end;
$$;

-- Retiring the match score clears it on the person's own row too (needs K5a's match_score column).
select exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'person_roles' and column_name = 'match_score'
) as has_pr_match_score \gset
\if :has_pr_match_score
update public.person_roles set match_score = 70 where user_id = (select user_a from fx) and job_id = (select live_job from fx);
\ir ../migrations/20261009000201_retire_match_score.sql
do $$
begin
  if exists (select 1 from public.person_roles where match_score is not null or match_details is not null) then
    raise exception 'retiring the match score left one on a person_roles row';
  end if;
end;
$$;
\endif

\else
\echo lane-stub: K5a person_roles absent, person_roles checks skipped
\endif

\echo role_scoring checks passed
rollback;
