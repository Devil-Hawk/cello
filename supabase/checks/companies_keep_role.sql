-- Proves migration 20261117000000 (keep_company_role): keeping a role opened from an employer's live list
--   * works for an employer the person does not follow (no companies row needed)
--   * stores the posting once for the employer and gives the person one person_roles row, marked via = 'company',
--     however many times it is kept, and never gives it to anyone else
--   * leaves a role the person passed on (not_for_me) passed
--   * refuses an unverified employer, a posting with no key, and a session that names another person
--   * cannot be run by a signed-in person or by anon: only the service role calls it
-- One transaction, rolled back.
--
--   bash supabase/checks/run.sh supabase/checks/companies_keep_role.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b, gen_random_uuid() as e, gen_random_uuid() as u;
grant select on fx to public;

insert into auth.users (id, email) select a, 'kr-a@example.invalid' from fx union all select b, 'kr-b@example.invalid' from fx;
insert into public.profiles (id, email) select a, 'kr-a@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select b, 'kr-b@example.invalid' from fx on conflict (id) do nothing;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select e, 'Keep Works', 'keep works', 'keep-works.example', 'greenhouse', 'keepworks', 'careers_link', now(), 'person' from fx;
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, source)
select u, 'Unverified Keep', 'unverified keep', 'unverified-keep.example', 'greenhouse', 'unverifiedkeep', 'seed' from fx;

create or replace function pg_temp.posting(key text) returns jsonb language sql as $$
  select jsonb_build_object('external_id', key, 'title', 'Forward Deployed Engineer', 'description', 'The plain copy.',
    'url', 'https://keep-works.example/jobs/' || key, 'location', 'Remote', 'source', 'greenhouse', 'last_seen_at', now(),
    'description_md', E'## About\n\nThe whole posting.', 'description_state', 'full', 'description_source', 'detail',
    'description_md5', md5(E'## About\n\nThe whole posting.'), 'role_type', 'forward-deployed-engineer', 'type_origin', 'code')
$$;

-- 1. Kept twice: one jobs row, one person_roles row, via company, the same id both times.
do $$
declare f record; first uuid; again uuid;
begin
  select * into f from fx;
  first := public.keep_company_role(f.a, f.e, pg_temp.posting('kr-1'));
  again := public.keep_company_role(f.a, f.e, pg_temp.posting('kr-1'));
  if first is distinct from again then raise exception 'keeping twice should give the same role, got % and %', first, again; end if;
  if (select count(*) from public.jobs where employer_id = f.e and posting_key = 'kr-1') <> 1 then raise exception 'the posting should be stored once'; end if;
  if (select count(*) from public.person_roles where job_id = first) <> 1 then raise exception 'one person_roles row for the role'; end if;
  if (select via from public.person_roles where user_id = f.a and job_id = first) is distinct from 'company' then raise exception 'the role should be marked via company'; end if;
  if exists (select 1 from public.person_roles where user_id = f.b and job_id = first) then raise exception 'another person should not get the role'; end if;
  if (select company_id from public.jobs where id = first) is not null then raise exception 'an unfollowed employer''s role is the employer''s, not a person''s company row'; end if;
  if (select description_md from public.jobs where id = first) is distinct from E'## About\n\nThe whole posting.' then raise exception 'the whole posting should be kept'; end if;
  if (select hidden_reason from public.person_roles where user_id = f.a and job_id = first) is not null then raise exception 'a kept role is not hidden'; end if;

  -- The person passes on it; keeping it again does not undo that, and keeps its way in.
  update public.person_roles set hidden_reason = 'not_for_me' where user_id = f.a and job_id = first;
  perform public.keep_company_role(f.a, f.e, pg_temp.posting('kr-1'));
  if (select hidden_reason from public.person_roles where user_id = f.a and job_id = first) is distinct from 'not_for_me' then raise exception 'a passed role stays passed'; end if;

  -- A second person keeping the same posting shares the stored role and has a row of their own.
  if public.keep_company_role(f.b, f.e, pg_temp.posting('kr-1')) is distinct from first then raise exception 'two people share one stored posting'; end if;
  if (select count(*) from public.jobs where employer_id = f.e and posting_key = 'kr-1') <> 1 then raise exception 'still one stored posting'; end if;
  if (select count(*) from public.person_roles where job_id = first) <> 2 then raise exception 'one row for each person'; end if;
end $$;

-- 2. Refusals.
do $$
declare f record;
begin
  select * into f from fx;
  begin
    perform public.keep_company_role(f.a, f.u, pg_temp.posting('kr-u'));
    raise exception 'an unverified employer was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.keep_company_role(f.a, f.e, pg_temp.posting('') );
    raise exception 'a posting with no key was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.keep_company_role(f.a, f.e, pg_temp.posting('x') - 'external_id');
    raise exception 'a posting with no external id was accepted';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from public.jobs where employer_id = f.u) then raise exception 'nothing is stored for an unverified employer'; end if;
end $$;

-- A session may only keep for itself.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
do $$
declare f record;
begin
  select * into f from fx;
  begin
    perform public.keep_company_role(f.b, f.e, pg_temp.posting('kr-2'));
    raise exception 'a session kept a role for another person';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.jobs where employer_id = f.e and posting_key = 'kr-2') then raise exception 'nothing is stored for the refused call'; end if;
end $$;
select set_config('request.jwt.claims', '', true);

-- 3. Only the service role calls it.
set local role authenticated;
do $$
begin
  begin
    perform public.keep_company_role(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'authenticated ran keep_company_role';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.keep_company_role(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'anon ran keep_company_role';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
