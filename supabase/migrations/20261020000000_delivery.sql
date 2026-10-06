-- K20: delivery. What was told to the person, so it is never told twice, and where to tell them.
--
-- notification_log: one row per (person, kind, subject): an application, a question, a day. The unique key
-- is the whole guarantee: a second delivery of the same thing is refused by the database, so a retry, a
-- second tab or two clock ticks cannot email or push the same thing twice.
--
-- push_subscriptions: the browsers that said yes to web push. The endpoint is unique; the keys never
-- leave the server.
--
-- Both: the session reads its own rows, every write is the server (service role).

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- 'summary', 'push', 'email', or an alert's kind
  kind text not null check (char_length(kind) between 1 and 60),
  -- what it was about: an application id, a question id, a day (2026-10-06)
  subject_id text not null check (char_length(subject_id) between 1 and 200),
  channel text not null default 'email' check (channel in ('email', 'push', 'in_app')),
  sent_at timestamptz not null default now(),
  unique (user_id, kind, subject_id)
);

create index if not exists notification_log_user_sent_idx on public.notification_log (user_id, sent_at desc);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 2000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.notification_log enable row level security;
alter table public.push_subscriptions enable row level security;
drop policy if exists notification_log_select_own on public.notification_log;
create policy notification_log_select_own on public.notification_log for select to authenticated using (user_id = auth.uid());
drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());

revoke all on public.notification_log, public.push_subscriptions from public, anon, authenticated;
-- the keys of a subscription are not for the browser to read back
grant select (id, user_id, endpoint, created_at) on public.push_subscriptions to authenticated;
grant select on public.notification_log to authenticated;
grant all on public.notification_log, public.push_subscriptions to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if has_table_privilege('authenticated', 'public.notification_log', 'insert')
     or has_table_privilege('authenticated', 'public.push_subscriptions', 'insert')
     or has_table_privilege('authenticated', 'public.push_subscriptions', 'update')
     or has_table_privilege('authenticated', 'public.push_subscriptions', 'delete') then
    raise exception 'the session must not write the delivery tables';
  end if;
  if has_column_privilege('authenticated', 'public.push_subscriptions', 'auth', 'select')
     or has_column_privilege('authenticated', 'public.push_subscriptions', 'p256dh', 'select') then
    raise exception 'the session must not read push keys back';
  end if;
end
$$;
