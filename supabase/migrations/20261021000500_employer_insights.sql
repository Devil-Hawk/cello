-- companies/insights: what a read of one employer's whole board says about it, stored once and shared.
--
--   employer_insights   one row per employer, written by readEmployer after each read (lib/companies/insights.ts)
--   company_page        gains insights (that row) and kept_count (how many open roles this person holds there)
--   companies_page      gains for_you: how many open roles this person holds at the employer and the best three
--
-- for_you and kept_count come from person_roles, which main's roles.check already writes; the rows are null / 0 for an
-- employer where the person holds nothing, which the page reads as "not matched yet", never as a verdict.
-- employer_insights is shared by everyone, so a signed-in person may read it; only the service role writes it.
-- Both functions are dropped and made again because their return types grow; the grants below are the ones of 20261021000100.

create table if not exists public.employer_insights (
  employer_id uuid primary key references public.company_directory (id) on delete cascade,
  computed_at timestamptz not null default now(),
  open integer not null,
  by_type jsonb not null default '[]'::jsonb,
  by_seniority jsonb not null default '{}'::jsonb,
  locations jsonb not null default '[]'::jsonb,
  remote_share numeric,
  posted_7d integer not null default 0,
  posted_30d integer not null default 0,
  pay jsonb not null default '{"stated": 0, "min": null, "max": null, "currency": null}'::jsonb,
  median_age_days integer,
  typical_close_days integer,
  closes_seen integer not null default 0,
  stack jsonb not null default '[]'::jsonb
);

alter table public.employer_insights enable row level security;
revoke all on public.employer_insights from public, anon, authenticated;
grant select on public.employer_insights to authenticated;
grant all on public.employer_insights to service_role;
drop policy if exists employer_insights_select on public.employer_insights;
create policy employer_insights_select on public.employer_insights for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- companies_page
-- ---------------------------------------------------------------------------

-- Same as 20261021000100 with for_you: {count, top[{title, chance}]} (best chance first, then newest), null when the
-- person holds no open role at the employer.
drop function if exists public.companies_page(uuid, text, boolean, boolean, integer, integer);
create function public.companies_page(
  p_user uuid,
  p_type text,
  p_with_roles boolean,
  p_show_closed boolean,
  p_limit integer,
  p_offset integer
)
returns table (
  employer_id uuid,
  name text,
  domain text,
  logo_url text,
  hq text,
  source text,
  open_count integer,
  open_count_at timestamptz,
  last_read_at timestamptz,
  next_read_at timestamptz,
  failed_reads integer,
  cannot_read_reason text,
  closed boolean,
  following boolean,
  is_dream boolean,
  role_types text[],
  matched integer,
  for_you jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name, d.domain, d.logo_url, d.hq, d.source,
         d.open_count, d.open_count_at, d.last_read_at, d.next_read_at, d.failed_reads, d.cannot_read_reason,
         x.closed, coalesce(f.following, false), coalesce(f.dream, false),
         array(select distinct s.role_type from public.employer_stats s where s.employer_id = d.id and s.role_type is not null and s.open_count > 0 order by 1),
         count(*) over ()::integer,
         (select jsonb_build_object('count', count(*), 'top', coalesce(jsonb_agg(jsonb_build_object('title', x.title, 'chance', x.chance) order by x.rn) filter (where x.rn <= 3), '[]'::jsonb))
            from (select j.title, pr.chance,
                         row_number() over (order by case pr.chance when 'strong' then 0 when 'possible' then 1 when 'stretch' then 2 else 3 end, j.posted_at desc nulls last, j.id) as rn
                    from public.person_roles pr join public.jobs j on j.id = pr.job_id
                   where pr.user_id = p_user and j.employer_id = d.id and pr.hidden_reason is null and j.still_open is not false) x
          having count(*) > 0)
    from public.company_directory d
    cross join lateral (select d.cannot_read_reason is not null and d.cannot_read_reason <> 'cannot_read' as closed) x
    left join lateral (
      select true as following, bool_or(c.is_dream_company) as dream
        from public.companies c
       where c.user_id = p_user and c.employer_id = d.id and c.watching
      having count(*) > 0
    ) f on true
   where d.verified_at is not null
     and (p_show_closed or not x.closed or coalesce(f.following, false))
     and (p_type is null or exists (select 1 from public.employer_stats s where s.employer_id = d.id and s.role_type = p_type and s.open_count > 0))
     and (not p_with_roles or exists (
           select 1 from public.person_roles pr join public.jobs j on j.id = pr.job_id
            where pr.user_id = p_user and j.employer_id = d.id and pr.hidden_reason is null and j.still_open is not false))
   order by coalesce(f.following, false) desc,
            case when f.following then d.name_norm end,
            case when d.cannot_read_reason is null then d.open_count end desc nulls last, d.name_norm, d.id
   limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;

-- ---------------------------------------------------------------------------
-- company_page
-- ---------------------------------------------------------------------------

-- Same as 20261021000100 with insights (the employer_insights row without its key) and kept_count (open roles this person holds).
drop function if exists public.company_page(uuid, uuid);
create function public.company_page(p_user uuid, p_employer uuid)
returns table (
  employer_id uuid,
  name text,
  domain text,
  logo_url text,
  hq text,
  profile jsonb,
  source text,
  careers_url text,
  ats_provider text,
  open_count integer,
  open_count_at timestamptz,
  last_read_at timestamptz,
  next_read_at timestamptz,
  failed_reads integer,
  cannot_read_reason text,
  closed boolean,
  following boolean,
  is_dream boolean,
  by_type jsonb,
  kept jsonb,
  insights jsonb,
  kept_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name, d.domain, d.logo_url, d.hq, d.profile, d.source, d.careers_url, d.ats_provider,
         d.open_count, d.open_count_at, d.last_read_at, d.next_read_at, d.failed_reads, d.cannot_read_reason,
         d.cannot_read_reason is not null and d.cannot_read_reason <> 'cannot_read',
         coalesce(f.following, false), coalesce(f.dream, false),
         coalesce((select jsonb_agg(jsonb_build_object('role_type', t.role_type, 'open', t.open) order by t.open desc, t.role_type nulls last)
                     from (select s.role_type, sum(s.open_count)::integer as open from public.employer_stats s
                            where s.employer_id = d.id and s.open_count > 0 group by s.role_type) t), '[]'::jsonb),
         coalesce((select jsonb_agg(k order by k.chance_rank, k.posted_at desc nulls last)
                     from (select j.id, j.title, j.role_type, j.location, j.url, j.posted_at, pr.chance,
                                  case pr.chance when 'strong' then 0 when 'possible' then 1 when 'stretch' then 2 else 3 end as chance_rank
                             from public.person_roles pr join public.jobs j on j.id = pr.job_id
                            where pr.user_id = p_user and j.employer_id = d.id and pr.hidden_reason is null and j.still_open is not false
                            order by chance_rank, j.posted_at desc nulls last limit 100) k), '[]'::jsonb),
         (select to_jsonb(i) - 'employer_id' from public.employer_insights i where i.employer_id = d.id),
         (select count(*)::integer from public.person_roles pr join public.jobs j on j.id = pr.job_id
           where pr.user_id = p_user and j.employer_id = d.id and pr.hidden_reason is null and j.still_open is not false)
    from public.company_directory d
    left join lateral (
      select true as following, bool_or(c.is_dream_company) as dream
        from public.companies c
       where c.user_id = p_user and c.employer_id = d.id and c.watching
      having count(*) > 0
    ) f on true
   where d.id = p_employer and d.verified_at is not null
$$;

revoke execute on function public.companies_page(uuid, text, boolean, boolean, integer, integer), public.company_page(uuid, uuid) from public, anon, authenticated;
grant execute on function public.companies_page(uuid, text, boolean, boolean, integer, integer), public.company_page(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: an employer with insights and two roles held by one person. Always rolls back.
-- ---------------------------------------------------------------------------

do $$
declare
  u uuid := gen_random_uuid();
  e uuid := gen_random_uuid();
  bare uuid := gen_random_uuid();
  j1 uuid := gen_random_uuid();
  j2 uuid := gen_random_uuid();
  j3 uuid := gen_random_uuid();
  r record;
begin
  begin
    insert into auth.users (id, email) values (u, 'companies-insights-selfcheck@example.invalid');
    insert into public.company_directory (id, name, name_norm, domain, source, verified_at, open_count, open_count_at, last_read_at) values
      (e,    'Selfcheck Insights', 'selfcheck insights', 'selfcheck-insights.invalid', 'seed', now(), 3, now(), now()),
      (bare, 'Selfcheck Bare',     'selfcheck bare',     'selfcheck-bare.invalid',     'seed', now(), 1, now(), now());
    insert into public.employer_insights (employer_id, open, by_type, stack, pay, typical_close_days, closes_seen)
      values (e, 3, '[{"roleType": null, "open": 3}]', '[{"name": "Python", "count": 2}]', '{"stated": 1, "min": 100000, "max": 200000, "currency": "USD"}', null, 4);
    insert into public.jobs (id, employer_id, title, description, url, posted_at) values
      (j1, e, 'Selfcheck A', 'x', 'https://selfcheck-insights.invalid/1', now() - interval '3 days'),
      (j2, e, 'Selfcheck B', 'x', 'https://selfcheck-insights.invalid/2', now() - interval '1 day'),
      (j3, e, 'Selfcheck C', 'x', 'https://selfcheck-insights.invalid/3', now());
    insert into public.person_roles (user_id, job_id, chance) values (u, j1, 'possible'), (u, j2, 'strong'), (u, j3, 'possible');

    -- the page carries the employer's insights, without the key, and the count of roles the person holds
    select * into r from public.company_page(u, e);
    if r.insights is null or r.insights ? 'employer_id' or r.insights->>'open' <> '3' or r.insights->'stack'->0->>'name' <> 'Python' or r.insights->'pay'->>'max' <> '200000' then
      raise exception 'company_page: insights must be the stored row, got %', r.insights;
    end if;
    if r.insights->'typical_close_days' is distinct from 'null'::jsonb or (r.insights->>'closes_seen')::integer <> 4 then raise exception 'company_page: an unknown pace must stay null, not 0'; end if;
    if r.kept_count <> 3 then raise exception 'company_page: kept_count, got %', r.kept_count; end if;
    select * into r from public.company_page(gen_random_uuid(), e);
    if r.kept_count <> 0 or r.insights is null then raise exception 'company_page: another person holds nothing, but the insights are shared'; end if;
    select * into r from public.company_page(u, bare);
    if r.insights is not null then raise exception 'company_page: an employer never read has no insights, not an empty row'; end if;

    -- the wall: the count and the best three (strong first, then the newer possible), null where nothing is held
    select * into r from public.companies_page(u, null, false, true, 50, 0) where name = 'Selfcheck Insights';
    if (r.for_you->>'count')::integer <> 3 or jsonb_array_length(r.for_you->'top') <> 3
       or r.for_you->'top'->0->>'title' <> 'Selfcheck B' or r.for_you->'top'->1->>'title' <> 'Selfcheck C' then
      raise exception 'companies_page: for_you wrong, got %', r.for_you;
    end if;
    select * into r from public.companies_page(u, null, false, true, 50, 0) where name = 'Selfcheck Bare';
    if r.for_you is not null then raise exception 'companies_page: for_you must be null where nothing is held, got %', r.for_you; end if;
    select * into r from public.companies_page(gen_random_uuid(), null, false, true, 50, 0) where name = 'Selfcheck Insights';
    if r.for_you is not null then raise exception 'companies_page: for_you is the person''s own'; end if;

    -- deleting the employer takes its insights with it
    delete from public.company_directory where id = e;
    if exists (select 1 from public.employer_insights where employer_id = e) then raise exception 'employer_insights must go with its employer'; end if;

    raise exception 'companies_insights self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'companies_insights self-check passed' then raise; end if;
  end;
  if exists (select 1 from public.company_directory where name like 'Selfcheck%') then raise exception 'the self-check left rows behind'; end if;
end $$;

notify pgrst, 'reload schema';
