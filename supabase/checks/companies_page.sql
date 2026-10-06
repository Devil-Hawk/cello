-- Proves migration 20261117500000 (the Companies page):
--   * an unverified directory row, a pending and a failed candidate, and a companies row made from email
--     (watching = false, no employer) never appear on any tab or in the counts
--   * a row's for_you equals role_counts('employer') for the caller and never counts another person's roles
--   * Hiring is ordered pinned first, then roles posted in the last 7 days, then count, then name
--   * Following lists a followed person row with no employer; pinned first, then by name
--   * the filters (role type, cannot read, pinned, past filings names) narrow the same pages
--   * a cannot-read row carries no count and no split
--   * a set of 0, 1, 50 and 51 verified rows gives 0, 1, 50 and 51 rows (the 51st is only "there is a next page")
--   * 41,000 verified rows paged A to Z by key: every row once, every page under 300 ms
--   * finish_heartbeat on directory.sweep leaves verified_total equal to the verified count
--   * anon cannot run it, an unknown tab is refused, no session is refused
-- One transaction, rolled back.
--
--   bash supabase/checks/run.sh supabase/checks/companies_page.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as a, gen_random_uuid() as b,
       gen_random_uuid() as e1, gen_random_uuid() as e2, gen_random_uuid() as e3, gen_random_uuid() as e4, gen_random_uuid() as u1,
       gen_random_uuid() as ca2, gen_random_uuid() as ca3, gen_random_uuid() as ca_solo, gen_random_uuid() as ca_mail;
grant select on fx to public;

insert into auth.users (id, email) select a, 'cp-a@example.invalid' from fx union all select b, 'cp-b@example.invalid' from fx;
insert into public.profiles (id, email) select a, 'cp-a@example.invalid' from fx on conflict (id) do nothing;
insert into public.profiles (id, email) select b, 'cp-b@example.invalid' from fx on conflict (id) do nothing;

-- Four verified employers and one that never passed the verifier.
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, verified_by, verified_at, source, open_count)
select e1, 'Alpha Works', public.company_name_norm('Alpha Works'), 'alpha-works.example', 'greenhouse', 'alphaworks', 'careers_link', now(), 'person', 40 from fx
union all select e2, 'Beta Works', public.company_name_norm('Beta Works'), 'beta-works.example', 'greenhouse', 'betaworks', 'careers_link', now(), 'person', 12 from fx
union all select e3, 'Gamma Works', public.company_name_norm('Gamma Works'), 'gamma-works.example', 'greenhouse', 'gammaworks', 'careers_link', now(), 'person', 7 from fx
union all select e4, 'Delta Works', public.company_name_norm('Delta Works'), 'delta-works.example', 'greenhouse', 'deltaworks', 'careers_link', now(), 'person', 90 from fx;
insert into public.company_directory (id, name, name_norm, domain, ats_provider, ats_token, source)
select u1, 'Unverified Works', public.company_name_norm('Unverified Works'), 'unverified-works.example', 'greenhouse', 'unverifiedworks', 'seed' from fx;

-- A pending and a failed candidate: never listed, never counted.
insert into public.directory_candidates (name, name_norm, domain, source, state, fail_reason)
values ('Pending Works', 'pending works', 'pending-works.example', 'yc', 'pending', null),
       ('Failed Works', 'failed works', 'failed-works.example', 'yc', 'failed', 'no_board');

-- Roles of A: Alpha 3 (one posted 2 days ago), Beta 3 (all 30 days old), Gamma 1 (yesterday), Delta 2 (3 and 5 days ago),
-- and one at the unverified employer. B has 2 at Alpha.
insert into public.jobs (company_id, employer_id, posting_key, title, description, url, external_id, posted_at, role_type, discovered_at)
select null::uuid, e1, 'a-' || g, 'Alpha role ' || g, 'd', 'https://alpha-works.example/jobs/' || g, 'a-' || g, case when g = 1 then now() - interval '2 days' else now() - interval '30 days' end, 'ai-engineer', now() from fx, generate_series(1, 3) g
union all select null, e2, 'b-' || g, 'Beta role ' || g, 'd', 'https://beta-works.example/jobs/' || g, 'b-' || g, now() - interval '30 days', 'ml-engineer', now() from fx, generate_series(1, 3) g
union all select null, e3, 'g-1', 'Gamma role 1', 'd', 'https://gamma-works.example/jobs/1', 'g-1', now() - interval '1 day', 'ai-engineer', now() from fx
union all select null, e4, 'd-1', 'Delta role 1', 'd', 'https://delta-works.example/jobs/1', 'd-1', now() - interval '3 days', 'ai-engineer', now() from fx
union all select null, e4, 'd-2', 'Delta role 2', 'd', 'https://delta-works.example/jobs/2', 'd-2', now() - interval '5 days', 'ai-engineer', now() from fx
union all select null, u1, 'u-1', 'Unverified role', 'd', 'https://unverified-works.example/jobs/1', 'u-1', now(), 'ai-engineer', now() from fx
union all select null, e1, 'x-' || g, 'Alpha B role ' || g, 'd', 'https://alpha-works.example/jobs/b' || g, 'x-' || g, now(), 'ai-engineer', now() from fx, generate_series(1, 2) g;
insert into public.person_roles (user_id, job_id)
select (select a from fx), id from public.jobs where external_id ~ '^(a|b|g|d|u)-[0-9]+$' and employer_id in (select e1 from fx union select e2 from fx union select e3 from fx union select e4 from fx union select u1 from fx);
insert into public.person_roles (user_id, job_id)
select (select b from fx), id from public.jobs where external_id like 'x-%';

-- A follows Beta and Gamma (Gamma pinned) and one employer Cello has no row for; a company made from email is not followed.
insert into public.companies (id, user_id, name, domain, career_url, employer_id, watching, is_dream_company, metadata)
select ca2, a, 'Beta Works', 'beta-works.example', 'https://beta-works.example/careers', e2, true, false, '{}'::jsonb from fx
union all select ca3, a, 'Gamma Works', 'gamma-works.example', 'https://gamma-works.example/careers', e3, true, true, '{}'::jsonb from fx
union all select ca_solo, a, 'Solo Person', null, '', null, true, false, '{}'::jsonb from fx
union all select ca_mail, a, 'Mail Only', null, '', null, false, false, '{}'::jsonb from fx;

-- 1. Hiring, as A: four employers in order, none unverified.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
create temp table hiring_a as select row_number() over () as pos, * from public.companies_page('hiring');
create temp table following_a as select row_number() over () as pos, * from public.companies_page('following');
create temp table all_a as select * from public.companies_page('all') where name_norm like '%works';
create temp table counts_a as select * from public.companies_tab_counts();
create temp table roles_a as select * from public.role_counts('employer');
create temp table hiring_type as select * from public.companies_page('hiring', null, 50, 'ml-engineer');
create temp table hiring_pinned as select * from public.companies_page('hiring', null, 50, null, false, true);
create temp table all_names as select * from public.companies_page('all', null, 50, null, false, false, array['alpha works']);
reset role;
grant select on hiring_a, following_a, all_a, counts_a, roles_a, hiring_type, hiring_pinned, all_names to public;

select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', b)::text, true) from fx;
set local role authenticated;
create temp table hiring_b as select * from public.companies_page('hiring');
create temp table following_b as select * from public.companies_page('following');
create temp table counts_b as select * from public.companies_tab_counts();
reset role;

do $$
declare f record; order_ids uuid[];
begin
  select * into f from fx;
  raise notice 'hiring_a: %', (select jsonb_agg(to_jsonb(h) - 'k' - 'logo_url' - 'careers_url' order by pos) from hiring_a h);
  raise notice 'own: %', (select jsonb_agg(to_jsonb(c) - 'metadata') from public.companies c where c.user_id = f.a);

  -- Pinned and followed first (Gamma), then roles posted in 7 days (Delta 2, Alpha 1, Beta 0).
  select array_agg(id order by pos) into order_ids from hiring_a;
  if order_ids is distinct from array[f.e3, f.e4, f.e1, f.e2] then
    raise exception 'hiring should be gamma, delta, alpha, beta, got %', (select array_agg(name order by pos) from hiring_a);
  end if;
  if exists (select 1 from hiring_a where id = f.u1 or name in ('Unverified Works', 'Pending Works', 'Failed Works', 'Mail Only')) then
    raise exception 'an unverified employer, a candidate or a mail row is on Hiring';
  end if;

  -- The count on a row is what role_counts says for that employer, for A alone.
  if exists (select 1 from hiring_a h left join roles_a r on r.key = h.id::text where h.for_you is distinct from coalesce(r.n, 0)) then
    raise exception 'for_you differs from role_counts: %', (select jsonb_agg(to_jsonb(h)) from hiring_a h);
  end if;
  if (select for_you from hiring_a where id = f.e1) <> 3 then raise exception 'alpha has 3 for A, never B''s 2'; end if;
  if (select for_you from hiring_b where id = f.e1) <> 2 then raise exception 'alpha has 2 for B'; end if;
  if (select count(*) from hiring_b) <> 1 then raise exception 'B sees only the employer with a role for B'; end if;
  if (select by_type from hiring_a where id = f.e4) is distinct from '{"ai-engineer": 2}'::jsonb then raise exception 'delta splits as ai-engineer 2'; end if;
  if (select recent from hiring_a where id = f.e4) <> 2 or (select recent from hiring_a where id = f.e2) <> 0 then raise exception 'recent counts the last 7 days'; end if;
  if not (select following from hiring_a where id = f.e2) or (select following from hiring_a where id = f.e1) then raise exception 'following flags are the caller''s own'; end if;
  if not (select pinned from hiring_a where id = f.e3) or (select pinned from hiring_a where id = f.e2) then raise exception 'pinned is the caller''s own'; end if;

  -- Following: Gamma pinned, then Beta, then the person row with no employer; the mail row is not in it.
  select array_agg(coalesce(company_id, id) order by pos) into order_ids from following_a;
  if order_ids is distinct from array[f.ca3, f.ca2, f.ca_solo] then raise exception 'following should be gamma, beta, solo, got %', (select array_agg(name order by pos) from following_a); end if;
  if exists (select 1 from following_a where name = 'Mail Only') then raise exception 'a company made from email is on Following'; end if;
  if (select count(*) from following_b) <> 0 then raise exception 'B follows nobody'; end if;

  -- All lists the four verified employers A to Z and never the unverified one or a candidate.
  if (select array_agg(id order by name_norm) from all_a) is distinct from array[f.e1, f.e2, f.e4, f.e3] then
    raise exception 'all should be alpha, beta, delta, gamma, got %', (select array_agg(name order by name_norm) from all_a);
  end if;
  if (select for_you from all_a where id = f.e3) <> 1 or (select for_you from all_a where id = f.e2) <> 3 then raise exception 'all carries the caller''s counts'; end if;

  -- Counts from the same predicates.
  if (select hiring from counts_a) <> 4 or (select following from counts_a) <> 3 or (select pinned from counts_a) <> 1 then
    raise exception 'tab counts for A should be 4, 3 and 1, got %', (select to_jsonb(c) from counts_a c);
  end if;
  if (select hiring from counts_b) <> 1 or (select following from counts_b) <> 0 then raise exception 'tab counts for B should be 1 and 0'; end if;

  -- Filters narrow the same pages.
  if (select array_agg(id) from hiring_type) is distinct from array[f.e2] then raise exception 'role type ml-engineer is Beta only'; end if;
  if (select array_agg(id) from hiring_pinned) is distinct from array[f.e3] then raise exception 'pinned only is Gamma'; end if;
  if (select array_agg(id) from all_names) is distinct from array[f.e1] then raise exception 'the filings names keep Alpha only'; end if;
end $$;

-- 2. A cannot-read employer carries its reason and no count and no split.
update public.company_directory set cannot_read_reason = 'no_board' where id = (select e2 from fx);
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
create temp table cannot_a as select * from public.companies_page('hiring', null, 50, null, true);
reset role;
grant select on cannot_a to public;
do $$
declare f record;
begin
  select * into f from fx;
  if (select count(*) from cannot_a) <> 1 or (select id from cannot_a) <> f.e2 then raise exception 'cannot read keeps Beta only'; end if;
  if (select cannot_read_reason from cannot_a) <> 'no_board' then raise exception 'its reason comes with it'; end if;
  if (select for_you from cannot_a) is not null or (select by_type from cannot_a) is not null or (select recent from cannot_a) is not null then
    raise exception 'a cannot-read row never carries a count';
  end if;
end $$;
update public.company_directory set cannot_read_reason = null where id = (select e2 from fx);

-- 3. Sets of 0, 1, 50 and 51 verified rows: the page returns 0, 1, 50 and 51 (the 51st only says there is a next page),
--    and the next page starts after the 50th row's key.
create or replace function pg_temp.fill(n integer) returns void language plpgsql as $$
begin
  delete from public.company_directory where name_norm like 'zzpage %';
  insert into public.company_directory (name, name_norm, ats_provider, ats_token, verified_by, verified_at, source)
  select 'Zzpage ' || lpad(g::text, 3, '0'), 'zzpage ' || lpad(g::text, 3, '0'), 'greenhouse', 'zzpage' || g, 'careers_link', now(), 'person' from generate_series(1, n) g;
end $$;

do $$
declare n integer; got integer; c jsonb; nxt integer;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', (select a from fx))::text, true);
  foreach n in array array[0, 1, 50, 51] loop
    perform pg_temp.fill(n);
    select count(*) into got from public.companies_page('all', jsonb_build_array('zzpage', '00000000-0000-0000-0000-000000000000'), 51);
    if got <> n then raise exception 'a set of % rows came back as %', n, got; end if;
  end loop;
  -- 51 rows: the first page keeps 50 and its last key opens a page of exactly one.
  select k into c from public.companies_page('all', jsonb_build_array('zzpage', '00000000-0000-0000-0000-000000000000'), 51) offset 49 limit 1;
  select count(*) into nxt from public.companies_page('all', c, 51);
  if nxt <> 1 then raise exception 'the page after the 50th key should hold 1 row, held %', nxt; end if;
end $$;
delete from public.company_directory where name_norm like 'zzpage %';

-- 4. 41,000 verified rows, paged A to Z by key: every row once, every page under 300 ms.
insert into public.company_directory (name, name_norm, ats_provider, ats_token, verified_by, verified_at, source)
select 'Zzbulk ' || lpad(g::text, 6, '0'), 'zzbulk ' || lpad(g::text, 6, '0'), 'greenhouse', 'zzbulk' || g, 'careers_link', now(), 'person' from generate_series(1, 41000) g;
analyze public.company_directory;

do $$
declare c jsonb := jsonb_build_array('zzbulk', '00000000-0000-0000-0000-000000000000'); r record; i integer; seen integer := 0; pages integer := 0; t0 timestamptz; slowest numeric := 0; ms numeric;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', (select a from fx))::text, true);
  loop
    i := 0;
    t0 := clock_timestamp();
    for r in select * from public.companies_page('all', c, 51) loop
      i := i + 1;
      if i = 50 then c := r.k; end if;
      if i <= 50 then seen := seen + 1; end if;
    end loop;
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    if ms > slowest then slowest := ms; end if;
    pages := pages + 1;
    if ms > 300 then raise exception 'page % took % ms', pages, round(ms); end if;
    exit when i < 51;
  end loop;
  if seen <> 41000 then raise exception 'paged % rows of 41000', seen; end if;
  raise notice 'paged 41000 rows in % pages, slowest % ms', pages, round(slowest);
end $$;
delete from public.company_directory where name_norm like 'zzbulk %';

-- 5. The sweep's heartbeat carries the verified total, from a count taken when the slice succeeds.
select public.finish_heartbeat('directory.sweep', null, true, '{"boards": 3}'::jsonb, null, 10, null);
do $$
declare want bigint; got jsonb;
begin
  select count(*) into want from public.company_directory where verified_at is not null;
  select found into got from public.job_heartbeats where job = 'directory.sweep' and user_id is null;
  if (got ->> 'verified_total')::bigint is distinct from want then raise exception 'verified_total % should be %', got, want; end if;
  if (got ->> 'pending_total')::bigint is distinct from (select count(*) from public.directory_candidates where state = 'pending') then raise exception 'pending_total is the pending count'; end if;
  if (got ->> 'boards')::int <> 3 then raise exception 'the slice''s own numbers stay'; end if;
end $$;
-- A failed slice keeps the last success and its total.
select public.finish_heartbeat('directory.sweep', null, false, '{}'::jsonb, 'failed', 10, null);
do $$
begin
  if (select (found ->> 'verified_total') from public.job_heartbeats where job = 'directory.sweep' and user_id is null) is null then raise exception 'a failed slice keeps the last total'; end if;
end $$;

-- A person can read it (the instance's rows are readable), and nobody else's heartbeat is mixed in.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
do $$
begin
  if (select found ->> 'verified_total' from public.job_heartbeats where job = 'directory.sweep' and user_id is null) is null then
    raise exception 'a signed-in person reads the sweep total';
  end if;
end $$;
reset role;

-- 6. Who may run it.
set local role anon;
do $$
begin
  begin
    perform * from public.companies_page('all');
    raise exception 'anon ran companies_page';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.companies_tab_counts();
    raise exception 'anon ran companies_tab_counts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a)::text, true) from fx;
set local role authenticated;
do $$
begin
  begin
    perform * from public.companies_page('everyone');
    raise exception 'an unknown tab was answered';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform * from public.companies_mine();
    raise exception 'authenticated ran an internal helper';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '', true);
set local role authenticated;
do $$
begin
  begin
    perform * from public.companies_page('all');
    raise exception 'a call with no session was answered';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
