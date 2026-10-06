-- K6: the directory (migration 20261008060001). Verified rows only, candidates never listed, the sweep's order.
--
-- Proves: a seed slug or a YC row that is still a candidate is never in list_company_directory or
-- search_company_directory, and neither is a directory row that has not been verified; "retell",
-- "retellai.com", "retell-ai" and "Retell AI" each find Retell AI first, a namesake behind it; the name key
-- ignores legal words; upsert_directory_candidates writes only new or changed entries and sends a changed name
-- back to pending; directory_candidates_due orders followed employers, then YC, then the rest, and leaves out
-- a failed row until its next check; directory_boards_due reads boards with a recent posting first and
-- leaves out a board that cannot be read; bump_employer_stats replaces an employer's counters;
-- upsert_employer_jobs stores a role with no company, once, and refuses an employer that is not verified;
-- record_employer_sightings closes a role at the second miss; a signed-in person reads no candidate and
-- calls none of these functions. Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/directory_verify.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as u,
       gen_random_uuid() as retell, gen_random_uuid() as retell_labs, gen_random_uuid() as unverified,
       gen_random_uuid() as busy, gen_random_uuid() as quiet, gen_random_uuid() as gone;
grant select on fx to public;

insert into auth.users (id, email) select u, 'directory-a@example.invalid' from fx;
insert into public.profiles (id, email) select u, 'directory-a@example.invalid' from fx on conflict (id) do nothing;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source, open_count) values
  ((select retell from fx), 'Retell AI', 'retell ai', 'retellai.com', 'ashby', 'retell-ai', 'careers_page_link', now(), 'person', 12),
  ((select retell_labs from fx), 'Retell Labs', 'retell labs', 'retelllabs.example', 'greenhouse', 'retelllabs', 'seed_checked', now(), 'seed', 3),
  ((select busy from fx), 'Busy Co', 'busy co', 'busy.example', 'greenhouse', 'busyco', 'seed_checked', now(), 'seed', 40),
  ((select quiet from fx), 'Quiet Co', 'quiet co', 'quiet.example', 'greenhouse', 'quietco', 'seed_checked', now(), 'seed', 5);
-- a row that was never verified, and a verified board that cannot be read
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, source)
select unverified, 'Retell Unverified', 'retell unverified', 'retellunverified.example', 'greenhouse', 'retellunverified', 'seed' from fx;
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source, cannot_read_reason)
select gone, 'Gone Co', 'gone co', 'gone.example', 'greenhouse', 'goneco', 'seed_checked', now(), 'seed', 'no_board' from fx;

insert into public.directory_candidates (name, name_norm, ats_provider, ats_token, source) values
  ('Retell Seed', 'retell seed', 'greenhouse', 'retell-seed', 'kalil');

-- 1. The name key is the one the app computes.
do $$
begin
  if public.company_name_norm('Gusto, Inc.') <> 'gusto' then raise exception 'legal words are not part of the key, got %', public.company_name_norm('Gusto, Inc.'); end if;
  if public.company_name_norm('The Trade Desk') <> 'trade desk' then raise exception 'the is not part of the key'; end if;
  if public.company_name_norm('Retell-AI') <> 'retell ai' then raise exception 'punctuation is a space'; end if;
  if public.company_name_norm(null) <> '' then raise exception 'null is the empty key'; end if;
end $$;

-- 2. Search and list: verified rows only, best match first.
do $$
declare f record; first_name text; names text;
begin
  select * into f from fx;
  foreach first_name in array array['retell', 'retellai.com', 'retell-ai', 'Retell AI', ' RETELL ']
  loop
    select name into names from public.search_company_directory(first_name, 5) limit 1;
    if names is distinct from 'Retell AI' then raise exception 'search for % must find Retell AI first, got %', first_name, names; end if;
  end loop;
  -- the namesake is behind it; the unverified row and the candidate are nowhere
  select string_agg(name, ', ' order by name) into names from public.search_company_directory('retell', 10);
  if names <> 'Retell AI, Retell Labs' then raise exception 'search for retell must list the two verified employers only, got %', names; end if;
  if exists (select 1 from public.list_company_directory(100, 0) where id = f.unverified or name = 'Retell Seed') then
    raise exception 'list_company_directory returned a row that is not verified';
  end if;
  if (select count(*) from public.list_company_directory(100, 0)) <> 5 then raise exception 'five verified employers are listed (the unverified one is not), got %', (select count(*) from public.list_company_directory(100, 0)); end if;
  -- most open roles first
  if (select name from public.list_company_directory(1, 0)) <> 'Busy Co' then raise exception 'the list starts with the most open roles'; end if;
  if (select count(*) from public.search_company_directory('   ', 5)) <> 0 then raise exception 'a blank query finds nothing'; end if;
  -- a board token and a domain match exactly
  if (select name from public.search_company_directory('busyco', 3) limit 1) is distinct from 'Busy Co' then raise exception 'a board token finds its employer'; end if;
end $$;

-- 3. The seed's entries: only new or changed ones are written; a changed name goes back to pending.
do $$
declare seed jsonb; n integer; st text;
begin
  seed := jsonb_build_array(
    jsonb_build_object('name', 'Gusto', 'name_norm', 'gusto', 'ats_provider', 'greenhouse', 'ats_token', 'gusto', 'source', 'kalil'),
    jsonb_build_object('name', 'Retell AI', 'name_norm', 'retell ai', 'domain', 'retellai.com', 'source', 'yc', 'tags', jsonb_build_array('ai', 'voice'), 'one_liner', 'Voice agents', 'batch', 'W24'));
  n := public.upsert_directory_candidates(seed);
  if n <> 2 then raise exception 'two new entries are written, got %', n; end if;
  if (select tags from public.directory_candidates where domain = 'retellai.com') <> array['ai', 'voice'] then raise exception 'YC tags are kept'; end if;
  -- the same board row again changes nothing; the YC row is refreshed
  n := public.upsert_directory_candidates(jsonb_build_array(seed -> 0));
  if n <> 0 then raise exception 'an unchanged board entry is not written again, got %', n; end if;
  update public.directory_candidates set state = 'verified', checked_at = now() where ats_token = 'gusto';
  n := public.upsert_directory_candidates(jsonb_build_array(jsonb_build_object('name', 'Gusto Payroll', 'name_norm', 'gusto payroll', 'ats_provider', 'greenhouse', 'ats_token', 'gusto', 'source', 'kalil')));
  select state into st from public.directory_candidates where ats_token = 'gusto';
  if n <> 1 or st <> 'pending' then raise exception 'a changed name sends the entry back to pending, got % and %', n, st; end if;
  -- a seed row can never be a directory row
  if exists (select 1 from public.company_directory where name in ('Gusto', 'Gusto Payroll')) then raise exception 'the seed never writes the directory'; end if;
end $$;

-- 4. What a slice checks first: followed employers, then YC, then the rest oldest first; failed rows wait.
do $$
declare f record; order_ text;
begin
  select * into f from fx;
  delete from public.directory_candidates;
  insert into public.directory_candidates (name, name_norm, domain, ats_provider, ats_token, source, next_check_at, state) values
    ('Old Seed',      'old seed',      null,                  'greenhouse', 'oldseed',   'kalil', now() - interval '5 days', 'pending'),
    ('New Seed',      'new seed',      null,                  'greenhouse', 'newseed',   'kalil', now() - interval '1 hour', 'pending'),
    ('Yc Co',         'yc co',         'yc.example',          null,         null,        'yc',    now() - interval '2 hours', 'pending'),
    ('Followed Co',   'followed co',   'followed.example',    'greenhouse', 'followedco','kalil', now() - interval '1 minute', 'pending'),
    ('Failed Later',  'failed later',  null,                  'greenhouse', 'failedlater','kalil', now() + interval '60 days', 'failed'),
    ('Failed Due',    'failed due',    null,                  'greenhouse', 'faileddue', 'kalil', now() - interval '3 days', 'failed');
  insert into public.companies (user_id, name, domain, career_url, watching) values (f.u, 'Followed Co', 'followed.example', '', true);
  select string_agg(name, ' > ' order by ord) into order_ from (select name, row_number() over () as ord from public.directory_candidates_due(10)) s;
  if order_ <> 'Followed Co > Yc Co > Old Seed > Failed Due > New Seed' then raise exception 'the due order is wrong: %', order_; end if;
  if (select count(*) from public.directory_candidates_due(2)) <> 2 then raise exception 'the limit holds'; end if;
end $$;

-- 5. The boards a slice reads: a recent posting first, a board that cannot be read never.
do $$
declare f record; order_ text;
begin
  select * into f from fx;
  insert into public.employer_stats (employer_id, role_type, seniority, open_count, opened_30d, opened_90d) values (f.busy, null, 'senior', 40, 6, 12), (f.quiet, null, 'senior', 5, 0, 1);
  update public.company_directory set next_read_at = now() - interval '2 hours' where id in (f.quiet, f.busy);
  update public.company_directory set next_read_at = now() - interval '1 hour' where id in (f.retell, f.retell_labs);
  select string_agg(name, ' > ' order by ord) into order_ from (select name, row_number() over () as ord from public.directory_boards_due(10)) s;
  if order_ not like 'Busy Co > Quiet Co > %' then raise exception 'a board with a posting in the last 30 days is read first, got %', order_; end if;
  if order_ like '%Gone Co%' or order_ like '%Unverified%' then raise exception 'a board that cannot be read, or is not verified, is not read: %', order_; end if;
  update public.company_directory set next_read_at = now() + interval '1 day' where id = f.busy;
  if exists (select 1 from public.directory_boards_due(10) where id = f.busy) then raise exception 'a board is not read before its time'; end if;
end $$;

-- 6. Counters: a read replaces the employer's rows.
do $$
declare f record; n integer;
begin
  select * into f from fx;
  n := public.bump_employer_stats(f.retell, jsonb_build_array(
    jsonb_build_object('role_type', null, 'seniority', 'senior', 'open', 3, 'opened_30d', 1, 'opened_90d', 2),
    jsonb_build_object('role_type', null, 'seniority', 'mid', 'open', 2, 'opened_30d', 0, 'opened_90d', 1)));
  if n <> 2 then raise exception 'two counter rows, got %', n; end if;
  n := public.bump_employer_stats(f.retell, jsonb_build_array(jsonb_build_object('role_type', null, 'seniority', 'senior', 'open', 7, 'opened_30d', 2, 'opened_90d', 3)));
  if (select count(*) from public.employer_stats where employer_id = f.retell) <> 1 then raise exception 'a read replaces the employer''s counters'; end if;
  if (select open_count from public.employer_stats where employer_id = f.retell) <> 7 then raise exception 'the counter is the last read'; end if;
  -- an unknown role type is not a row
  n := public.bump_employer_stats(f.retell, jsonb_build_array(jsonb_build_object('role_type', 'no-such-type', 'seniority', 'senior', 'open', 1)));
  if n <> 0 then raise exception 'a role type that does not exist is not counted'; end if;
end $$;

-- 7. Roles kept for someone who does not follow the employer: one row, no company.
do $$
declare f record; one jsonb; n integer;
begin
  select * into f from fx;
  one := jsonb_build_array(jsonb_build_object('external_id', 'req-1', 'title', 'Platform Engineer', 'description', 'd', 'url', 'https://retellai.com/jobs/1',
          'source', 'ashby', 'source_tier', 'board', 'last_seen_at', now(), 'posted_at', now() - interval '2 days',
          'description_md', '# Platform Engineer', 'description_state', 'full', 'description_source', 'api', 'description_md5', md5('# Platform Engineer')));
  perform public.upsert_employer_jobs(f.retell, one);
  perform public.upsert_employer_jobs(f.retell, one);
  if (select count(*) from public.jobs where employer_id = f.retell and posting_key = 'req-1') <> 1 then raise exception 'one row per posting'; end if;
  if (select company_id from public.jobs where employer_id = f.retell and posting_key = 'req-1') is not null then raise exception 'a role kept by the sweep has no company'; end if;
  -- a read that found no body leaves the stored one
  perform public.upsert_employer_jobs(f.retell, jsonb_build_array(jsonb_build_object('external_id', 'req-1', 'title', 'Platform Engineer II', 'description', 'd', 'url', 'https://retellai.com/jobs/1', 'source', 'ashby', 'last_seen_at', now())));
  if (select description_md from public.jobs where employer_id = f.retell and posting_key = 'req-1') <> '# Platform Engineer' then raise exception 'a stored body is not blanked by a read without one'; end if;
  if (select title from public.jobs where employer_id = f.retell and posting_key = 'req-1') <> 'Platform Engineer II' then raise exception 'the title is updated'; end if;
  begin
    perform public.upsert_employer_jobs(f.unverified, one);
    raise exception 'an employer that is not verified must be refused';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- 8. Sightings by employer: listed roles stay open, the rest close at the second miss.
do $$
declare f record; r jsonb;
begin
  select * into f from fx;
  perform public.upsert_employer_jobs(f.retell, jsonb_build_array(jsonb_build_object('external_id', 'req-2', 'title', 'Designer', 'description', 'd', 'url', 'https://retellai.com/jobs/2', 'source', 'ashby', 'last_seen_at', now() - interval '1 day')));
  r := public.record_employer_sightings(f.retell, array['req-1'], array['ashby'], 2);
  if (r ->> 'missed')::int <> 1 or (r ->> 'closed')::int <> 0 then raise exception 'the first miss is counted, not closed: %', r; end if;
  update public.jobs set last_seen_at = now() - interval '1 day' where employer_id = f.retell and posting_key = 'req-2';
  r := public.record_employer_sightings(f.retell, array['req-1'], array['ashby'], 2);
  if (r ->> 'closed')::int <> 1 or (select still_open from public.jobs where employer_id = f.retell and posting_key = 'req-2') then raise exception 'the second miss closes the role: %', r; end if;
  -- a window onto the board (no sources) closes nothing; an empty list is no evidence
  update public.jobs set still_open = true, missed_checks = 0, last_seen_at = now() - interval '1 day' where employer_id = f.retell and posting_key = 'req-2';
  perform public.record_employer_sightings(f.retell, array['req-1'], array[]::text[], 2);
  perform public.record_employer_sightings(f.retell, array[]::text[], array['ashby'], 2);
  if not (select still_open from public.jobs where employer_id = f.retell and posting_key = 'req-2') or (select missed_checks from public.jobs where employer_id = f.retell and posting_key = 'req-2') <> 0 then
    raise exception 'a window or an empty list counts no miss';
  end if;
end $$;

-- 9. A signed-in person: no candidate, no seed, none of the directory's functions.
create function pg_temp.must_be_denied(q text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select u from fx), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q;
  exception when insufficient_privilege then
    reset role;
    return;
  end;
  reset role;
  raise exception 'expected 42501 for: %', q;
end $$;

select pg_temp.must_be_denied('select count(*) from public.directory_candidates');
select pg_temp.must_be_denied('select * from public.search_company_directory(''retell'', 5)');
select pg_temp.must_be_denied('select * from public.list_company_directory(5, 0)');
select pg_temp.must_be_denied('select * from public.directory_candidates_due(5)');
select pg_temp.must_be_denied('select * from public.directory_boards_due(5)');
select pg_temp.must_be_denied('select public.upsert_directory_candidates(''[]''::jsonb)');
select pg_temp.must_be_denied('select public.bump_employer_stats(gen_random_uuid(), ''[]''::jsonb)');
select pg_temp.must_be_denied('select public.upsert_employer_jobs(gen_random_uuid(), ''[]''::jsonb)');
select pg_temp.must_be_denied('select public.record_employer_sightings(gen_random_uuid(), array[''x''], array[''ashby''], 2)');
select pg_temp.must_be_denied('select public.directory_progress()');

-- 10. The measures read the directory.
do $$
declare r record;
begin
  select * into r from public.measure_t26();
  if r.sample_n is null then raise exception 'T26 reports a sample'; end if;
  select * into r from public.measure_t11();
  if r.sample_n < 1 then raise exception 'T11 counts the boards in the rotation'; end if;
end $$;

rollback;
