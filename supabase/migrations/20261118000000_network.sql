-- K26: the people the search is about.
--
-- People live on contacts, grown: where the address came from (employer, personal or agency), when it was first
-- seen, and the person's own follow-up rule. contact_applications ties a person to the applications their mail is
-- about; contact_profiles holds public search results, never a page Cello opened. contact_touch is a view over
-- messages: last in touch and who spoke last are computed, never stored.
--
-- Existing duplicate addresses are merged first, and the migration stops if the counts do not add up.
-- Additive otherwise. Every write below the session's reach goes through the service role.

alter table public.contacts
  add column if not exists address_kind text check (address_kind in ('employer', 'personal', 'agency')),
  add column if not exists first_seen_at timestamptz,
  add column if not exists nudge jsonb;

-- ---------------------------------------------------------------------------
-- one row per address: merge the duplicates, then forbid new ones
-- ---------------------------------------------------------------------------

do $$
declare
  before_n bigint;
  after_n bigint;
  expected bigint;
  fk record;
begin
  select count(*) into before_n from public.contacts;
  select coalesce(sum(n - 1), 0) into expected
    from (select count(*) as n from public.contacts where email is not null group by user_id, lower(email) having count(*) > 1) d;

  if expected > 0 then
    create temp table _dup on commit drop as
      select id, first_value(id) over (partition by user_id, lower(email) order by created_at, id) as keep_id
        from public.contacts where email is not null;
    delete from _dup where id = keep_id;

    -- the kept row takes the newest touch, the first value of each field and every distinct note
    update public.contacts k set
      last_contact_at = greatest(k.last_contact_at, (select max(c.last_contact_at) from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id)),
      title = coalesce(k.title, (select c.title from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id and c.title is not null order by c.created_at limit 1)),
      linkedin_url = coalesce(k.linkedin_url, (select c.linkedin_url from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id and c.linkedin_url is not null order by c.created_at limit 1)),
      kind = coalesce(k.kind, (select c.kind from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id and c.kind is not null order by c.created_at limit 1)),
      employer_id = coalesce(k.employer_id, (select c.employer_id from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id and c.employer_id is not null order by c.created_at limit 1)),
      notes = (
        select string_agg(distinct n, E'\n\n') from (
          select k.notes as n where k.notes is not null and k.notes <> ''
          union
          select c.notes from public.contacts c join _dup d on d.id = c.id where d.keep_id = k.id and c.notes is not null and c.notes <> ''
        ) s)
    where k.id in (select keep_id from _dup);

    -- every single-column reference follows the kept row
    for fk in
      select cl.oid::regclass::text as tbl, a.attname as col
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       where con.contype = 'f' and con.confrelid = 'public.contacts'::regclass and array_length(con.conkey, 1) = 1
    loop
      execute format('update %s t set %I = d.keep_id from _dup d where t.%I = d.id', fk.tbl, fk.col, fk.col);
    end loop;

    delete from public.contacts where id in (select id from _dup);
  end if;

  select count(*) into after_n from public.contacts;
  if before_n - after_n <> expected then
    raise exception 'contacts merge: expected to remove %, removed %', expected, before_n - after_n;
  end if;
  if exists (select 1 from public.contacts where email is not null group by user_id, lower(email) having count(*) > 1) then
    raise exception 'contacts merge: duplicate addresses remain';
  end if;
end
$$;

create unique index if not exists contacts_user_email_key on public.contacts (user_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- contact_applications: the applications a person's mail is about
-- ---------------------------------------------------------------------------

create table if not exists public.contact_applications (
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  application_id uuid not null references public.applications (id) on delete cascade,
  origin text not null default 'code' check (origin in ('code', 'person')),
  created_at timestamptz not null default now(),
  primary key (contact_id, application_id)
);
create index if not exists contact_applications_application_idx on public.contact_applications (application_id);
create index if not exists contact_applications_user_idx on public.contact_applications (user_id);

alter table public.contact_applications enable row level security;
drop policy if exists contact_applications_select_own on public.contact_applications;
create policy contact_applications_select_own on public.contact_applications for select to authenticated using (user_id = auth.uid());
drop policy if exists contact_applications_insert_own on public.contact_applications;
create policy contact_applications_insert_own on public.contact_applications for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.contacts c where c.id = contact_id and c.user_id = auth.uid())
    and exists (select 1 from public.applications a where a.id = application_id and a.user_id = auth.uid()));
drop policy if exists contact_applications_delete_own on public.contact_applications;
create policy contact_applications_delete_own on public.contact_applications for delete to authenticated using (user_id = auth.uid());
revoke all on public.contact_applications from public, anon, authenticated;
grant select, insert, delete on public.contact_applications to authenticated;
grant all on public.contact_applications to service_role;

-- ---------------------------------------------------------------------------
-- contact_profiles: public search results as the tool returned them
-- ---------------------------------------------------------------------------

create table if not exists public.contact_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  url text not null,
  host text not null,
  title text check (char_length(title) <= 200),
  snippet text check (char_length(snippet) <= 400),
  query text,
  provider text,
  rank integer,
  origin text not null default 'code' check (origin in ('code', 'model', 'person')),
  prov jsonb,
  state text not null default 'proposed' check (state in ('proposed', 'kept', 'rejected')),
  found_at timestamptz not null default now()
);
create index if not exists contact_profiles_contact_idx on public.contact_profiles (contact_id);
create unique index if not exists contact_profiles_one_kept on public.contact_profiles (contact_id) where state = 'kept';

alter table public.contact_profiles enable row level security;
drop policy if exists contact_profiles_select_own on public.contact_profiles;
create policy contact_profiles_select_own on public.contact_profiles for select to authenticated using (user_id = auth.uid());
revoke all on public.contact_profiles from public, anon, authenticated;
grant select on public.contact_profiles to authenticated;
grant all on public.contact_profiles to service_role;

-- ---------------------------------------------------------------------------
-- messages: a row a memory cites is kept while the memory is
-- ---------------------------------------------------------------------------

alter table public.messages add column if not exists cited boolean not null default false;
create index if not exists messages_contact_idx on public.messages (contact_id, sent_at desc) where contact_id is not null;

-- ---------------------------------------------------------------------------
-- contact_touch: per person, from messages and "Mark contacted today"
-- ---------------------------------------------------------------------------

create or replace view public.contact_touch with (security_invoker = true) as
with m as (
  select contact_id,
         max(sent_at) filter (where direction = 'out') as last_out,
         max(sent_at) filter (where direction = 'in') as last_in,
         count(*) filter (where direction = 'out') as sent_n,
         count(*) filter (where direction = 'in') as received_n,
         count(distinct thread_id) as threads_n
    from public.messages
   where contact_id is not null
   group by contact_id
), t as (
  select c.id as contact_id, c.user_id,
         c.name, c.email, c.title, c.kind, c.address_kind, c.employer_id, c.agency_name, c.relationship, c.last_contact_at, c.first_seen_at, c.created_at,
         greatest(m.last_out, c.last_contact_at) as last_yours_at,
         m.last_in as last_theirs_at,
         coalesce(m.sent_n, 0) as sent_n,
         coalesce(m.received_n, 0) as received_n,
         coalesce(m.threads_n, 0) as threads_n
    from public.contacts c
    left join m on m.contact_id = c.id
)
select contact_id, user_id,
       name, email, title, kind, address_kind, employer_id, agency_name, relationship, last_contact_at, first_seen_at, created_at,
       greatest(last_yours_at, last_theirs_at) as last_at,
       case when last_yours_at is null and last_theirs_at is null then null
            when last_theirs_at is null or last_yours_at >= last_theirs_at then 'you'
            else 'them' end as last_from,
       last_yours_at,
       last_theirs_at,
       case when last_yours_at is null and last_theirs_at is null then 'none'
            when last_theirs_at is null or last_yours_at >= last_theirs_at then 'them'
            else 'you' end as waiting_on,
       sent_n, received_n, threads_n
  from t;
grant select on public.contact_touch to authenticated;
grant select on public.contact_touch to service_role;

-- ---------------------------------------------------------------------------
-- the follow-up rule: one atomic write, so it never races another preferences write
-- ---------------------------------------------------------------------------

create or replace function public.set_network_rule(p_user uuid, p_contact uuid, p_rule jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  clean jsonb := '{}'::jsonb;
begin
  if p_contact is not null and p_rule = 'null'::jsonb then
    update public.contacts set nudge = null where id = p_contact and user_id = p_user;
    return;
  end if;
  if jsonb_typeof(p_rule) <> 'object' then
    raise exception 'the follow-up rule must be an object';
  end if;
  for k, v in select * from jsonb_each(p_rule) loop
    if k = 'after_yours_bd' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) or (v #>> '{}')::numeric not between 1 and 30 then
        raise exception 'days after your message must be a whole number from 1 to 30';
      end if;
    elsif k = 'after_theirs_d' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) or (v #>> '{}')::numeric not between 1 and 14 then
        raise exception 'days after their reply must be a whole number from 1 to 14';
      end if;
    elsif k in ('on', 'off') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
      if (k = 'on') <> (p_contact is null) then raise exception '% does not apply here', k; end if;
    elsif k = 'snooze_until' then
      if jsonb_typeof(v) = 'string' then perform (v #>> '{}')::date; elsif jsonb_typeof(v) <> 'null' then raise exception 'snooze_until must be a date'; end if;
    else
      raise exception 'unknown follow-up setting %', k;
    end if;
    clean := clean || jsonb_build_object(k, v);
  end loop;

  if p_contact is null then
    update public.profiles set preferences = jsonb_set(
      jsonb_set(coalesce(preferences, '{}'::jsonb), '{network}', coalesce(preferences -> 'network', '{}'::jsonb), true),
      '{network,nudge}', coalesce(preferences #> '{network,nudge}', '{}'::jsonb) || clean, true)
     where id = p_user;
  else
    update public.contacts set nudge = coalesce(nudge, '{}'::jsonb) || clean where id = p_contact and user_id = p_user;
  end if;
end;
$$;
revoke all on function public.set_network_rule(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_network_rule(uuid, uuid, jsonb) to service_role;

-- main's outreach "days before a follow-up" moves in once
update public.profiles
   set preferences = jsonb_set(
     jsonb_set(preferences, '{network}', coalesce(preferences -> 'network', '{}'::jsonb), true),
     '{network,nudge}',
     jsonb_build_object('on', true, 'after_yours_bd', least(30, greatest(1, (preferences #>> '{outreach,followUpDays}')::numeric::int)), 'after_theirs_d', 2), true)
 where preferences #> '{network,nudge}' is null
   and preferences #>> '{outreach,followUpDays}' ~ '^[0-9]+(\.[0-9]+)?$';

-- ---------------------------------------------------------------------------
-- messages older than 400 days go, unless a memory cites them
-- ---------------------------------------------------------------------------

create or replace function public.prune_messages()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  delete from public.messages where sent_at < now() - interval '400 days' and not cited;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.prune_messages() from public, anon, authenticated;
grant execute on function public.prune_messages() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('messages-prune', '41 4 * * *', 'select public.prune_messages()');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- switches and measures
-- ---------------------------------------------------------------------------

insert into public.instance_flags (key, "on", note) values
  ('network_sync_live', true, 'on: network.sync reads people from mail headers; off if T30 or T31 fail on the owner''s marks'),
  ('network_profiles_live', false, 'off: profiles are produced for the owner only until S25 passes'),
  ('network_memory_live', false, 'off: memories are produced for the owner only until S26 passes')
on conflict (key) do nothing;

update public.measures set state = 'gating' where id in ('T30', 'T31', 'T32', 'S18', 'S25', 'S26');

notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'contacts_user_email_key') then
    raise exception 'the unique address index is missing';
  end if;
  if has_table_privilege('authenticated', 'public.contact_profiles', 'insert')
     or has_table_privilege('authenticated', 'public.contact_profiles', 'update') then
    raise exception 'the session must not write contact_profiles';
  end if;
  if not exists (select 1 from pg_class where relname = 'contact_touch' and reloptions::text like '%security_invoker=true%') then
    raise exception 'contact_touch must be security_invoker';
  end if;
  if has_function_privilege('authenticated', 'public.set_network_rule(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.prune_messages()', 'execute') then
    raise exception 'the session must not run the follow-up rule or the prune';
  end if;
end
$$;
