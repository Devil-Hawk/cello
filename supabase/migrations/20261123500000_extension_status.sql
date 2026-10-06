-- PG10: the numbers the extension popup shows ("Send for me is on. 1 sent today, 2 of 3
-- tries used."). One read, in SQL, so the extension computes nothing: it shows what this
-- function says. Day starts at midnight in the person's own zone.
--
--   send_for_me  preferences.pipeline.send.mode = 'auto'
--   paused       preferences.pipeline.paused_at is set
--   cap          preferences.pipeline.send.maxPerDay, default 3, held between 1 and 10
--   tries_today  fill.auto_started events since the day began (a claim is a try)
--   sent_today   submission.sent events from the extension since the day began
--
-- pipeline_events arrives with the pipeline package; until it exists the counts are 0.
-- ponytail: the zone is read from preferences.timezone, then preferences.pipeline.timezone,
-- then UTC. Point it at the settings package's one zone field when that lands.

create or replace function public.extension_status(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $fn$
declare
  v_prefs jsonb;
  v_pipe jsonb;
  v_send jsonb;
  v_zone text;
  v_since timestamptz;
  v_tries integer := 0;
  v_sent integer := 0;
begin
  select preferences into v_prefs from public.profiles where id = p_user;
  v_pipe := coalesce(v_prefs -> 'pipeline', '{}'::jsonb);
  v_send := coalesce(v_pipe -> 'send', '{}'::jsonb);

  v_zone := coalesce(nullif(v_prefs ->> 'timezone', ''), nullif(v_pipe ->> 'timezone', ''), 'UTC');
  begin
    v_since := date_trunc('day', now() at time zone v_zone) at time zone v_zone;
  exception when others then
    v_since := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  end;

  if to_regclass('public.pipeline_events') is not null then
    execute
      'select count(*) filter (where kind = ''fill.auto_started''),
              count(*) filter (where kind = ''submission.sent'' and actor = ''extension'')
         from public.pipeline_events
        where user_id = $1 and created_at >= $2'
      into v_tries, v_sent
      using p_user, v_since;
  end if;

  return jsonb_build_object(
    'send_for_me', coalesce(v_send ->> 'mode', '') = 'auto',
    'paused', coalesce(v_pipe ->> 'paused_at', '') <> '',
    'sent_today', v_sent,
    'tries_today', v_tries,
    'cap', least(10, greatest(1, coalesce(case when (v_send ->> 'maxPerDay') ~ '^[0-9]{1,4}$' then (v_send ->> 'maxPerDay')::integer end, 3)))
  );
end
$fn$;

revoke all on function public.extension_status(uuid) from public, anon, authenticated;
grant execute on function public.extension_status(uuid) to service_role;

notify pgrst, 'reload schema';
