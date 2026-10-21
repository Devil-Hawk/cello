-- companies/insights: remember when a person stopped following an employer.
--
-- "Suggested for you" leaves out an employer the person unfollowed in the last 90 days and offers it again after that
-- (lib/companies/refresh.ts). The row had no time for it: unfollow only sets watching = false. The trigger stamps the
-- time whenever watching goes from true to false, whoever writes it, and clears it when the person follows again.
-- Rows already unfollowed are stamped now, so each stays out for 90 days from this migration rather than being offered at once.

alter table public.companies add column if not exists unfollowed_at timestamptz;

create or replace function public.companies_stamp_unfollow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.watching and not new.watching then
    new.unfollowed_at := now();
  elsif new.watching then
    new.unfollowed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.companies_stamp_unfollow() from public, anon, authenticated;

drop trigger if exists companies_stamp_unfollow on public.companies;
create trigger companies_stamp_unfollow before update of watching on public.companies
  for each row execute function public.companies_stamp_unfollow();

update public.companies set unfollowed_at = now()
  where not watching and unfollowed_at is null and (metadata ->> 'suggested') is distinct from 'true';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'unfollowed_at') then
    raise exception 'companies.unfollowed_at is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'companies_stamp_unfollow' and tgrelid = 'public.companies'::regclass) then
    raise exception 'companies_stamp_unfollow is missing';
  end if;
end $$;

-- Self-check: an unfollow stamps the time and a refollow clears it. The rows are made inside a block that always rolls back.
do $$
declare
  u uuid := gen_random_uuid();
  c uuid;
  stamp timestamptz;
begin
  begin
    insert into auth.users (id, email) values (u, 'companies-unfollowed-selfcheck@example.invalid');
    insert into public.companies (user_id, name, domain, career_url, watching)
      values (u, 'Selfcheck Unfollow', 'selfcheck-unfollow.invalid', 'https://selfcheck-unfollow.invalid/careers', true)
      returning id into c;
    update public.companies set watching = false where id = c;
    select unfollowed_at into stamp from public.companies where id = c;
    if stamp is null then raise exception 'companies_stamp_unfollow: an unfollow must stamp unfollowed_at'; end if;
    update public.companies set watching = true where id = c;
    select unfollowed_at into stamp from public.companies where id = c;
    if stamp is not null then raise exception 'companies_stamp_unfollow: a refollow must clear unfollowed_at'; end if;

    raise exception 'companies_unfollowed_at self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'companies_unfollowed_at self-check passed' then raise; end if;
  end;
  if exists (select 1 from public.companies where name = 'Selfcheck Unfollow') then raise exception 'the self-check left rows behind'; end if;
end $$;

notify pgrst, 'reload schema';
