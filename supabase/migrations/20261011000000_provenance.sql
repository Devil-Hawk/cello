-- Provenance on the tables that hold model-touched values (blueprint 3.2).
--
-- WHY
--   A value Cello shows must say where it came from: the person, plain code, or a
--   model step. A stored model value without that record cannot be told from a
--   fact, and a gate such as "use only what the person wrote" has nothing to read.
--
-- WHAT
--   Three columns on each table that exists today and holds model-touched values:
--     origin        'person' | 'code' | 'model', default 'code' so every writer that
--                   does not know about the column keeps working
--     prov          for a model: {step, model, rung, evidence, at}; for code:
--                   {rule}; for the person: {door}
--     confirmed_at  set when the person accepts a model value; the value keeps
--                   origin 'model'
--   Tables: person_roles, jobs, artifacts and artifact_versions, each only where it
--   exists. A table another package creates later carries the three columns in its
--   own create statement.
--   artifact_versions.origin is mapped from author: 'user' is the person (door
--   session), 'cello' is a model whose step was not recorded.
--
-- Additive, idempotent, no table rewrite: adding a column with a constant default
-- is a catalog change.

do $$
declare
  t text;
begin
  foreach t in array array['person_roles', 'jobs', 'artifacts', 'artifact_versions'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I add column if not exists origin text not null default %L', t, 'code');
    execute format('alter table public.%I add column if not exists prov jsonb', t);
    execute format('alter table public.%I add column if not exists confirmed_at timestamptz', t);
    if not exists (
      select 1 from pg_constraint
      where conname = t || '_origin_check' and conrelid = ('public.' || t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (origin in (%L, %L, %L))',
        t, t || '_origin_check', 'person', 'code', 'model'
      );
    end if;
  end loop;
end
$$;

-- artifact_versions: say who wrote each existing version.
do $$
begin
  if to_regclass('public.artifact_versions') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'artifact_versions' and column_name = 'author'
     ) then
    update public.artifact_versions
    set origin = 'person', prov = jsonb_build_object('door', 'session')
    where author = 'user' and prov is null and origin = 'code';
    update public.artifact_versions
    set origin = 'model', prov = jsonb_build_object('step', 'unrecorded')
    where author = 'cello' and prov is null and origin = 'code';
  end if;
end
$$;

-- POSTCONDITION: every table that exists carries the three columns and the check.
do $$
declare
  t text;
begin
  foreach t in array array['person_roles', 'jobs', 'artifacts', 'artifact_versions'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = t and column_name in ('origin', 'prov', 'confirmed_at')) <> 3 then
      raise exception 'public.% is missing a provenance column', t;
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = t || '_origin_check' and conrelid = ('public.' || t)::regclass
    ) then
      raise exception 'public.% is missing its origin check', t;
    end if;
  end loop;
end
$$;
