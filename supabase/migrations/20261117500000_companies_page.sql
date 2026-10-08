-- PG11 Companies (blueprint 4.7a): one keyset page of the directory per tab, the tab counts, and the sweep's
-- verified total on its heartbeat.
--
--   companies_page(tab, after, ...)  the verified directory as the caller sees it. Tabs: hiring (an employer with a
--                                    role kept for the caller), following (the caller's own followed rows) and all
--                                    (every verified employer, A to Z). 50 rows a page by key, never by offset: the
--                                    page asks for 51 to know there is a next, and each row carries its own key `k`.
--   companies_tab_counts()           the number each tab label shows, from the same predicates.
--   job_heartbeats trigger           adds verified_total and pending_total to the directory.sweep heartbeat when a slice
--                                    succeeds, so the All count is one stored number, never a count on each page load.
--
-- Nothing here writes a person's row. A row made from email (companies with watching = false and no employer), a
-- directory row that is not verified and a candidate never appear in any tab or count.

do $$
begin
  if to_regclass('public.company_directory') is null or to_regclass('public.directory_candidates') is null then
    raise exception 'companies_page needs K5a and K6 (company_directory, directory_candidates)';
  end if;
  if to_regclass('public.employer_stats') is null or to_regclass('public.job_heartbeats') is null then
    raise exception 'companies_page needs K5c and K4 (employer_stats, job_heartbeats)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'person_roles' and column_name = 'role_type') then
    raise exception 'companies_page needs K5c (person_roles.role_type)';
  end if;
  if to_regprocedure('public.company_name_norm(text)') is null then
    raise exception 'companies_page needs K6 (company_name_norm)';
  end if;
end $$;

-- All, A to Z by key.
create index if not exists company_directory_az_idx on public.company_directory (name_norm, id) where verified_at is not null;

-- The caller's open roles by employer (the same predicate as role_counts('employer')): the count, the count posted in
-- the last 7 days, the split by the type the person sees, and the types themselves.
create or replace function public.companies_mine()
returns table (eid uuid, n integer, recent integer, by_type jsonb, types text[])
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with t as (
    select coalesce(j.employer_id, j.company_id) as eid,
           coalesce(pr.role_type, j.role_type) as ty,
           count(*)::int as n,
           (count(*) filter (where j.posted_at >= now() - interval '7 days'))::int as recent
      from public.person_roles pr
      join public.jobs j on j.id = pr.job_id
     where pr.user_id = (select auth.uid())
       and pr.hidden_reason is null
       and (j.posted_at is null or j.posted_at >= now() - interval '180 days')
       and j.still_open is not false
       and coalesce(j.employer_id, j.company_id) is not null
     group by 1, 2
  )
  select t.eid,
         sum(t.n)::int,
         sum(t.recent)::int,
         coalesce(jsonb_object_agg(t.ty, t.n) filter (where t.ty is not null), '{}'::jsonb),
         coalesce(array_agg(t.ty) filter (where t.ty is not null), '{}'::text[])
    from t
   group by t.eid
$$;

-- The caller's own companies rows.
create or replace function public.companies_own()
returns table (id uuid, employer_id uuid, name text, domain text, logo_url text, career_url text, watching boolean, pinned boolean)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select c.id, c.employer_id, c.name, c.domain, c.logo_url, nullif(c.career_url, ''), c.watching, c.is_dream_company
    from public.companies c
   where c.user_id = (select auth.uid())
$$;

revoke execute on function public.companies_mine(), public.companies_own() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The page
-- ---------------------------------------------------------------------------

create or replace function public.companies_page(
  p_tab text,
  p_after jsonb default null,
  p_limit integer default 50,
  p_role_type text default null,
  p_cannot_read boolean default false,
  p_pinned boolean default false,
  p_names text[] default null
)
returns table (
  id uuid,
  company_id uuid,
  name text,
  name_norm text,
  domain text,
  logo_url text,
  careers_url text,
  open_count integer,
  last_read_at timestamptz,
  read_tier text,
  cannot_read_reason text,
  following boolean,
  pinned boolean,
  for_you integer,
  recent integer,
  by_type jsonb,
  k jsonb
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 51);
  a1 integer;
  a2 integer;
  a3 integer;
  an text;
  ai uuid;
begin
  if uid is null then
    raise exception 'sign in to see companies' using errcode = '42501';
  end if;
  if p_tab not in ('hiring', 'following', 'all') then
    raise exception 'companies_page: unknown tab %', p_tab using errcode = '22023';
  end if;
  -- A key is the row's own `k`: all is (name, id); the others are (pinned first, newest, most roles, name, id).
  if p_after is not null then
    if p_tab = 'all' then
      an := p_after ->> 0;
      ai := (p_after ->> 1)::uuid;
    else
      a1 := (p_after ->> 0)::integer;
      a2 := (p_after ->> 1)::integer;
      a3 := (p_after ->> 2)::integer;
      an := p_after ->> 3;
      ai := (p_after ->> 4)::uuid;
    end if;
  end if;

  if p_tab = 'all' then
    return query
    with m as (select * from public.companies_mine()),
    page as (
      select d.*
        from public.company_directory d
       where d.verified_at is not null
         and (p_after is null or (d.name_norm, d.id) > (an, ai))
         and (not p_cannot_read or d.cannot_read_reason is not null)
         and (p_names is null
              or d.name_norm = any (p_names)
              or (length(split_part(d.name_norm, ' ', 1)) >= 3 and split_part(d.name_norm, ' ', 1) = any (p_names)))
         and (p_role_type is null
              or exists (select 1 from m where m.eid = d.id and p_role_type = any (m.types))
              or exists (select 1 from public.employer_stats s where s.employer_id = d.id and s.role_type = p_role_type and s.open_count > 0))
         and (not p_pinned or exists (select 1 from public.companies_own() o where o.employer_id = d.id and o.watching and o.pinned))
       order by d.name_norm, d.id
       limit v_limit
    )
    select d.id, ow.id, d.name, d.name_norm, d.domain, d.logo_url, d.careers_url, d.open_count, d.last_read_at, d.read_tier, d.cannot_read_reason,
           coalesce(ow.watching, false),
           coalesce(ow.watching and ow.pinned, false),
           case when d.cannot_read_reason is null then coalesce(m.n, 0) end,
           case when d.cannot_read_reason is null then coalesce(m.recent, 0) end,
           case when d.cannot_read_reason is null then coalesce(m.by_type, '{}'::jsonb) end,
           jsonb_build_array(d.name_norm, d.id::text)
      from page d
      left join m on m.eid = d.id
      left join lateral (select o.* from public.companies_own() o where o.employer_id = d.id order by o.watching desc, o.id limit 1) ow on true
     order by d.name_norm, d.id;
    return;
  end if;

  return query
  with m as (select * from public.companies_mine()),
  o as (select * from public.companies_own()),
  c as (
    select d.id as id, ow.id as company_id, d.name as name, d.name_norm as name_norm, d.domain as domain, d.logo_url as logo_url,
           d.careers_url as careers_url, d.open_count as open_count, d.last_read_at as last_read_at, d.read_tier as read_tier,
           d.cannot_read_reason as cannot_read_reason, coalesce(ow.watching, false) as following,
           coalesce(ow.watching and ow.pinned, false) as pinned
      from public.company_directory d
      left join lateral (select o2.* from o o2 where o2.employer_id = d.id order by o2.watching desc, o2.id limit 1) ow on true
     where p_tab = 'hiring' and d.verified_at is not null and exists (select 1 from m where m.eid = d.id)
    union all
    select coalesce(d.id, o3.id), o3.id, coalesce(d.name, o3.name), coalesce(d.name_norm, public.company_name_norm(o3.name)),
           coalesce(d.domain, o3.domain), coalesce(d.logo_url, o3.logo_url), coalesce(d.careers_url, o3.career_url),
           d.open_count, d.last_read_at, d.read_tier, d.cannot_read_reason, true, o3.pinned
      from o o3
      left join public.company_directory d on d.id = o3.employer_id and d.verified_at is not null
     where p_tab = 'following' and o3.watching
  ),
  f as (
    select c.*, m.n as n, m.recent as r, m.by_type as bt,
           (case when c.pinned then 0 else 1 end) as k1,
           (case when p_tab = 'hiring' then -coalesce(m.recent, 0) else 0 end) as k2,
           (case when p_tab = 'hiring' then -coalesce(m.n, 0) else 0 end) as k3
      from c
      left join m on m.eid = c.id
     where (not p_cannot_read or c.cannot_read_reason is not null)
       and (not p_pinned or c.pinned)
       and (p_names is null
            or c.name_norm = any (p_names)
            or (length(split_part(c.name_norm, ' ', 1)) >= 3 and split_part(c.name_norm, ' ', 1) = any (p_names)))
       and (p_role_type is null
            or p_role_type = any (coalesce(m.types, '{}'::text[]))
            or exists (select 1 from public.employer_stats s where s.employer_id = c.id and s.role_type = p_role_type and s.open_count > 0))
  )
  select f.id, f.company_id, f.name, f.name_norm, f.domain, f.logo_url, f.careers_url, f.open_count, f.last_read_at, f.read_tier,
         f.cannot_read_reason, f.following, f.pinned,
         case when f.cannot_read_reason is null then coalesce(f.n, 0) end,
         case when f.cannot_read_reason is null then coalesce(f.r, 0) end,
         case when f.cannot_read_reason is null then coalesce(f.bt, '{}'::jsonb) end,
         jsonb_build_array(f.k1, f.k2, f.k3, f.name_norm, f.id::text)
    from f
   where p_after is null or (f.k1, f.k2, f.k3, f.name_norm, f.id) > (a1, a2, a3, an, ai)
   order by f.k1, f.k2, f.k3, f.name_norm, f.id
   limit v_limit;
end;
$$;

-- The numbers on the three tab labels, from the same predicates as the pages.
create or replace function public.companies_tab_counts()
returns table (hiring bigint, following bigint, pinned bigint)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to see companies' using errcode = '42501';
  end if;
  return query
  select (select count(*) from public.companies_mine() m join public.company_directory d on d.id = m.eid and d.verified_at is not null),
         (select count(*) from public.companies_own() o where o.watching),
         (select count(*) from public.companies_own() o where o.watching and o.pinned);
end;
$$;

revoke execute on function public.companies_page(text, jsonb, integer, text, boolean, boolean, text[]), public.companies_tab_counts() from public, anon;
grant execute on function public.companies_page(text, jsonb, integer, text, boolean, boolean, text[]), public.companies_tab_counts() to authenticated;

-- ---------------------------------------------------------------------------
-- The All count: the sweep's own heartbeat carries it
-- ---------------------------------------------------------------------------

-- One count per slice, never per page load. It only adds two numbers to `found`; it never raises.
create or replace function public.directory_sweep_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.succeeded_at is distinct from old.succeeded_at then
    new.found := coalesce(new.found, '{}'::jsonb) || jsonb_build_object(
      'verified_total', (select count(*) from public.company_directory where verified_at is not null),
      'pending_total', (select count(*) from public.directory_candidates where state = 'pending')
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.directory_sweep_totals() from public, anon, authenticated;

drop trigger if exists job_heartbeats_directory_totals on public.job_heartbeats;
create trigger job_heartbeats_directory_totals
  before insert or update on public.job_heartbeats
  for each row
  when (new.job = 'directory.sweep' and new.user_id is null)
  execute function public.directory_sweep_totals();
