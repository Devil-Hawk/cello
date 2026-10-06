-- Command slots: one atomic counter behind every limit a command names.
--
-- WHY
--   lib/search/rate-limit.ts counts in the memory of one function instance, so
--   two instances give a person twice the limit, and a restart gives it back.
--   Chat, the assistant, other agents and routines all draw on limits per door
--   (heavy work per 10 minutes, drafts a day, research a day). One upsert that
--   counts and compares in the same statement keeps those limits true however
--   many instances answer.
--
-- WHAT
--   command_slots holds one row per person, door, bucket and window. The window
--   start is the epoch floored to the window length, so a window is a fixed
--   slice of time and never slides. take_command_slot adds one, returns whether
--   the new count is still within the limit, and drops that person's rows older
--   than two days so the table stays small. Only the service role can run it.
--
-- Safe to run twice.

create table if not exists public.command_slots (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (char_length(channel) <= 40),
  bucket text not null check (char_length(bucket) <= 60),
  window_start timestamptz not null,
  n integer not null default 0,
  primary key (user_id, channel, bucket, window_start)
);

alter table public.command_slots enable row level security;
revoke all on public.command_slots from public, anon, authenticated;
grant all on public.command_slots to service_role;

create or replace function public.take_command_slot(
  p_user uuid,
  p_channel text,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  w timestamptz;
  used integer;
begin
  if p_user is null or p_limit is null or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'take_command_slot needs a person, a limit and a window';
  end if;

  delete from public.command_slots
  where user_id = p_user and window_start < now() - interval '2 days';

  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.command_slots as s (user_id, channel, bucket, window_start, n)
  values (p_user, p_channel, p_bucket, w, 1)
  on conflict (user_id, channel, bucket, window_start)
  do update set n = s.n + 1
  returning s.n into used;

  return used <= p_limit;
end;
$$;

revoke execute on function public.take_command_slot(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_command_slot(uuid, text, text, integer, integer) to service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.take_command_slot(uuid, text, text, integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.take_command_slot(uuid, text, text, integer, integer)', 'execute') then
    raise exception 'take_command_slot must be executable by service_role only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.command_slots'::regclass) then
    raise exception 'RLS is off on public.command_slots';
  end if;
end
$$;
