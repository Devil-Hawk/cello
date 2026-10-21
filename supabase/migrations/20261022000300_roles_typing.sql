-- Roles PR 3: the role.type step writes the shared title cache (lib/roles/type-step.ts).
--
--   title_types.created_at     when a title first appeared, so T19 can count new titles a week
--   jobs.type_read_at          when the step read a role (each role is read once)
--   pending_title_samples      the titles still open to the step, most seen first, each with the roles to read
--   apply_model_titles         writes the step's answers to title_types and to single roles, then serves the cache
--                              to every untyped role with a typed title (new roles included)
--   measure_t19                new titles a week typed by code, by the model step, or not; untyped share of stored roles
--
-- Expand only: nothing here changes a column or a function code already calls.

alter table public.title_types add column if not exists created_at timestamptz;
update public.title_types set created_at = coalesce(typed_at, now() - interval '30 days') where created_at is null;
alter table public.title_types alter column created_at set default now();
alter table public.title_types alter column created_at set not null;

-- The titles the step reads, and the roles to read them from. A key is read when tier 1 left it pending, or when a
-- model said `none` under an older taxonomy version (a `none` expires when the version changes). Each role is read
-- once (type_read_at), a key gives at most p_per_key roles to a slice (reads since p_since count), and a title that
-- names a job gives one role, because its answer serves them all. A title in p_ambiguous names no job, so every one
-- of its roles is read for its own posting.
alter table public.jobs add column if not exists type_read_at timestamptz;

drop function if exists public.pending_title_samples(integer);
create or replace function public.pending_title_samples(
  p_limit integer default 100,
  p_version integer default 0,
  p_since timestamptz default now(),
  p_per_key integer default 5,
  p_ambiguous text[] default '{}'
)
returns table (title_norm text, dept_norm text, job_id uuid, title text, posting_head text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.title_norm, t.dept_norm, s.id, s.title, s.head
    from public.title_types t
    cross join lateral (
      select j.id, j.title, left(coalesce(j.description_md, j.description, ''), 600) as head
        from public.jobs j
       where j.title_norm = t.title_norm
         and coalesce(j.dept_norm, '') = t.dept_norm
         and j.role_type is null
         and j.type_origin is null
         and j.type_read_at is null
         and j.still_open is not false
       order by j.discovered_at desc nulls last, j.id
       limit least(
         case when t.title_norm = any (coalesce(p_ambiguous, '{}')) then greatest(p_per_key, 0) else 1 end,
         greatest(p_per_key - (select count(*) from public.jobs r
                                where r.title_norm = t.title_norm
                                  and coalesce(r.dept_norm, '') = t.dept_norm
                                  and r.type_read_at >= p_since), 0)
       )
    ) s
   where (t.status = 'pending' and t.origin = 'code')
      or (t.status = 'none' and t.origin = 'model' and t.taxonomy_version <> p_version)
   order by t.n_seen desc, t.title_norm
   limit least(greatest(p_limit, 1), 200)
$$;

-- The step's answers. Rows: title_norm, dept_norm, role_type, status, prov, taxonomy_version, and for a role that was
-- read: job_id, read_at, and when the answer leaned on its posting job_type, job_prov.
--   status typed|none   the shared cache takes the answer, for a title code left pending, or a `none` under an older version
--   status pending      the cache is left as it is (a posting-led or ambiguous title never freezes the key); the role is marked read
-- A role a model or code already typed is left as it is.
create or replace function public.apply_model_titles(p_rows jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  m integer;
begin
  insert into public.title_types (title_norm, dept_norm, role_type, origin, prov, taxonomy_version, status, n_seen, typed_at)
  select r.title_norm, r.dept_norm, r.role_type, 'model', r.prov, r.taxonomy_version, r.status, 0, case when r.status = 'typed' then now() end
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
         as r(title_norm text, dept_norm text, role_type text, prov jsonb, taxonomy_version integer, status text)
   where r.status in ('typed', 'none')
  on conflict (title_norm, dept_norm) do update
    set role_type = excluded.role_type, origin = 'model', prov = excluded.prov, taxonomy_version = excluded.taxonomy_version,
        status = excluded.status, typed_at = excluded.typed_at
    where (public.title_types.origin = 'code' and public.title_types.status = 'pending')
       or (public.title_types.origin = 'model' and public.title_types.status = 'none'
           and public.title_types.taxonomy_version <> excluded.taxonomy_version);
  get diagnostics m = row_count;
  n := n + m;

  update public.jobs j
     set type_read_at = coalesce(r.read_at, now()),
         role_type = r.job_type,
         type_origin = case when r.job_type is not null then 'model' end,
         type_prov = case when r.job_type is not null then r.job_prov else j.type_prov end
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(job_id uuid, job_type text, job_prov jsonb, read_at timestamptz)
   where j.id = r.job_id and j.role_type is null and j.type_origin is null;
  get diagnostics m = row_count;
  n := n + m;

  -- the cache serves everyone: every untyped role whose title a model typed
  update public.jobs j
     set role_type = t.role_type, type_origin = 'model', type_prov = t.prov
    from public.title_types t
   where t.origin = 'model' and t.status = 'typed' and t.role_type is not null
     and j.title_norm = t.title_norm and coalesce(j.dept_norm, '') = t.dept_norm
     and j.role_type is null and j.type_origin is null;
  get diagnostics m = row_count;
  return n + m;
end;
$$;

revoke execute on function public.pending_title_samples(integer, integer, timestamptz, integer, text[]), public.apply_model_titles(jsonb) from public, anon, authenticated;
grant execute on function public.pending_title_samples(integer, integer, timestamptz, integer, text[]), public.apply_model_titles(jsonb) to service_role;

-- T19 (reported): of the titles first seen in the last 7 days, how many code typed, how many the model step typed,
-- how many neither (the model said none, or no rule or model has read them yet); and the untyped share of stored roles.
create or replace function public.measure_t19()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer;
  untyped integer;
  by_model integer;
  new_titles integer;
  t_code integer;
  t_model integer;
  t_none integer;
begin
  select count(*), count(*) filter (where role_type is null), count(*) filter (where type_origin = 'model')
    into total, untyped, by_model from public.jobs;
  select count(*),
         count(*) filter (where origin = 'code' and status = 'typed'),
         count(*) filter (where origin = 'model' and status = 'typed'),
         count(*) filter (where status in ('none', 'pending'))
    into new_titles, t_code, t_model, t_none
    from public.title_types where created_at > now() - interval '7 days';
  return query select
    case when total > 0 then round(untyped::numeric / total, 4) end,
    null::boolean,
    total,
    format('%s of %s stored roles are untyped and %s took a model. Of %s new titles this week: %s typed by code, %s by the model step, %s not typed (model share %s).',
           untyped, total, by_model, new_titles, t_code, t_model, t_none,
           case when new_titles > 0 then round(100.0 * t_model / new_titles)::text || ' percent' else 'not known' end);
end;
$$;

revoke execute on function public.measure_t19() from public, anon, authenticated;
grant execute on function public.measure_t19() to service_role;

do $$
begin
  if exists (select 1 from public.title_types where created_at is null) then
    raise exception 'title_types.created_at must be filled';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'type_read_at') then
    raise exception 'jobs.type_read_at is missing';
  end if;
  if (select "on" from public.instance_flags where key = 'role_types_live') then
    raise exception 'role_types_live must stay off';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('apply_model_titles', 'pending_title_samples') having count(*) = 2) then
    raise exception 'the typing functions are missing';
  end if;
end $$;

notify pgrst, 'reload schema';
