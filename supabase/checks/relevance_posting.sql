-- K5d: the posting as the employer wrote it (migration 20261008058000).
--
-- Proves: description_md5 is a plain column holding the md5 of description_md, and no row with a body has a
-- hash that differs; a shared role written twice keeps its body when the second read found none, and takes a
-- changed body whole; the backfill gives roles nobody will re-read their plain copy (partial at the 20,000
-- cap), leaves followed employers' roles to the reader and makes those employers due at once; the storage
-- alert clears only the bodies of roles nobody saved or applied to and keeps the hash; T21 reads the sample.
-- Everything rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/relevance_posting.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b, gen_random_uuid() as emp, gen_random_uuid() as emp2,
       gen_random_uuid() as co_a, gen_random_uuid() as co_b, gen_random_uuid() as co_dir,
       gen_random_uuid() as j_follow, gen_random_uuid() as j_dir, gen_random_uuid() as j_cap, gen_random_uuid() as j_saved,
       gen_random_uuid() as j_applied, gen_random_uuid() as j_plain;
grant select on fx to public;

insert into auth.users (id, email) select a, 'post-a@example.invalid' from fx union all select b, 'post-b@example.invalid' from fx;

insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source)
select emp, 'Posting Co', 'posting co', 'posting.example', 'greenhouse', 'postingco', 'careers_link', now(), 'person' from fx
union all select emp2, 'Nobody Follows', 'nobody follows', 'nobody2.example', 'greenhouse', 'nobodyfollows2', 'careers_link', now(), 'seed' from fx;
insert into public.companies (id, user_id, name, domain, career_url, metadata, last_scraped_at)
select co_a, a, 'Posting Co', 'posting.example', 'https://posting.example/careers', '{}'::jsonb, now() from fx
union all select co_b, b, 'Posting Co', 'posting.example', 'https://posting.example/careers', '{}'::jsonb, now() from fx;

-- 1. The hash is a plain column.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'description_md5' and is_generated = 'ALWAYS') then
    raise exception 'description_md5 must be a plain column';
  end if;
end $$;

-- 2. A shared role written with its body, then again without one, then with a changed one.
do $$
declare f record; row_a jsonb; later jsonb;
begin
  select * into f from fx;
  row_a := jsonb_build_array(jsonb_build_object(
    'company_id', f.co_a, 'employer_id', f.emp, 'external_id', 'p-1', 'title', 'Backend Engineer', 'description', 'plain copy', 'url', 'https://posting.example/jobs/1',
    'source', 'greenhouse', 'last_seen_at', now(), 'description_md', E'## About\n\nWhole body.', 'description_state', 'full',
    'description_source', 'api', 'apply_url', 'https://apply.example/1', 'description_md5', md5(E'## About\n\nWhole body.')));
  perform public.upsert_shared_jobs(row_a);
  if (select description_md from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> E'## About\n\nWhole body.' then raise exception 'the body is stored whole'; end if;
  if (select description_md5 from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> md5(E'## About\n\nWhole body.') then raise exception 'the hash is the md5 of the Markdown'; end if;

  -- a read that found no body (a provider that did not send one this time) leaves the stored body alone
  later := jsonb_build_array(jsonb_build_object('company_id', f.co_b, 'employer_id', f.emp, 'external_id', 'p-1', 'title', 'Backend Engineer', 'description', '', 'url', 'https://posting.example/jobs/1', 'source', 'greenhouse', 'last_seen_at', now()));
  perform public.upsert_shared_jobs(later);
  if (select description_state from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> 'full' or (select description_md from public.jobs where employer_id = f.emp and posting_key = 'p-1') is null then
    raise exception 'a read with no body must not blank the stored one';
  end if;
  if (select apply_url from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> 'https://apply.example/1' then raise exception 'the apply link stays'; end if;

  -- a changed body replaces it, with its hash
  later := jsonb_build_array(jsonb_build_object('company_id', f.co_b, 'employer_id', f.emp, 'external_id', 'p-1', 'title', 'Backend Engineer', 'description', 'plain copy', 'url', 'https://posting.example/jobs/1', 'source', 'greenhouse', 'last_seen_at', now(),
    'description_md', E'## About\n\nWhole body.\n\n## Requirements\n\n- Go', 'description_state', 'full', 'description_source', 'api', 'description_md5', md5(E'## About\n\nWhole body.\n\n## Requirements\n\n- Go')));
  perform public.upsert_shared_jobs(later);
  if (select description_md5 from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> md5(E'## About\n\nWhole body.\n\n## Requirements\n\n- Go') then raise exception 'a changed body takes its hash'; end if;
  if (select count(*) from public.jobs where employer_id = f.emp and posting_key = 'p-1') <> 1 then raise exception 'still one row for the posting'; end if;
end $$;

-- 3. The backfill.
do $$
declare f record; r jsonb;
begin
  select * into f from fx;
  -- a role at an employer nobody follows, one at the cap, one that a follower's reader will re-read
  insert into public.jobs (id, company_id, employer_id, title, description, url, external_id, last_seen_at)
  values (f.j_dir, null, f.emp2, 'Directory role', 'The plain copy of a directory role.', 'https://nobody2.example/jobs/1', 'd-1', now()),
         (f.j_cap, null, f.emp2, 'Capped role', repeat('x', 20000), 'https://nobody2.example/jobs/2', 'd-2', now()),
         (f.j_follow, f.co_a, f.emp, 'Followed role', 'Followed plain copy.', 'https://posting.example/jobs/9', 'f-9', now());
  r := public.backfill_posting_bodies(100);
  if (select description_state from public.jobs where id = f.j_dir) <> 'full' or (select description_source from public.jobs where id = f.j_dir) <> 'listing' then raise exception 'a directory role takes its plain copy'; end if;
  if (select description_md5 from public.jobs where id = f.j_dir) <> md5('The plain copy of a directory role.') then raise exception 'its hash is the md5 of what is stored'; end if;
  if (select description_state from public.jobs where id = f.j_cap) <> 'partial' then raise exception 'a body at the 20,000 cap is partial'; end if;
  if (select description_state from public.jobs where id = f.j_follow) is not null then raise exception 'a followed employer''s role is left to the reader'; end if;
  if (select last_scraped_at from public.companies where id = f.co_a) is not null then raise exception 'the followed employer is due at once'; end if;
  if (select next_due_at from public.routines where command = 'roles.check' and user_id = f.a) > now() + interval '1 minute' then raise exception 'that person''s check is due now'; end if;
  if (r ->> 'filled')::int < 2 then raise exception 'two roles were filled, got %', r; end if;
end $$;

-- 4. No row with a body has a hash that differs.
do $$
begin
  if exists (select 1 from public.jobs where description_md is not null and description_md5 is distinct from md5(description_md)) then
    raise exception 'a role has a body whose hash is not the md5 of it';
  end if;
end $$;

-- 5. The storage alert clears only what nobody saved or applied to, and keeps the hash.
do $$
declare f record; n integer; keep_hash text;
begin
  select * into f from fx;
  insert into public.jobs (id, company_id, employer_id, title, description, url, external_id, description_md, description_state, description_md5)
  values (f.j_saved, f.co_a, f.emp, 'Saved role', 'd', 'https://posting.example/jobs/s', 's-1', 'Saved body', 'full', md5('Saved body')),
         (f.j_applied, f.co_a, f.emp, 'Applied role', 'd', 'https://posting.example/jobs/a', 'a-1', 'Applied body', 'full', md5('Applied body')),
         (f.j_plain, f.co_a, f.emp, 'Plain role', 'd', 'https://posting.example/jobs/p', 'p-2', 'Untouched body', 'full', md5('Untouched body'));
  update public.person_roles set saved_at = now() where user_id = f.a and job_id = f.j_saved;
  insert into public.applications (user_id, job_id) values (f.a, f.j_applied);
  keep_hash := md5('Untouched body');
  n := public.clear_untouched_posting_bodies(1000);
  if (select description_md from public.jobs where id = f.j_saved) is null or (select description_md from public.jobs where id = f.j_applied) is null then raise exception 'a saved or applied role keeps its body'; end if;
  if (select description_md from public.jobs where id = f.j_plain) is not null or (select description_state from public.jobs where id = f.j_plain) <> 'cleared' then raise exception 'an untouched role''s body is cleared'; end if;
  if (select description_md5 from public.jobs where id = f.j_plain) <> keep_hash then raise exception 'the hash stays when a body is cleared'; end if;
  if n < 1 then raise exception 'at least one body was cleared'; end if;
end $$;

-- 6. T21 reads the weekly sample.
do $$
declare t record; i integer;
begin
  select * into t from public.measure_t21();
  if t.passed is not null then raise exception 'T21 has no verdict without a sample'; end if;
  for i in 1 .. 50 loop insert into public.posting_samples (job_id, md_ok) values (null, true); end loop;
  select * into t from public.measure_t21();
  if t.passed is not true or t.sample_n <> 50 then raise exception 'a full sample passes, got % %', t.passed, t.sample_n; end if;
  update public.posting_samples set md_ok = false where id in (select id from public.posting_samples order by id limit 5);
  select * into t from public.measure_t21();
  if t.value <> 0.9 or t.passed is not false then raise exception 'a sample under 0.95 fails, got % %', t.value, t.passed; end if;
  update public.posting_samples set md_ok = true, silent_truncation = true where id = (select min(id) from public.posting_samples);
  select * into t from public.measure_t21();
  if t.passed is not false then raise exception 'a silent truncation fails whatever the share'; end if;
end $$;

-- No client role runs the backfill or the clearing.
create function pg_temp.must_be_denied(r text, q text) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  begin
    execute q;
  exception when insufficient_privilege then
    reset role;
    return;
  end;
  reset role;
  raise exception 'expected 42501 for role %, but it ran: %', r, q;
end $$;
select pg_temp.must_be_denied('authenticated', 'select public.backfill_posting_bodies(10)');
select pg_temp.must_be_denied('authenticated', 'select public.clear_untouched_posting_bodies(10)');
select pg_temp.must_be_denied('authenticated', 'select 1 from public.posting_samples');
select pg_temp.must_be_denied('anon', 'select public.measure_t21()');

rollback;
