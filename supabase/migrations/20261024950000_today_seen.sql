-- When the person last looked at Today, for "Since you were last here".
--
-- touch_today_seen() stamps the time and hands back the time before it, in one
-- statement, so Today shows what changed since the last visit and the next visit
-- starts from now. It is the only writer: security definer, so no column grant
-- on profiles is needed or given. Small, additive, pre-deploy.

alter table public.profiles add column if not exists today_seen_at timestamptz;

create or replace function public.touch_today_seen()
returns timestamptz
language sql
volatile
security definer
set search_path = public
as $$
  update public.profiles p
     set today_seen_at = now()
    from (select today_seen_at as prev from public.profiles where id = auth.uid()) o
   where p.id = auth.uid()
  returning o.prev
$$;

revoke execute on function public.touch_today_seen() from public, anon;
grant execute on function public.touch_today_seen() to authenticated;
