-- Proves migration 20261011000000: origin, prov and confirmed_at on person_roles,
-- jobs, artifacts and artifact_versions, the origin check, and the artifact_versions
-- backfill from author. Applied twice inside the transaction; everything rolls back.
--
-- person_roles, artifacts and artifact_versions come with later packages. Until
-- they are on this branch the check builds bare ones, so the columns, the check and
-- the backfill are proven on every table; once the real tables exist it only asserts
-- the columns on them.
--
--   nice -n 19 ionice -c3 bash supabase/checks/run.sh supabase/checks/registry_provenance.sql

begin;

do $$
begin
  if to_regclass('public.person_roles') is null then
    create table public.person_roles (id uuid primary key default gen_random_uuid(), title text);
    perform set_config('cello.check_made_person_roles', 'on', true);
  end if;
  if to_regclass('public.artifacts') is null then
    create table public.artifacts (id uuid primary key default gen_random_uuid(), kind text);
    perform set_config('cello.check_made_artifacts', 'on', true);
  end if;
  if to_regclass('public.artifact_versions') is null then
    create table public.artifact_versions (id uuid primary key default gen_random_uuid(), author text not null);
    insert into public.artifact_versions (author) values ('user'), ('cello'), ('user');
    perform set_config('cello.check_made_artifact_versions', 'on', true);
  end if;
end $$;

\ir ../migrations/20261011000000_provenance.sql
\ir ../migrations/20261011000000_provenance.sql

do $$
declare t text; n integer;
begin
  foreach t in array array['person_roles', 'jobs', 'artifacts', 'artifact_versions'] loop
    select count(*) into n from information_schema.columns
    where table_schema = 'public' and table_name = t and column_name in ('origin', 'prov', 'confirmed_at');
    assert n = 3, format('public.%s must carry origin, prov and confirmed_at', t);

    -- The default keeps a writer that has never heard of the column working.
    assert (select column_default from information_schema.columns
            where table_schema = 'public' and table_name = t and column_name = 'origin') like '''code''%',
      format('public.%s.origin must default to code', t);
  end loop;
end $$;

-- 'robot' is not an origin.
do $$
begin
  begin
    update public.jobs set origin = 'robot' where id = (select id from public.jobs limit 1);
    if exists (select 1 from public.jobs limit 1) then
      raise exception 'origin robot must be refused on jobs';
    end if;
  exception when check_violation then
    null;
  end;
  begin
    insert into public.person_roles (title, origin) values ('x', 'robot');
    raise exception 'origin robot must be refused on person_roles';
  exception when check_violation or not_null_violation or undefined_column then
    null;
  end;
end $$;

-- artifact_versions: author maps to origin and prov.
do $$
begin
  if coalesce(current_setting('cello.check_made_artifact_versions', true), '') = 'on' then
    assert (select count(*) from public.artifact_versions where origin = 'person' and prov ->> 'door' = 'session') = 2,
      'author user must become origin person with door session';
    assert (select count(*) from public.artifact_versions where origin = 'model' and prov ->> 'step' = 'unrecorded') = 1,
      'author cello must become origin model with step unrecorded';
  end if;
end $$;

-- confirmed_at keeps origin model.
do $$
begin
  if coalesce(current_setting('cello.check_made_person_roles', true), '') = 'on' then
    insert into public.person_roles (title, origin, prov) values ('x', 'model', '{"step":"chance"}'::jsonb);
    update public.person_roles set confirmed_at = now() where title = 'x';
    assert (select origin from public.person_roles where title = 'x') = 'model', 'a confirmed value keeps origin model';
  end if;
end $$;

rollback;
