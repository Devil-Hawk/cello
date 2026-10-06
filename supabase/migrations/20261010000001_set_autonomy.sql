-- Autonomy is written one way only: the person, through set_autonomy().
--
-- WHY
--   "Send for me" and the rules around it live under profiles.preferences.pipeline.
--   preferences is one jsonb column the owner of the row can update over the Data
--   API, and the service role can update it too. A rule that decides whether Cello
--   may act without asking cannot sit somewhere a script or a confused deputy can
--   rewrite it. So the database refuses any change to that one key unless it
--   comes through set_autonomy(), which only a signed-in person's own session can
--   run.
--
-- WHAT
--   set_autonomy(p_pipeline jsonb): uses auth.uid(), refuses a demo, marks the
--   transaction as the autonomy writer and replaces preferences.pipeline. Execute
--   is granted to authenticated only; it is revoked from public, anon and
--   service_role, so the service-role client cannot call it.
--   guard_preferences_pipeline: a before insert or update trigger on profiles
--   that raises when preferences -> 'pipeline' changes and the transaction is not
--   the autonomy writer. It applies to every role. A write that leaves pipeline
--   as it was (the settings routes rewrite the whole column) passes.
--
-- Safe to run twice.

create or replace function public.guard_preferences_pipeline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('cello.autonomy_writer', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if (new.preferences -> 'pipeline') is not null then
      raise exception 'preferences.pipeline is written only by set_autonomy()'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.preferences -> 'pipeline') is distinct from (old.preferences -> 'pipeline') then
    raise exception 'preferences.pipeline is written only by set_autonomy()'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_preferences_pipeline on public.profiles;
create trigger guard_preferences_pipeline
  before insert or update on public.profiles
  for each row execute function public.guard_preferences_pipeline();

create or replace function public.set_autonomy(p_pipeline jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null then
    raise exception 'set_autonomy requires a signed-in caller'
      using errcode = 'insufficient_privilege';
  end if;
  if p_pipeline is null or jsonb_typeof(p_pipeline) <> 'object' then
    raise exception 'set_autonomy takes a json object';
  end if;
  if exists (select 1 from public.profiles where id = uid and coalesce(is_demo, false)) then
    raise exception 'Demo workspaces cannot change this.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Local to this transaction: the trigger reads it and nothing else sets it.
  perform set_config('cello.autonomy_writer', 'on', true);
  update public.profiles
  set preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{pipeline}', p_pipeline, true)
  where id = uid
  returning preferences -> 'pipeline' into result;
  perform set_config('cello.autonomy_writer', '', true);

  return result;
end;
$$;

revoke execute on function public.set_autonomy(jsonb) from public, anon, service_role;
grant execute on function public.set_autonomy(jsonb) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'guard_preferences_pipeline'
      and tgrelid = 'public.profiles'::regclass
      and not tgisinternal
  ) then
    raise exception 'guard_preferences_pipeline is missing on public.profiles';
  end if;
  if has_function_privilege('service_role', 'public.set_autonomy(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.set_autonomy(jsonb)', 'execute') then
    raise exception 'set_autonomy must not be executable by service_role or anon';
  end if;
  if not has_function_privilege('authenticated', 'public.set_autonomy(jsonb)', 'execute') then
    raise exception 'set_autonomy must be executable by authenticated';
  end if;
end
$$;
