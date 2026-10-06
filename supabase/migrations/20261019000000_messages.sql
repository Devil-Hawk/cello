-- K19: what the inbox read, and who wrote it.
--
-- messages: one row per mail that was about a job. Bodies are never stored: the subject is cut to 200
-- characters and the excerpt to 600 (the first lines), and "Read all" fetches the mail from Gmail when it
-- is opened. Every row carries how far to trust it (trust) and what the sender's DKIM check said
-- (header_verdict), both set by code. A model's sort of the mail (kind, employer) carries its origin and
-- prov, and a Confirm sets confirmed_at while keeping origin 'model'.
--
-- contacts: the kind of person, and the employer or agency they work for, with where each came from.
--
-- measure_t6: hours since the last successful mail read, per connected person.
--
-- The session reads its own rows; every write is the sync (service role).

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  gmail_message_id text not null,
  thread_id text,
  -- null while the mail has no application (a found application waiting for Confirm, a recruiter thread)
  application_id uuid references public.applications (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  direction text not null default 'in' check (direction in ('in', 'out')),
  sent_at timestamptz not null,
  from_domain text,
  subject text not null default '' check (char_length(subject) <= 200),
  -- the first lines; null on rows the network sync writes from headers alone
  excerpt text check (char_length(excerpt) <= 600),
  kind text not null default 'other' check (kind in ('applied', 'rejection', 'interview', 'offer', 'recruiter', 'reply', 'other')),
  origin text not null default 'code' check (origin in ('code', 'model', 'person')),
  prov jsonb,
  confirmed_at timestamptz,
  trust text not null default 'unconfirmed' check (trust in ('person', 'proven', 'confirmed', 'unconfirmed')),
  -- {domain, dkim} from Authentication-Results
  header_verdict jsonb,
  -- the employer the mail is from or about, and who said so
  employer_id uuid references public.company_directory (id) on delete set null,
  employer_origin text check (employer_origin in ('code', 'model', 'person')),
  employer_prov jsonb,
  job_title text check (char_length(job_title) <= 200),
  created_at timestamptz not null default now(),
  unique (user_id, gmail_message_id)
);

create index if not exists messages_user_sent_idx on public.messages (user_id, sent_at desc);
create index if not exists messages_application_idx on public.messages (application_id) where application_id is not null;
-- the found applications waiting for the person's Confirm
create index if not exists messages_found_idx on public.messages (user_id) where application_id is null and kind = 'applied' and trust = 'proven';

alter table public.messages enable row level security;
drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages for select to authenticated using (user_id = auth.uid());
revoke all on public.messages from public, anon, authenticated;
grant select on public.messages to authenticated;
grant all on public.messages to service_role;

alter table public.contacts
  add column if not exists kind text check (kind in ('recruiter', 'agency_recruiter', 'hiring_manager', 'referrer', 'other')),
  add column if not exists employer_id uuid references public.company_directory (id) on delete set null,
  add column if not exists agency_name text check (char_length(agency_name) <= 200),
  add column if not exists employer_origin text check (employer_origin in ('code', 'model', 'person')),
  add column if not exists employer_prov jsonb;

-- T6: hours since the last successful mail read, per connected person; the worst one is the number.
-- inbox.sync writes a job_heartbeats row per person (job 'inbox.sync', user_id the person's).
create or replace function public.measure_t6()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_people integer;
  worst numeric;
  n_late integer;
begin
  select count(*),
         max(extract(epoch from (now() - coalesce(h.succeeded_at, h.started_at))) / 3600.0),
         count(*) filter (where extract(epoch from (now() - coalesce(h.succeeded_at, h.started_at))) / 3600.0 > 2)
    into n_people, worst, n_late
    from public.job_heartbeats h
   where h.job = 'inbox.sync' and h.user_id is not null;
  if n_people = 0 then
    return query select null::numeric, null::boolean, 0, 'No one has a mail read yet.'::text;
    return;
  end if;
  return query select
    round(worst, 2),
    worst <= 2,
    n_people,
    format('%s of %s connected people have gone more than 2 hours without a successful mail read.', n_late, n_people);
end;
$$;
revoke all on function public.measure_t6() from public, anon, authenticated;
grant execute on function public.measure_t6() to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if has_table_privilege('authenticated', 'public.messages', 'insert')
     or has_table_privilege('authenticated', 'public.messages', 'update')
     or has_table_privilege('authenticated', 'public.messages', 'delete') then
    raise exception 'the session must not write messages';
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.contacts'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%agency_recruiter%') then
    raise exception 'the contacts kind check is missing';
  end if;
end
$$;
