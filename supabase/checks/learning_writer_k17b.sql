-- Proves role_evidence (migration 20261024150000):
--   * row level security: a person reads and updates only their own rows, cannot insert or delete, and anon
--     reads nothing;
--   * a row goes with its job;
--   * prune_role_evidence() removes a row after 30 days only when the role has no reaction and no
--     application, and leaves a younger row alone.
-- One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/learning_writer_k17b.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as user_a, gen_random_uuid() as user_b, gen_random_uuid() as company_id,
       gen_random_uuid() as job_old, gen_random_uuid() as job_reacted, gen_random_uuid() as job_young, gen_random_uuid() as job_gone;
grant select on fx to authenticated;
insert into auth.users (id, email) select user_a, 'k17b-a@example.invalid' from fx union all select user_b, 'k17b-b@example.invalid' from fx;
insert into public.profiles (id, email) select user_a, 'k17b-a@example.invalid' from fx union all select user_b, 'k17b-b@example.invalid' from fx on conflict (id) do nothing;
insert into public.companies (id, user_id, name, career_url) select company_id, user_a, 'K17b Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id)
select job_old, company_id, 'old', 'd', 'https://x/b1', 'k17b-1' from fx
union all select job_reacted, company_id, 'reacted', 'd', 'https://x/b2', 'k17b-2' from fx
union all select job_young, company_id, 'young', 'd', 'https://x/b3', 'k17b-3' from fx
union all select job_gone, company_id, 'gone', 'd', 'https://x/b4', 'k17b-4' from fx;

-- A person holds a role through a person_roles row, and role_evidence is keyed to it.
insert into public.person_roles (user_id, job_id)
select user_a, job_old from fx
union all select user_a, job_reacted from fx
union all select user_a, job_young from fx
union all select user_a, job_gone from fx
union all select user_b, job_young from fx
on conflict do nothing;

insert into public.role_evidence (user_id, job_id, items, origin, material_key, computed_at)
select user_a, job_old, '[{"requirementId":"r1","verdict":"gap"}]'::jsonb, 'model', 'k1', now() - interval '31 days' from fx
union all select user_a, job_reacted, '[]'::jsonb, 'model', 'k1', now() - interval '31 days' from fx
union all select user_a, job_young, '[]'::jsonb, 'model', 'k1', now() - interval '2 days' from fx
union all select user_a, job_gone, '[]'::jsonb, 'person', 'k1', now() from fx
union all select user_b, job_young, '[]'::jsonb, 'model', 'k2', now() from fx;

insert into public.role_reactions (user_id, job_id, reaction, surface, job_title)
select user_a, job_reacted, 'interested', 'roles', 'reacted' from fx;

-- Row level security.
do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.role_evidence'::regclass), 'row level security must be on';
  assert not has_table_privilege('anon', 'public.role_evidence', 'select'), 'anon must not read';
  assert not has_table_privilege('authenticated', 'public.role_evidence', 'insert'), 'a person does not insert: the server does';
  assert not has_table_privilege('authenticated', 'public.role_evidence', 'delete'), 'a person does not delete: roles do';
  begin
    insert into public.role_evidence (user_id, job_id, items, origin, material_key) select user_a, job_old, '[]', 'bogus', 'k' from fx;
    raise exception 'an origin outside person, code and model was accepted';
  exception when check_violation or unique_violation then null;
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', (select format('{"sub":"%s","role":"authenticated"}', user_a) from fx), true);
do $$
begin
  assert (select count(*) from public.role_evidence) = 4, 'a reads only their own four rows';
  update public.role_evidence set confirmed_at = now() where origin = 'person';
  assert (select count(*) from public.role_evidence where confirmed_at is not null) = 1, 'a can confirm their own row';
end $$;
select set_config('request.jwt.claims', (select format('{"sub":"%s","role":"authenticated"}', user_b) from fx), true);
do $$
begin
  assert (select count(*) from public.role_evidence) = 1, 'b reads only their own row';
  update public.role_evidence set confirmed_at = now();
  assert (select count(*) from public.role_evidence where confirmed_at is not null) = 1, 'b updates only their own row';
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.role_evidence where confirmed_at is not null) = 2, 'one confirmation each, never across people';
end $$;

-- A row goes with its job.
delete from public.jobs where id = (select job_gone from fx);
do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.role_evidence where job_id = f.job_gone), 'deleting the role deletes its evidence';
end $$;

-- Prune: only old, and only when there is no reaction and no application.
do $$
declare f record; removed integer;
begin
  select * into f from fx;
  removed := public.prune_role_evidence();
  assert removed = 1, 'exactly the old, unclaimed row is removed, removed ' || removed;
  assert not exists (select 1 from public.role_evidence where user_id = f.user_a and job_id = f.job_old), 'the old row is gone';
  assert exists (select 1 from public.role_evidence where user_id = f.user_a and job_id = f.job_reacted), 'a role the person reacted to keeps its evidence';
  assert exists (select 1 from public.role_evidence where user_id = f.user_a and job_id = f.job_young), 'a young row stays';
  raise notice 'ALL K17B ASSERTIONS PASSED';
end $$;

rollback;
