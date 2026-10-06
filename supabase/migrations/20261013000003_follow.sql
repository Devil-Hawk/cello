-- K13: following a company has one writer.
--
-- WHY
--   `companies.watching` is what the person follows. Send for me, the checks every six hours and the
--   directory read it, so only the person's own act may set it: not Gmail, not Find, not an agent,
--   not a script. K5a kept the column in step with a lead flag while the old writers existed; with
--   one writer that trigger goes, and a company is followed only when companies_follow says so.
--
-- WHAT
--   - the derive trigger is dropped; watching defaults to false; followed_at records when
--   - companies_watching_guard: turning watching on outside companies_follow raises, for every role
--   - companies_follow(ids, on, user, pin): the one writer. A session acts on its own rows; the
--     server passes the person. At most 5 pins, on followed companies only
--   - measure_t9 now counts a followed company with no followed_at (a write that skipped the
--     function) plus directory rows that did not pass the verifier

alter table public.companies add column if not exists followed_at timestamptz;

-- Everything followed before this migration was followed by its person (K5a's backfill kept leads out).
update public.companies set followed_at = created_at where watching and followed_at is null;

drop trigger if exists companies_derive_watching on public.companies;
drop function if exists public.companies_derive_watching();

alter table public.companies alter column watching set default false;

-- A person deletes a company that holds nothing Cello worked on and nothing sent. The employer is the
-- shared record; what was sent survives either way (the events outlive the application), but a delete
-- here would take the application and its timeline's subject with it.
drop policy if exists "Users can delete own companies" on public.companies;
create policy "Users can delete own companies" on public.companies for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and not exists (
      select 1
        from public.jobs j
        join public.applications a on a.job_id = j.id and a.user_id = companies.user_id
       where j.company_id = companies.id
         and (a.state is not null
              or exists (select 1 from public.pipeline_events e where e.application_id = a.id and e.kind like 'submission.%'))
    )
  );

create or replace function public.companies_watching_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.watching and (tg_op = 'INSERT' or not old.watching)
     and coalesce(current_setting('cello.follow_writer', true), '') <> 'on' then
    raise exception 'Only companies_follow follows a company.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists companies_watching_guard on public.companies;
create trigger companies_watching_guard
  before insert or update of watching on public.companies
  for each row execute function public.companies_watching_guard();

-- p_ids   the companies, all the caller's own
-- p_on    follow (true) or stop following (false)
-- p_user  the person, passed by the server; a session acts on itself and may not name another
-- p_pin   pin (true) or unpin (false) a followed company; null leaves pins alone
create or replace function public.companies_follow(p_ids uuid[], p_on boolean, p_user uuid default null, p_pin boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n integer := 0;
  pins integer;
begin
  if uid is not null and p_user is not null and p_user <> uid then
    raise exception 'A person follows only for themselves.' using errcode = '42501';
  end if;
  uid := coalesce(uid, p_user);
  if uid is null then
    raise exception 'Say whose companies these are.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));

  -- A pin is checked before anything changes: followed companies only, and at most 5 in all.
  if p_pin then
    if p_on is not true and exists (select 1 from public.companies where id = any (p_ids) and user_id = uid and not watching) then
      return public.pipeline_refuse('not_followed', 'Pin only the companies you follow.');
    end if;
    select count(*) into pins from public.companies
     where user_id = uid and (is_dream_company or id = any (p_ids));
    if pins > 5 then
      return public.pipeline_refuse('pin_cap', 'You can pin up to 5 companies.');
    end if;
  end if;

  perform set_config('cello.follow_writer', 'on', true);
  if p_on is not null then
    update public.companies
       set watching = p_on,
           followed_at = case when p_on then coalesce(followed_at, now()) else null end
     where id = any (p_ids) and user_id = uid and watching is distinct from p_on;
    get diagnostics n = row_count;
  end if;
  perform set_config('cello.follow_writer', 'off', true);

  if p_pin is not null then
    update public.companies set is_dream_company = p_pin where id = any (p_ids) and user_id = uid;
  end if;

  return jsonb_build_object('ok', true, 'changed', n);
end;
$$;

-- T9: companies followed without the function (watching with no followed_at), plus directory rows that
-- did not pass the verifier. Both are 0 by construction; the number shows it.
create or replace function public.measure_t9()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_unfollowed integer;
  n_unverified integer;
  n_followed integer;
begin
  select count(*) filter (where watching and followed_at is null), count(*) filter (where watching)
    into n_unfollowed, n_followed
    from public.companies;
  select count(*) into n_unverified from public.company_directory where verified_by is null or verified_at is null;
  return query select (n_unfollowed + n_unverified)::numeric, (n_unfollowed + n_unverified) = 0, n_followed,
    format('%s followed companies were not followed through companies_follow; %s directory employers did not pass the verifier.', n_unfollowed, n_unverified);
end;
$$;

revoke all on function public.companies_watching_guard() from public, anon, authenticated;
revoke all on function public.companies_follow(uuid[], boolean, uuid, boolean) from public, anon;
grant execute on function public.companies_follow(uuid[], boolean, uuid, boolean) to authenticated, service_role;
revoke all on function public.measure_t9() from public, anon, authenticated;
grant execute on function public.measure_t9() to service_role;

notify pgrst, 'reload schema';

do $$
declare
  r uuid;
  refused boolean := false;
begin
  if has_function_privilege('anon', 'public.companies_follow(uuid[], boolean, uuid, boolean)', 'execute') then
    raise exception 'anon must not follow';
  end if;
  select id into r from public.companies where not watching limit 1;
  if r is not null then
    begin
      update public.companies set watching = true where id = r;
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then
      raise exception 'watching = true outside companies_follow must raise';
    end if;
  end if;
  if exists (select 1 from public.companies where watching and followed_at is null) then
    raise exception 'every followed company has a followed_at';
  end if;
end
$$;
