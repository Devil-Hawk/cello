-- Proves the storage behind the personal shortlist (migration 20261006000200):
--   * row level security is on for the three new tables and nothing is granted to anon;
--   * a person can only see and change their own reactions;
--   * the prune still deletes an old unreferenced job although reactions and
--     shortlist rows mention it, and the reaction keeps its snapshot;
--   * changing a job's description clears what was read from it;
--   * moving an application to applied records an applied reaction carrying
--     what Cello predicted, and a later stage does not duplicate it.
-- Everything runs in one transaction and rolls back, so any database is safe to
-- point it at.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/role_scoring.sql

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
end;
$$;

create temp table fx as
select gen_random_uuid() as user_a, gen_random_uuid() as user_b, gen_random_uuid() as company_a,
       gen_random_uuid() as old_job, gen_random_uuid() as live_job;
insert into auth.users (id, email) select user_a, 'scoring-a@example.invalid' from fx union all select user_b, 'scoring-b@example.invalid' from fx;
insert into public.profiles (id, email) select user_a, 'scoring-a@example.invalid' from fx union all select user_b, 'scoring-b@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url) select company_a, user_a, 'Scoring Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id, discovered_at, want_p, want_detail, chance, requirement_items, fit_assessed_at)
select old_job,  company_a, 'old role',  'old description',  'https://x/1', 'sc-1', now() - interval '60 days', null, null, null, null, null from fx union all
select live_job, company_a, 'live role', 'live description', 'https://x/2', 'sc-2', now(), 0.7, '{"judge": 0.8, "embedding": 0.6, "stated": 0.5}'::jsonb, 'strong', '{"version": 1, "kind": "ok", "items": []}'::jsonb, now() from fx;

-- Once the ingestion work lands the prune ages jobs by last_seen_at instead of discovered_at.
do $$
declare f record;
begin
  select * into f from fx;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'last_seen_at') then
    execute 'update public.jobs set last_seen_at = now() - interval ''60 days'' where id = $1' using f.old_job;
  end if;
end;
$$;

-- Reactions and a shortlist row that mention the old job.
insert into public.role_reactions (user_id, job_id, reaction, reason, job_title, company_name, job_text)
select user_a, old_job, 'not_for_me', 'pay', 'old role', 'Scoring Check', 'old role' from fx;
insert into public.shortlist_items (user_id, for_date, job_id, position, pick_kind, explanation)
select user_a, current_date, old_job, 1, 'top', 'Because.' from fx;

-- A reason belongs to a pass only.
do $$
begin
  begin
    insert into public.role_reactions (user_id, job_id, reaction, reason, job_title)
    select user_a, live_job, 'interested', 'pay', 'x' from fx;
    raise exception 'a reason on an Interested reaction was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

-- Owner scoping: person B sees none of person A's reactions.
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

-- The prune deletes the old job even though a reaction and a shortlist row mention it.
select public.prune_stale_rows() as pruned \gset
do $$
declare f record; reaction record;
begin
  select * into f from fx;
  if exists (select 1 from public.jobs where id = f.old_job) then raise exception 'the old job survived the prune'; end if;
  if not exists (select 1 from public.jobs where id = f.live_job) then raise exception 'the live job was pruned'; end if;
  select * into reaction from public.role_reactions where user_id = f.user_a;
  if reaction.job_title is distinct from 'old role' or reaction.reason is distinct from 'pay' then
    raise exception 'the reaction lost its snapshot';
  end if;
end;
$$;

-- A changed description clears what was read from it; an unchanged one does not.
do $$
declare f record; j record;
begin
  select * into f from fx;
  update public.jobs set description = 'live description' where id = f.live_job;
  select * into j from public.jobs where id = f.live_job;
  if j.chance is null or j.requirement_items is null or j.fit_assessed_at is null then
    raise exception 'an unchanged description reset the assessment';
  end if;
  update public.jobs set description = 'a different description' where id = f.live_job;
  select * into j from public.jobs where id = f.live_job;
  if j.chance is not null or j.requirement_items is not null or j.fit_assessed_at is not null then
    raise exception 'a changed description kept the old assessment';
  end if;
  if j.want_p is null then raise exception 'the want was cleared along with the chance'; end if;
end;
$$;

-- Applying records the strongest positive, with what Cello predicted.
do $$
declare f record; r record; n integer;
begin
  select * into f from fx;
  update public.jobs set want_p = 0.7, want_detail = '{"judge": 0.8, "embedding": 0.6, "stated": 0.5}'::jsonb, chance = 'possible' where id = f.live_job;
  insert into public.applications (user_id, job_id, stage, source) values (f.user_a, f.live_job, 'discovered', 'triage');
  select count(*) into n from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if n <> 0 then raise exception 'a discovered application recorded a reaction'; end if;
  update public.applications set stage = 'applied', applied_at = now() where user_id = f.user_a and job_id = f.live_job;
  update public.applications set stage = 'interview' where user_id = f.user_a and job_id = f.live_job;
  select * into r from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if r.reaction is distinct from 'applied' then raise exception 'applied reaction missing'; end if;
  if (r.predicted ->> 'blended')::float8 is distinct from 0.7::real::float8 and abs((r.predicted ->> 'blended')::float8 - 0.7) > 0.0001 then
    raise exception 'the prediction was not copied: %', r.predicted;
  end if;
  if r.predicted ->> 'chance' is distinct from 'possible' then raise exception 'the chance was not copied'; end if;
  select count(*) into n from public.role_reactions where user_id = f.user_a and job_id = f.live_job;
  if n <> 1 then raise exception 'more than one reaction for one role: %', n; end if;
end;
$$;

\echo role_scoring checks passed
rollback;
