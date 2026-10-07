-- K5a relevance schema (expand only: old code keeps working beside it).
--
-- WHY
--   Roles were stored once per person (companies.user_id, jobs.company_id), whatever the person's
--   targets were, so one employer's postings were copied for everyone who followed it and most of
--   them were never relevant. The shape that fixes it: one shared employer, one stored row per
--   posting, and a per-person row saying who may see it. A role is stored only when it is inside
--   someone's stated targets; what is left out is counted, never stored (directive 26).
--
-- WHAT
--   ats_providers         the lookup of every provider the reader and the seed use
--   company_directory     the shared employer: one row per employer that passed the verifier
--   companies             employer_id (the shared employer) and watching (the person follows it)
--   jobs                  employer_id, posting_key (one per employer), source_tier, legit_label
--   person_roles          who may see a role, and everything about it that is the person's alone
--   seen_postings         a marker that stops detail fetches and model steps being repeated
--   person_counts         "214 outside your search: 120 place, 80 level", numbers and never rows
--   profiles.targets_version, and a trigger that starts a role check when the targets change
--   fold_shared_postings  merges per-person copies of one posting into one row (called by the
--                         contract migration, 20261008055000, after the new reads are deployed)
--   prune_stale_rows, evict_company_jobs, clear_unverified_board_jobs
--                         stop treating a person_roles row as a reason to keep a role (a saved one still is)
--   jobs_default_person_role  every inserted role is its company owner's: a person_roles row beside it
--
--   The rows for the commands registry and the provenance tables wait for the files that own them
--   (K10, K11).
--
--   Everything here is additive. person_roles is written beside the old per-person reads; nothing
--   reads it until the next package.

-- ---------------------------------------------------------------------------
-- Providers
-- ---------------------------------------------------------------------------

create table if not exists public.ats_providers (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  label text not null
);

insert into public.ats_providers (id, label) values
  ('greenhouse', 'Greenhouse'),
  ('lever', 'Lever'),
  ('ashby', 'Ashby'),
  ('workday', 'Workday'),
  ('smartrecruiters', 'SmartRecruiters'),
  ('workable', 'Workable'),
  ('recruitee', 'Recruitee'),
  ('personio', 'Personio'),
  ('eightfold', 'Eightfold')
on conflict (id) do nothing;

alter table public.ats_providers enable row level security;
revoke all on public.ats_providers from public, anon, authenticated;
grant all on public.ats_providers to service_role;

-- ---------------------------------------------------------------------------
-- The shared employer
-- ---------------------------------------------------------------------------

create table if not exists public.company_directory (
  id uuid primary key default gen_random_uuid(),
  -- company-search's text key, kept as a unique column
  key text unique check (char_length(key) between 1 and 300),
  name text not null check (char_length(name) between 1 and 200),
  name_norm text not null,
  domain text unique,
  -- the last read's total open roles ("of 636 open") and when it was read
  open_count integer check (open_count >= 0),
  open_count_at timestamptz,
  logo_url text,
  ats_provider text references public.ats_providers (id),
  ats_token text check (ats_token ~ '^[A-Za-z0-9._-]{1,128}$'),
  careers_url text,
  -- how the employer was tied to its board: the verifier's own record
  verified_by text check (verified_by in (
    'careers_link', 'posting_domain', 'provider_data', 'careers_url_host', 'seed_checked', 'domain_only',
    'careers_url', 'manual', 'known_board', 'careers_page_link', 'board_links_home', 'provider_name'
  )),
  verified_at timestamptz,
  -- never 'model': an employer comes from a seed, a person's Add, a traced lead or a verified mail
  source text not null default 'person' check (source in ('seed', 'yc', 'person', 'lead', 'inbox_verified')),
  last_read_at timestamptz,
  next_read_at timestamptz,
  read_tier text,
  cannot_read_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ats_provider, ats_token)
);

create index if not exists company_directory_next_read_idx on public.company_directory (next_read_at) where verified_at is not null;

alter table public.company_directory enable row level security;
revoke all on public.company_directory from public, anon, authenticated;
grant all on public.company_directory to service_role;

-- ---------------------------------------------------------------------------
-- companies: the shared employer and who follows it
-- ---------------------------------------------------------------------------

alter table public.companies add column if not exists employer_id uuid references public.company_directory (id) on delete set null;
alter table public.companies add column if not exists watching boolean not null default true;

create index if not exists companies_employer_idx on public.companies (employer_id) where employer_id is not null;

-- A lead the sourcer or an old mail sync wrote (metadata.suggested) is not followed. The old writers
-- keep setting that key until companies.follow is the only writer (K13), so the column follows it.
create or replace function public.companies_derive_watching()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (new.metadata ->> 'suggested') = 'true' then new.watching := false; end if;
  elsif new.metadata is distinct from old.metadata then
    if (new.metadata ->> 'suggested') = 'true' then
      new.watching := false;
    elsif (old.metadata ->> 'suggested') = 'true' then
      -- the person added a company that was a lead
      new.watching := true;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists companies_derive_watching on public.companies;
create trigger companies_derive_watching
  before insert or update of metadata on public.companies
  for each row execute function public.companies_derive_watching();

update public.companies set watching = false where (metadata ->> 'suggested') = 'true' and watching;

-- A company whose domain, or whose verified board, is a directory employer is that employer.
create or replace function public.companies_link_employer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.employer_id is null then
    select d.id into new.employer_id
      from public.company_directory d
     where d.verified_at is not null
       and ((nullif(btrim(new.domain), '') is not null and d.domain = lower(btrim(new.domain)))
         or (d.ats_provider is not null and d.ats_provider = new.metadata -> 'ats' ->> 'provider' and d.ats_token = new.metadata -> 'ats' ->> 'token'))
     order by (d.ats_token is not null and d.ats_token = new.metadata -> 'ats' ->> 'token') desc
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists companies_link_employer on public.companies;
create trigger companies_link_employer
  before insert or update of domain, metadata on public.companies
  for each row execute function public.companies_link_employer();

-- The name of a person-added or traced employer is the one it was verified under, and no second one takes a name
-- another verified employer holds (anyone can open a provider account under any name). Seed and yc rows are lists:
-- namesakes from them stay. An insert is skipped, not refused, so the backfill below never aborts.
-- ponytail: a real rebrand of a person-added employer is renamed by hand.
create or replace function public.company_directory_name_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.source not in ('seed', 'yc') and new.name_norm <> ''
       and exists (select 1 from public.company_directory d where d.name_norm = new.name_norm and d.verified_at is not null and d.id <> new.id) then
      return null;
    end if;
  elsif old.source not in ('seed', 'yc') then
    new.name := old.name;
    new.name_norm := old.name_norm;
  end if;
  return new;
end;
$$;
revoke all on function public.company_directory_name_claim() from public, anon, authenticated;

drop trigger if exists company_directory_name_claim on public.company_directory;
create trigger company_directory_name_claim
  before insert or update of name, name_norm on public.company_directory
  for each row execute function public.company_directory_name_claim();

-- One employer per verified board, from what truth's verifier recorded. A company whose board was
-- only guessed (no verified_by) is not an employer yet.
insert into public.company_directory (name, name_norm, domain, ats_provider, ats_token, careers_url, verified_by, verified_at, source)
select distinct on (provider, token)
       name, btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')), domain, provider, token, career_url, verified_by, verified_at, 'person'
  from (
    select c.name,
           lower(nullif(btrim(c.domain), '')) as domain,
           c.career_url,
           c.metadata -> 'ats' ->> 'provider' as provider,
           c.metadata -> 'ats' ->> 'token' as token,
           c.metadata -> 'ats' ->> 'verified_by' as verified_by,
           case when (c.metadata -> 'ats' ->> 'verified_at') ~ '^\d{4}-\d{2}-\d{2}' then (c.metadata -> 'ats' ->> 'verified_at')::timestamptz else now() end as verified_at,
           c.created_at
      from public.companies c
     where (c.metadata ->> 'suggested') is distinct from 'true'
  ) s
 where provider in (select id from public.ats_providers)
   and token ~ '^[A-Za-z0-9._-]{1,128}$'
   and verified_by in ('careers_url', 'manual', 'known_board', 'careers_page_link', 'board_links_home', 'provider_name')
 order by provider, token, created_at
on conflict do nothing;

-- An employer read through its own site (no board) is tied by its careers address.
insert into public.company_directory (name, name_norm, domain, careers_url, verified_by, verified_at, source)
select distinct on (domain) name, btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')), domain, career_url, 'careers_url_host', now(), 'person'
  from (
    select c.name, lower(nullif(btrim(c.domain), '')) as domain, c.career_url, c.created_at
      from public.companies c
     where (c.metadata ->> 'suggested') is distinct from 'true'
       and c.metadata -> 'source_check' ->> 'readable' = 'true'
       and c.metadata -> 'ats' ->> 'provider' is null
  ) s
 where domain is not null
 order by domain, created_at
on conflict do nothing;

update public.companies c
   set employer_id = d.id
  from public.company_directory d
 where c.employer_id is null
   and d.verified_at is not null
   and (c.metadata ->> 'suggested') is distinct from 'true'
   and ((d.ats_provider is not null and d.ats_provider = c.metadata -> 'ats' ->> 'provider' and d.ats_token = c.metadata -> 'ats' ->> 'token')
     or (nullif(btrim(c.domain), '') is not null and d.domain = lower(btrim(c.domain))));

-- ---------------------------------------------------------------------------
-- jobs: one row per posting
-- ---------------------------------------------------------------------------

alter table public.jobs add column if not exists employer_id uuid references public.company_directory (id) on delete set null;
alter table public.jobs add column if not exists posting_key text;
alter table public.jobs add column if not exists source_tier text check (source_tier in ('board', 'site_search', 'sitemap', 'listing', 'rendered', 'model'));
alter table public.jobs add column if not exists legit_label text check (legit_label in ('agency', 'repost'));

-- The unique index (employer, posting key) arrives with the contract migration, once the copies are folded.
create index if not exists jobs_employer_posting_idx on public.jobs (employer_id, posting_key) where employer_id is not null;

-- A row is shared only when the employer's own board wrote it (its source is the board's provider and the
-- company's pointer is the directory's token). Mail placeholders, aggregator and site rows stay the person's own.
update public.jobs j
   set employer_id = case when exists (
         select 1 from public.company_directory d
          where d.id = c.employer_id and d.ats_provider = j.source and d.ats_token = c.metadata -> 'ats' ->> 'token'
       ) then c.employer_id end,
       posting_key = coalesce(nullif(j.external_id, ''), md5(j.url))
  from public.companies c
 where c.id = j.company_id
   and j.posting_key is null;

-- Rows the old code inserts get the same two columns.
create or replace function public.jobs_set_employer_posting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.posting_key is null then
    new.posting_key := coalesce(nullif(new.external_id, ''), md5(new.url));
  end if;
  -- Only a row the employer's own board wrote is shared; everything else stays the person's own.
  if new.employer_id is null and new.company_id is not null then
    select c.employer_id into new.employer_id
      from public.companies c
      join public.company_directory d on d.id = c.employer_id
     where c.id = new.company_id and d.ats_provider is not null and d.ats_provider = new.source;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_set_employer_posting on public.jobs;
create trigger jobs_set_employer_posting
  before insert on public.jobs
  for each row execute function public.jobs_set_employer_posting();

-- ---------------------------------------------------------------------------
-- profiles: the version of the person's targets, and a check when they change
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists targets_version integer not null default 0;

create or replace function public.profiles_targets_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.preferences -> 'targeting') is distinct from (old.preferences -> 'targeting') then
    new.targets_version := coalesce(old.targets_version, 0) + 1;
    -- Cello will re-check at once: the routine is due now, and the sweeper starts it within a minute.
    update public.routines set next_due_at = now(), poked_at = null
     where user_id = new.id and command = 'roles.check' and enabled;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_targets_changed on public.profiles;
create trigger profiles_targets_changed
  before update of preferences on public.profiles
  for each row execute function public.profiles_targets_changed();

-- ---------------------------------------------------------------------------
-- person_roles, seen_postings, person_counts
-- ---------------------------------------------------------------------------

create table if not exists public.person_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  visible_since timestamptz not null default now(),
  targets_version integer not null default 0,
  saved_at timestamptz,
  hidden_reason text check (hidden_reason in ('not_for_me', 'unclassified')),
  checked_at timestamptz,
  primary key (user_id, job_id)
);

-- A person's own score, its details and the new flag: derived from their resume and key, so never shared.
-- Only the service role writes them (the grants below keep a signed-in person to saved_at and hidden_reason).
alter table public.person_roles
  add column if not exists match_score integer,
  add column if not exists match_details jsonb,
  add column if not exists is_new boolean not null default true;

create index if not exists person_roles_job_idx on public.person_roles (job_id);
create index if not exists person_roles_saved_idx on public.person_roles (job_id) where saved_at is not null;

create table if not exists public.seen_postings (
  employer_id uuid not null references public.company_directory (id) on delete cascade,
  posting_hash text not null check (char_length(posting_hash) between 8 and 64),
  last_seen_at timestamptz not null default now(),
  primary key (employer_id, posting_hash)
);

create index if not exists seen_postings_last_seen_idx on public.seen_postings (last_seen_at);

create table if not exists public.person_counts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  employer_id uuid references public.company_directory (id) on delete cascade,
  -- the person's own company row, for an employer that is not in the directory yet
  company_id uuid references public.companies (id) on delete cascade,
  kind text not null check (kind in ('outside_targets', 'untraced', 'cannot_read', 'untyped', 'shadow_keep', 'shadow_drop')),
  reason text not null default '',
  n integer not null check (n >= 0),
  unique nulls not distinct (user_id, day, employer_id, company_id, kind, reason)
);

create index if not exists person_counts_user_day_idx on public.person_counts (user_id, day desc);

alter table public.person_roles enable row level security;
alter table public.seen_postings enable row level security;
alter table public.person_counts enable row level security;

revoke all on public.person_roles, public.seen_postings, public.person_counts from public, anon, authenticated;
grant select, update, delete on public.person_roles to authenticated;
grant select on public.person_counts to authenticated;
grant all on public.person_roles, public.seen_postings, public.person_counts to service_role;
grant usage, select on sequence public.person_counts_id_seq to service_role;

drop policy if exists person_roles_select on public.person_roles;
create policy person_roles_select on public.person_roles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists person_roles_update on public.person_roles;
create policy person_roles_update on public.person_roles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists person_roles_delete on public.person_roles;
create policy person_roles_delete on public.person_roles for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists person_counts_select on public.person_counts;
create policy person_counts_select on public.person_counts for select to authenticated using (user_id = (select auth.uid()));

-- A person reads a shared role when they have a person_roles row for it. The old rule (the role belongs
-- to a company of theirs) stays until the contract migration.
drop policy if exists "jobs via person_roles" on public.jobs;
create policy "jobs via person_roles" on public.jobs for select to authenticated
  using (exists (select 1 from public.person_roles pr where pr.job_id = jobs.id and pr.user_id = (select auth.uid())));

-- One person_roles row for every role a person already has, beside the old reads.
insert into public.person_roles (user_id, job_id, visible_since, targets_version, checked_at, match_score, match_details, is_new)
select c.user_id, j.id, coalesce(j.discovered_at, now()), 0, j.last_seen_at, j.match_score, j.match_details, j.is_new
  from public.jobs j
  join public.companies c on c.id = j.company_id
on conflict (user_id, job_id) do nothing;

-- Every role a writer inserts is its company owner's: a person_roles row beside it. The reader
-- then refines it (hidden, the version of the targets); the writers that predate person_roles (the
-- aggregator leads, a shared mail thread) need no change to stay visible after the contract.
create or replace function public.jobs_default_person_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.person_roles (user_id, job_id, visible_since)
  select c.user_id, new.id, coalesce(new.discovered_at, now())
    from public.companies c
   where c.id = new.company_id
  on conflict (user_id, job_id) do nothing;
  return new;
end;
$$;

drop trigger if exists jobs_default_person_role on public.jobs;
create trigger jobs_default_person_role
  after insert on public.jobs
  for each row execute function public.jobs_default_person_role();

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

-- Give a person the roles of one of their companies that a check kept. `p_hidden` are kept but
-- hidden ("unclassified": nothing disagrees with their targets, but a dimension could not be read).
create or replace function public.sync_person_roles(
  p_user uuid,
  p_company uuid,
  p_external_ids text[],
  p_targets_version integer default 0,
  p_hidden text[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user then
    raise exception 'not your roles' using errcode = 'insufficient_privilege';
  end if;
  insert into public.person_roles (user_id, job_id, targets_version, hidden_reason, checked_at)
  select p_user, j.id, p_targets_version, case when j.external_id = any (p_hidden) then 'unclassified' end, now()
    from public.jobs j
   where j.company_id = p_company
     and j.external_id = any (p_external_ids)
     and exists (select 1 from public.companies c where c.id = p_company and c.user_id = p_user)
  on conflict (user_id, job_id) do update
    set targets_version = excluded.targets_version,
        checked_at = now(),
        -- the person's own "not for me" is never undone by a check
        hidden_reason = case when public.person_roles.hidden_reason = 'not_for_me' then 'not_for_me' else excluded.hidden_reason end;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- What a read found outside the person's targets, as numbers. A day's read of an employer replaces
-- that day's numbers for the employer and kind: send every reason, with n = 0 for the ones that
-- found nothing (a zero resets the row and is not stored).
create or replace function public.set_person_counts(p_user uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user then
    raise exception 'not your counts' using errcode = 'insufficient_privilege';
  end if;
  delete from public.person_counts pc
   using (
     select distinct nullif(r ->> 'employer_id', '')::uuid as employer_id, nullif(r ->> 'company_id', '')::uuid as company_id, r ->> 'kind' as kind
       from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
      where nullif(r ->> 'company_id', '') is null
         or exists (select 1 from public.companies c where c.id = nullif(r ->> 'company_id', '')::uuid and c.user_id = p_user)
   ) k
   where pc.user_id = p_user
     and pc.day = (now() at time zone 'utc')::date
     and pc.kind = k.kind
     and pc.employer_id is not distinct from k.employer_id
     and pc.company_id is not distinct from k.company_id;

  insert into public.person_counts (user_id, day, employer_id, company_id, kind, reason, n)
  select p_user, (now() at time zone 'utc')::date,
         nullif(r ->> 'employer_id', '')::uuid, nullif(r ->> 'company_id', '')::uuid,
         r ->> 'kind', coalesce(r ->> 'reason', ''), sum(greatest((r ->> 'n')::integer, 0))
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where (nullif(r ->> 'company_id', '') is null
          or exists (select 1 from public.companies c where c.id = nullif(r ->> 'company_id', '')::uuid and c.user_id = p_user))
     and greatest((r ->> 'n')::integer, 0) > 0
   group by 3, 4, 5, 6;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The postings of an employer that a read has seen; returns the ones that were not seen in 30 days.
create or replace function public.mark_seen_postings(p_employer uuid, p_hashes text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  fresh text[];
begin
  select coalesce(array_agg(h), '{}') into fresh
    from unnest(p_hashes) h
   where not exists (
     select 1 from public.seen_postings s
      where s.employer_id = p_employer and s.posting_hash = h and s.last_seen_at > now() - interval '30 days'
   );
  insert into public.seen_postings (employer_id, posting_hash)
  select p_employer, h from unnest(p_hashes) h
  on conflict (employer_id, posting_hash) do update set last_seen_at = now();
  return fresh;
end;
$$;

-- ---------------------------------------------------------------------------
-- The directory match: roles already stored for the employers others follow
-- ---------------------------------------------------------------------------

-- The open roles at verified employers that this person does not hold yet, newest first, for the
-- check to judge against their targets in code (lib/jobs/target-relevance.ts). `p_since` limits it to
-- roles stored since the person's last check; null looks at every stored role (after a targets change).
create or replace function public.directory_roles_for(p_user uuid, p_since timestamptz default null, p_limit integer default 2000)
returns table (
  id uuid, title text, job_function text, seniority text, country text, language text,
  is_remote boolean, posted_at timestamptz, employer_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.job_function, j.seniority, j.country, j.language, j.is_remote, j.posted_at, d.name
    from public.jobs j
    join public.company_directory d on d.id = j.employer_id
   where j.still_open is not false
     and (j.posted_at is null or j.posted_at > now() - interval '180 days')
     and (p_since is null or j.discovered_at > p_since)
     and not exists (select 1 from public.person_roles pr where pr.user_id = p_user and pr.job_id = j.id)
   order by j.discovered_at desc
   limit least(greatest(p_limit, 1), 5000)
$$;

-- Give a person roles the directory match chose. `p_hidden` are kept hidden (unclassified).
create or replace function public.add_person_roles(p_user uuid, p_job_ids uuid[], p_hidden uuid[] default '{}', p_targets_version integer default 0)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  insert into public.person_roles (user_id, job_id, targets_version, hidden_reason, checked_at)
  select p_user, j.id, p_targets_version, case when j.id = any (p_hidden) then 'unclassified' end, now()
    from public.jobs j
   where j.id = any (p_job_ids)
  on conflict (user_id, job_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- The fold: one row per posting
-- ---------------------------------------------------------------------------
--
-- Merges the per-person copies of a posting (same employer, same posting key) into the oldest one.
-- Each owner keeps a person_roles row for it; every foreign key to jobs(id) found in the catalog is
-- repointed to the survivor (applications, drafts, kits and the rest), the way the evict migration
-- finds them. A copy whose repoint would break a per-person unique key is left where it is and
-- counted. Safe to run again.
--
-- It first takes the employer off every row the employer's board did not write (a mail placeholder, an
-- aggregator or a site row): two people's copies of those are two people's own and must not merge. This
-- runs once, in 055000, before any site-employer row is shared; a site employer's rows carry no provider.
create or replace function public.fold_shared_postings()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  loser uuid;
  fk_tbl text[];
  fk_col text[];
  i integer;
  ok boolean;
  n integer;
  groups integer := 0;
  merged integer := 0;
  skipped integer := 0;
  repointed integer := 0;
begin
  update public.jobs j set employer_id = null
   where j.employer_id is not null
     and j.source is distinct from (select d.ats_provider from public.company_directory d where d.id = j.employer_id);
  delete from public.person_roles pr
   using public.jobs j
   where j.id = pr.job_id and j.employer_id is null and j.company_id is not null and pr.saved_at is null
     and not exists (select 1 from public.companies c where c.id = j.company_id and c.user_id = pr.user_id);

  select array_agg(c.conrelid::regclass::text order by c.oid), array_agg(a.attname::text order by c.oid)
    into fk_tbl, fk_col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.confrelid = 'public.jobs'::regclass
     and c.contype = 'f'
     and array_length(c.conkey, 1) = 1
     and c.conrelid <> 'public.person_roles'::regclass;

  for g in
    select employer_id, posting_key,
           (array_agg(id order by discovered_at nulls last, id))[1] as winner,
           array_agg(id order by discovered_at nulls last, id) as ids
      from public.jobs
     where employer_id is not null and posting_key is not null
     group by employer_id, posting_key
    having count(*) > 1
  loop
    groups := groups + 1;
    foreach loser in array g.ids[2:array_length(g.ids, 1)] loop
      -- every owner of a copy gets the survivor, with what was theirs
      insert into public.person_roles (user_id, job_id, visible_since, targets_version, saved_at, hidden_reason, checked_at, match_score, match_details, is_new)
      select pr.user_id, g.winner, pr.visible_since, pr.targets_version, pr.saved_at, pr.hidden_reason, pr.checked_at, pr.match_score, pr.match_details, pr.is_new
        from public.person_roles pr
       where pr.job_id = loser
      on conflict (user_id, job_id) do update
        set saved_at = coalesce(public.person_roles.saved_at, excluded.saved_at),
            match_details = case when public.person_roles.match_score is null then excluded.match_details else public.person_roles.match_details end,
            match_score = coalesce(public.person_roles.match_score, excluded.match_score),
            is_new = public.person_roles.is_new and excluded.is_new,
            visible_since = least(public.person_roles.visible_since, excluded.visible_since);
      insert into public.person_roles (user_id, job_id, visible_since)
      select c.user_id, g.winner, coalesce(j.discovered_at, now())
        from public.jobs j
        join public.companies c on c.id = j.company_id
       where j.id = loser
      on conflict (user_id, job_id) do nothing;
      delete from public.person_roles where job_id = loser;

      ok := true;
      for i in 1 .. coalesce(array_length(fk_tbl, 1), 0) loop
        begin
          execute format('update %s set %I = $1 where %I = $2', fk_tbl[i], fk_col[i], fk_col[i]) using g.winner, loser;
          get diagnostics n = row_count;
          repointed := repointed + n;
        exception when unique_violation then
          ok := false;
        end;
      end loop;

      if ok then
        -- nothing may still point at the copy: its foreign keys mostly cascade
        for i in 1 .. coalesce(array_length(fk_tbl, 1), 0) loop
          execute format('select exists (select 1 from %s where %I = $1)', fk_tbl[i], fk_col[i]) into ok using loser;
          if ok then ok := false; exit; else ok := true; end if;
        end loop;
      end if;

      if ok then
        delete from public.jobs where id = loser;
        merged := merged + 1;
      else
        skipped := skipped + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('groups', groups, 'merged', merged, 'skipped', skipped, 'repointed', repointed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Prune: a person_roles row is not a reason to keep a role; a saved one is
-- ---------------------------------------------------------------------------

create or replace function public.prune_stale_rows()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- How long an unreferenced posting is kept after a source last listed it.
  job_ttl constant interval := '45 days';
  -- Spans are the run journal; checkpoints are only read to resume a thread.
  run_ttl constant interval := '30 days';
  keep_referenced text := '';
  fk record;
  jobs_deleted bigint;
  spans_deleted bigint;
  checkpoints_deleted bigint := 0;
  seen_deleted bigint;
  counts_deleted bigint;
begin
  -- A role anything points at stays, however old: most of those foreign keys cascade, so deleting
  -- the role would delete the application, draft or kit with it. They are read from the catalog on
  -- every run. person_roles points at every role a person can see, so it is left out of the list;
  -- a role someone saved stays by its own test.
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    keep_referenced := keep_referenced
      || format(' and not exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  keep_referenced := keep_referenced
    || ' and not exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';

  execute 'delete from public.jobs j where j.last_seen_at < now() - $1' || keep_referenced
    using job_ttl;
  get diagnostics jobs_deleted = row_count;

  delete from public.trace_spans where start_time < now() - run_ttl;
  get diagnostics spans_deleted = row_count;

  delete from public.seen_postings where last_seen_at < now() - interval '30 days';
  get diagnostics seen_deleted = row_count;

  delete from public.person_counts where day < (now() at time zone 'utc')::date - 90;
  get diagnostics counts_deleted = row_count;

  if to_regclass('langgraph.checkpoints') is not null then
    execute $q$
      with stale as (
        select thread_id::text as id from public.graph_threads
        where coalesce(last_invoked_at, created_at) < now() - $1
      ), w as (
        delete from langgraph.checkpoint_writes where thread_id in (select id from stale)
      ), b as (
        delete from langgraph.checkpoint_blobs where thread_id in (select id from stale)
      )
      delete from langgraph.checkpoints where thread_id in (select id from stale)
    $q$ using run_ttl;
    get diagnostics checkpoints_deleted = row_count;
  end if;

  return jsonb_build_object(
    'jobs', jobs_deleted, 'trace_spans', spans_deleted, 'checkpoints', checkpoints_deleted,
    'seen_postings', seen_deleted, 'person_counts', counts_deleted
  );
end;
$$;

-- evict_company_jobs and clear_unverified_board_jobs delete the roles nothing points at. A
-- person_roles row points at every role a person can see, so it no longer counts; a role someone
-- saved still does.
create or replace function public.evict_company_jobs(p_company_id uuid, p_external_ids text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; gone text[];
begin
  if p_company_id is null then
    raise exception 'company is required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_external_ids, 1), 0) = 0 then
    return '{}';
  end if;
  -- A signed-in role (the session role or the claim) must own the company; the cron and a direct psql session still pass
  -- (the fail-closed rule of 20261008032005, kept here).
  if (current_setting('role', true) = 'authenticated' or auth.jwt()->>'role' = 'authenticated')
     and not exists (select 1 from public.companies c where c.id = p_company_id and c.user_id = auth.uid()) then
    raise exception 'not your company' using errcode = '42501';
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    if fk.width <> 1 then raise exception 'multi-column foreign key on jobs from %; refusing', fk.tbl; end if;
    referenced := referenced || format(' or exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  referenced := referenced || ' or exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';
  execute 'with d as (delete from public.jobs j where j.company_id = $1 and j.external_id = any($2) and not (' || referenced || ') returning j.external_id) select coalesce(array_agg(external_id), ''{}'') from d'
    into gone using p_company_id, p_external_ids[1:200];
  return gone;
end $$;
revoke execute on function public.evict_company_jobs(uuid, text[]) from public, anon;
grant execute on function public.evict_company_jobs(uuid, text[]) to authenticated, service_role;

create or replace function public.clear_unverified_board_jobs(p_company_id uuid, p_source text)
returns table(deleted integer, closed integer)
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; n_closed integer; n_deleted integer;
begin
  if p_company_id is null or coalesce(p_source, '') = '' then
    raise exception 'company and source are required' using errcode = '22023';
  end if;
  -- A signed-in role (the session role or the claim) must own the company; the cron and a direct psql session still pass
  -- (the fail-closed rule of 20261008032005, kept here).
  if (current_setting('role', true) = 'authenticated' or auth.jwt()->>'role' = 'authenticated')
     and not exists (select 1 from public.companies c where c.id = p_company_id and c.user_id = auth.uid()) then
    raise exception 'not your company' using errcode = '42501';
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
      and c.conrelid <> 'public.person_roles'::regclass
  loop
    if fk.width <> 1 then raise exception 'multi-column foreign key on jobs from %; refusing', fk.tbl; end if;
    referenced := referenced || format(' or exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  referenced := referenced || ' or exists (select 1 from public.person_roles pr where pr.job_id = j.id and pr.saved_at is not null)';
  execute 'update public.jobs j set still_open = false, last_verified_at = now() where j.company_id = $1 and j.source = $2 and (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_closed = row_count;
  execute 'delete from public.jobs j where j.company_id = $1 and j.source = $2 and not (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_deleted = row_count;
  return query select n_deleted, n_closed;
end $$;
revoke execute on function public.clear_unverified_board_jobs(uuid, text) from public, anon;
grant execute on function public.clear_unverified_board_jobs(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Measures: T2, T3, T7, T9, T17 (and T18 from visible_since)
-- ---------------------------------------------------------------------------

-- Does a role disagree with the person's stated targets on something it states? Mirrors
-- lib/targeting/roles.ts targetVerdict for 'outside': a dimension the role does not state is not a
-- disagreement, and neither is the title (that is scored in code).
create or replace function public.role_outside_targets(
  t jsonb,
  p_function text, p_seniority text, p_country text, p_language text, p_remote boolean,
  p_title text, p_company text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  if t is null or jsonb_typeof(t) <> 'object' then return false; end if;
  if coalesce(p_company, '') <> '' then
    for k in select jsonb_array_elements_text(coalesce(t -> 'excludedCompanies', '[]'::jsonb)) loop
      if k <> '' and lower(p_company) like '%' || lower(k) || '%' then return true; end if;
    end loop;
  end if;
  for k in select jsonb_array_elements_text(coalesce(t -> 'excludedKeywords', '[]'::jsonb)) loop
    if k <> '' and lower(p_title) like '%' || lower(k) || '%' then return true; end if;
  end loop;
  if jsonb_array_length(coalesce(t -> 'functions', '[]'::jsonb)) > 0
     and coalesce(p_function, '') not in ('', 'other', 'unknown')
     and not (t -> 'functions') ? p_function then return true; end if;
  if jsonb_array_length(coalesce(t -> 'seniority', '[]'::jsonb)) > 0
     and coalesce(p_seniority, '') not in ('', 'unknown')
     and not (t -> 'seniority') ? p_seniority then return true; end if;
  if jsonb_array_length(coalesce(t -> 'countries', '[]'::jsonb)) > 0
     and coalesce(p_country, '') <> ''
     and not (t -> 'countries') ? upper(p_country) then return true; end if;
  if jsonb_array_length(coalesce(t -> 'languages', '[]'::jsonb)) > 0
     and coalesce(p_language, '') not in ('', 'unknown')
     and not (t -> 'languages') ? lower(p_language) then return true; end if;
  if (t ->> 'remoteOnly') = 'true' and p_remote is false then return true; end if;
  return false;
end;
$$;

-- Does the person state any target a role can be judged on?
create or replace function public.has_role_targets(t jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select t is not null and jsonb_typeof(t) = 'object' and (
    jsonb_array_length(coalesce(t -> 'functions', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(t -> 'seniority', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(t -> 'countries', '[]'::jsonb)) > 0
    or (t ->> 'remoteOnly') = 'true'
    or jsonb_array_length(coalesce(t -> 'languages', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(t -> 'excludedCompanies', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(t -> 'excludedKeywords', '[]'::jsonb)) > 0
  )
$$;

-- T2: roles shown older than 180 days.
create or replace function public.measure_t2()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_old integer;
  n_shown integer;
begin
  select count(*) filter (where j.posted_at < now() - interval '180 days'), count(*)
    into n_old, n_shown
    from public.person_roles pr
    join public.jobs j on j.id = pr.job_id
   where pr.hidden_reason is null and j.still_open is not false;
  return query select n_old::numeric, n_old = 0, n_shown,
    format('%s of %s shown roles are older than 180 days.', n_old, n_shown);
end;
$$;

-- T3: stored roles that are outside every one of their people's targets. People with no targets are
-- counted apart: their followed employers keep up to 200 roles each while they have set none.
create or replace function public.measure_t3()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_outside integer;
  n_roles integer;
  n_no_targets integer;
begin
  with r as (
    select pr.job_id, pr.user_id,
           public.has_role_targets(p.preferences -> 'targeting') as has_targets,
           public.role_outside_targets(p.preferences -> 'targeting', j.job_function, j.seniority, j.country, j.language, j.is_remote, j.title, c.name) as outside
      from public.person_roles pr
      join public.jobs j on j.id = pr.job_id
      join public.profiles p on p.id = pr.user_id
      left join public.companies c on c.id = j.company_id
     where pr.hidden_reason is null
  )
  select count(distinct job_id) filter (where has_targets),
         count(distinct job_id) filter (where has_targets and job_id not in (select job_id from r r2 where r2.has_targets and not r2.outside)),
         count(*) filter (where not has_targets)
    into n_roles, n_outside, n_no_targets
    from r;
  return query select n_outside::numeric, n_outside = 0, n_roles,
    format('%s of %s stored roles are outside every person''s targets. %s roles belong to people with no targets set and are counted apart.', n_outside, n_roles, n_no_targets);
end;
$$;

-- T7: rows and bytes per person after a day of checks, no-target people apart. Reported; the owner
-- sets the bar after the first week.
create or replace function public.measure_t7()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_people integer;
  max_roles integer;
  avg_roles numeric;
  max_counts integer;
  roles_mb numeric;
  body_mb numeric := 0;
begin
  select count(*), coalesce(max(c), 0), coalesce(avg(c), 0)
    into n_people, max_roles, avg_roles
    from (select count(*) as c from public.person_roles group by user_id) s;
  select coalesce(max(c), 0) into max_counts from (select count(*) as c from public.person_counts group by user_id) s;
  roles_mb := pg_total_relation_size('public.jobs') / 1048576.0;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'description_md') then
    execute 'select coalesce(sum(octet_length(description_md)), 0) / 1048576.0 from public.jobs' into body_mb;
  end if;
  return query select max_roles::numeric, null::boolean, n_people,
    format('%s people hold roles: %s on average and %s at most; at most %s count rows; the jobs table is %s MB, %s MB of it posting text.',
           n_people, round(avg_roles, 1), max_roles, max_counts, round(roles_mb, 1), round(body_mb, 1));
end;
$$;

-- T9: companies Cello followed for a person without the person's own add, plus directory rows that did not pass the verifier.
create or replace function public.measure_t9()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_leads integer;
  n_unverified integer;
  n_followed integer;
begin
  select count(*) filter (where watching and (metadata ->> 'suggested') = 'true'), count(*) filter (where watching)
    into n_leads, n_followed
    from public.companies;
  select count(*) into n_unverified from public.company_directory where verified_by is null or verified_at is null;
  return query select (n_leads + n_unverified)::numeric, (n_leads + n_unverified) = 0, n_followed,
    format('%s followed companies are leads Cello added; %s directory employers did not pass the verifier.', n_leads, n_unverified);
end;
$$;

-- T17: duplicate stored roles. Until the contract migration folds the per-person copies, one posting
-- is stored once for each person who follows its employer, so the count is reported and not judged.
create or replace function public.measure_t17()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_dupes integer;
  n_rows integer;
  folded boolean;
begin
  select count(*) into n_rows from public.jobs where employer_id is not null;
  select count(*) into n_dupes from (
    select 1 from public.jobs where employer_id is not null and posting_key is not null
     group by employer_id, posting_key having count(*) > 1
  ) s;
  folded := exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'jobs_employer_posting_key');
  return query select n_dupes::numeric, case when folded then n_dupes = 0 end, n_rows,
    case when folded then format('%s postings are stored more than once.', n_dupes)
         else format('%s postings are stored once for each person who follows the employer. The fold that makes them one row each comes with the contract migration.', n_dupes) end;
end;
$$;

-- T18 now reads when a role became visible to the person.
create or replace function public.measure_t18()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  p90 numeric;
begin
  select count(*),
         percentile_cont(0.9) within group (order by extract(epoch from (pr.visible_since - j.posted_at)) / 3600.0)
    into n, p90
    from public.person_roles pr
    join public.jobs j on j.id = pr.job_id
    join public.companies c on c.id = j.company_id and c.watching
   where j.posted_at > now() - interval '14 days'
     and pr.visible_since >= j.posted_at
     and pr.hidden_reason is null;
  if n = 0 then
    return query select null::numeric, null::boolean, 0, 'No role posted in the last 14 days has been shown yet.'::text;
    return;
  end if;
  return query select round(p90::numeric, 1), p90 <= 7, n,
    format('The 90th percentile of %s roles posted in the last 14 days, from the posting time to the person seeing it. Some providers give only a date, which reads as late.', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.companies_derive_watching() from public, anon, authenticated;
revoke all on function public.companies_link_employer() from public, anon, authenticated;
revoke all on function public.jobs_set_employer_posting() from public, anon, authenticated;
revoke all on function public.jobs_default_person_role() from public, anon, authenticated;
revoke all on function public.profiles_targets_changed() from public, anon, authenticated;
revoke all on function public.sync_person_roles(uuid, uuid, text[], integer, text[]) from public, anon;
revoke all on function public.set_person_counts(uuid, jsonb) from public, anon;
revoke all on function public.mark_seen_postings(uuid, text[]) from public, anon, authenticated;
revoke all on function public.fold_shared_postings() from public, anon, authenticated;
revoke all on function public.directory_roles_for(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.add_person_roles(uuid, uuid[], uuid[], integer) from public, anon, authenticated;
revoke all on function public.prune_stale_rows() from public, anon, authenticated;
revoke all on function public.role_outside_targets(jsonb, text, text, text, text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.has_role_targets(jsonb) from public, anon, authenticated;
revoke all on function public.measure_t2(), public.measure_t3(), public.measure_t7(), public.measure_t9(), public.measure_t17(), public.measure_t18() from public, anon, authenticated;
-- The in-app check runs as the person, so these two answer to their own session (and refuse another person's id).
grant execute on function public.sync_person_roles(uuid, uuid, text[], integer, text[]) to authenticated, service_role;
grant execute on function public.set_person_counts(uuid, jsonb) to authenticated, service_role;
grant execute on function public.mark_seen_postings(uuid, text[]) to service_role;
grant execute on function public.fold_shared_postings() to service_role;
grant execute on function public.directory_roles_for(uuid, timestamptz, integer) to service_role;
grant execute on function public.add_person_roles(uuid, uuid[], uuid[], integer) to service_role;
grant execute on function public.prune_stale_rows() to service_role;
grant execute on function public.role_outside_targets(jsonb, text, text, text, text, boolean, text, text) to service_role;
grant execute on function public.has_role_targets(jsonb) to service_role;
grant execute on function public.measure_t2(), public.measure_t3(), public.measure_t7(), public.measure_t9(), public.measure_t17(), public.measure_t18() to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.fold_shared_postings()', 'public.mark_seen_postings(uuid, text[])', 'public.prune_stale_rows()',
    'public.measure_t3()', 'public.measure_t9()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be executable by client roles', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.sync_person_roles(uuid, uuid, text[], integer, text[])', 'execute') then
    raise exception 'anon must not run sync_person_roles';
  end if;
  if exists (select 1 from public.companies where watching and (metadata ->> 'suggested') = 'true') then
    raise exception 'a lead must not be followed';
  end if;
end
$$;
