-- Companies contract (feature 1, PR 1): what the Companies pages read, as three functions, plus the two facts a read adds to an employer.
--
--   company_directory.hq        the most common place among the postings of the last read (written by recordRead)
--   company_directory.profile   facts about the employer from a named public source, with the source and the time
--   companies_page              the wall: the verified employers, the person's follows first
--   company_page                one employer: its head, the person's follow, the roles the person holds there
--   company_roles               search inside one employer's stored roles
--
-- All three are service role only: a route checks the session, then reads with the admin client.
--
-- closed: the board left the rotation for a reason that will not mend by waiting. recordRead (verify-directory.ts) sets
-- cannot_read_reason and clears next_read_at when a board is gone (no_board), no longer proven (not_linked, other_owner,
-- not_employer_site) or has no posting in 120 days (stale). 'cannot_read' is the one reason that is not closed: the board
-- did not answer three times, and the page says "Cannot read" with the reason, never "0 open".

alter table public.company_directory
  add column if not exists hq text,
  add column if not exists profile jsonb;

-- ---------------------------------------------------------------------------
-- companies_page
-- ---------------------------------------------------------------------------

-- Following first, alphabetical; then everyone else, most open roles first, then alphabetical.
-- p_type: keep an employer whose board lists an open role of that type (employer_stats), kept or not.
-- p_with_roles: keep an employer where this person holds an open role (person_roles).
-- p_show_closed: false hides closed employers from everyone else; a closed employer the person follows always shows.
create or replace function public.companies_page(
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
  role_types text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name, d.domain, d.logo_url, d.hq, d.source,
         d.open_count, d.open_count_at, d.last_read_at, d.next_read_at, d.failed_reads, d.cannot_read_reason,
         x.closed, coalesce(f.following, false), coalesce(f.dream, false),
         array(select distinct s.role_type from public.employer_stats s where s.employer_id = d.id and s.role_type is not null and s.open_count > 0 order by 1)
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
            d.open_count desc nulls last, d.name_norm, d.id
   limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;

-- ---------------------------------------------------------------------------
-- company_page
-- ---------------------------------------------------------------------------

-- by_type: every listing the last read saw, by role type (null = not yet typed), from employer_stats.
-- kept: the open roles this person holds at the employer, best chance first (the most recent 100).
create or replace function public.company_page(p_user uuid, p_employer uuid)
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
  kept jsonb
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
                            order by chance_rank, j.posted_at desc nulls last limit 100) k), '[]'::jsonb)
    from public.company_directory d
    left join lateral (
      select true as following, bool_or(c.is_dream_company) as dream
        from public.companies c
       where c.user_id = p_user and c.employer_id = d.id and c.watching
      having count(*) > 0
    ) f on true
   where d.id = p_employer and d.verified_at is not null
$$;

-- ---------------------------------------------------------------------------
-- company_roles
-- ---------------------------------------------------------------------------

-- The employer's stored open roles whose title, role type or description holds p_q (all of them when p_q is empty),
-- the person's own first. The sweep stores a role only when somebody's targets keep it, so this is not every listing.
-- ponytail: a scan of one employer's rows (jobs_employer_idx); a text index when an employer holds thousands.
create or replace function public.company_roles(p_user uuid, p_employer uuid, p_q text)
returns table (
  id uuid,
  title text,
  role_type text,
  location text,
  url text,
  posted_at timestamptz,
  kept boolean,
  chance text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.role_type, j.location, j.url, j.posted_at,
         pr.job_id is not null and pr.hidden_reason is null, pr.chance
    from public.jobs j
    left join public.person_roles pr on pr.job_id = j.id and pr.user_id = p_user
   where j.employer_id = p_employer and j.still_open is not false
     and (coalesce(btrim(p_q), '') = ''
          or strpos(lower(j.title), lower(btrim(p_q))) > 0
          or strpos(lower(coalesce(j.role_type, '')), lower(btrim(p_q))) > 0
          or strpos(lower(coalesce(j.description, '')), lower(btrim(p_q))) > 0)
   order by (pr.job_id is not null and pr.hidden_reason is null) desc, j.posted_at desc nulls last, j.title, j.id
   limit 200
$$;

revoke execute on function public.companies_page(uuid, text, boolean, boolean, integer, integer), public.company_page(uuid, uuid), public.company_roles(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.companies_page(uuid, text, boolean, boolean, integer, integer), public.company_page(uuid, uuid), public.company_roles(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: three employers (open, closed, unreadable), one person who follows the closed one, one role.
-- The rows are made inside a block that always rolls back.
-- ---------------------------------------------------------------------------

do $$
declare
  u uuid := gen_random_uuid();
  open_id uuid := gen_random_uuid();
  closed_id uuid := gen_random_uuid();
  unread_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  n integer;
  r record;
begin
  begin
    insert into auth.users (id, email) values (u, 'companies-contract-selfcheck@example.invalid');
    insert into public.company_directory (id, name, name_norm, domain, source, verified_at, open_count, open_count_at, last_read_at, hq) values
      (open_id,   'Selfcheck Open',   'selfcheck open',   'selfcheck-open.invalid',   'seed',   now(), 4, now(), now(), 'Paris'),
      (closed_id, 'Selfcheck Closed', 'selfcheck closed', 'selfcheck-closed.invalid', 'person', now(), 9, now() - interval '30 days', now(), null),
      (unread_id, 'Selfcheck Unread', 'selfcheck unread', 'selfcheck-unread.invalid', 'seed',   now(), null, null, now(), null);
    -- the follow row finds its employer by the careers address (companies_link_employer)
    update public.company_directory set cannot_read_reason = 'stale', next_read_at = null, careers_url = 'https://selfcheck-closed.invalid/careers' where id = closed_id;
    update public.company_directory set cannot_read_reason = 'cannot_read', failed_reads = 3 where id = unread_id;
    insert into public.employer_stats (employer_id, role_type, seniority, open_count) values (open_id, 'other', 'mid', 4);
    insert into public.jobs (id, employer_id, title, description, url) values (job_id, open_id, 'Selfcheck Engineer', 'Python and Spark', 'https://selfcheck-open.invalid/1');
    insert into public.companies (user_id, name, domain, career_url, employer_id, watching) values (u, 'Selfcheck Closed', 'selfcheck-closed.invalid', 'https://selfcheck-closed.invalid/careers', closed_id, true);

    -- the wall hides the closed employer from everyone else, keeps the one the person follows, and puts it first
    select count(*) into n from public.companies_page(u, null, false, false, 50, 0) where name like 'Selfcheck%';
    if n <> 3 then raise exception 'companies_page: a followed closed employer must show, got % of 3', n; end if;
    select count(*) into n from public.companies_page(gen_random_uuid(), null, false, false, 50, 0) where name like 'Selfcheck%';
    if n <> 2 then raise exception 'companies_page: closed must be hidden from someone who does not follow it, got %', n; end if;
    select count(*) into n from public.companies_page(gen_random_uuid(), null, false, true, 50, 0) where name like 'Selfcheck%';
    if n <> 3 then raise exception 'companies_page: show closed must list all three, got %', n; end if;
    select * into r from public.companies_page(u, null, false, false, 50, 0) where name like 'Selfcheck%' limit 1;
    if r.name <> 'Selfcheck Closed' or not r.following or not r.closed then raise exception 'companies_page: the follow must come first and be closed'; end if;
    select * into r from public.companies_page(u, null, false, false, 50, 0) where name = 'Selfcheck Unread';
    if r.closed or r.open_count is not null or r.cannot_read_reason <> 'cannot_read' then raise exception 'companies_page: an unreadable employer is not closed and has no count'; end if;
    select count(*) into n from public.companies_page(u, 'other', false, true, 50, 0) where name like 'Selfcheck%';
    if n <> 1 then raise exception 'companies_page: the type filter must keep only the employer that lists the type, got %', n; end if;
    select count(*) into n from public.companies_page(u, null, true, true, 50, 0) where name like 'Selfcheck%';
    if n <> 0 then raise exception 'companies_page: with roles must keep nobody before a role is held, got %', n; end if;

    -- the page of one employer
    select * into r from public.company_page(u, open_id);
    if r.name <> 'Selfcheck Open' or r.hq <> 'Paris' or r.following or jsonb_array_length(r.by_type) <> 1 then raise exception 'company_page: wrong head'; end if;
    if exists (select 1 from public.company_page(u, gen_random_uuid())) then raise exception 'company_page: an unknown employer must give no row'; end if;

    -- search inside: the title, the description, and a miss
    select count(*) into n from public.company_roles(u, open_id, 'engineer');
    if n <> 1 then raise exception 'company_roles: title search, got %', n; end if;
    select count(*) into n from public.company_roles(u, open_id, 'SPARK');
    if n <> 1 then raise exception 'company_roles: description search, got %', n; end if;
    select count(*) into n from public.company_roles(u, open_id, 'golang');
    if n <> 0 then raise exception 'company_roles: a miss must give nothing, got %', n; end if;

    raise exception 'companies_contract self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'companies_contract self-check passed' then raise; end if;
  end;
  if exists (select 1 from public.company_directory where name like 'Selfcheck%') then raise exception 'the self-check left rows behind'; end if;
end $$;

notify pgrst, 'reload schema';
