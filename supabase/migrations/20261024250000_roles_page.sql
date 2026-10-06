-- Roles: two more reasons for Not for me, and group counts in SQL.
--
-- Not for me offers eight reasons (Level, Location, Relocation, Role type,
-- Company, Pay, Agency, Other). The two the constraint did not hold, level and
-- role_type, are added beside the ten it has (apps/web/lib/scoring/types.ts
-- PASS_REASONS carries the same list).
--
-- role_counts(p_by) is where every group header on Roles gets its number, so a
-- header can never disagree with the rows it stands over: it counts the
-- person's own visible roles that are still open, by employer (the directory
-- row when there is one, else the person's own company row), or what a read
-- found outside the person's targets in the last seven days, by reason. It runs
-- as the caller, so the row level security of person_roles and person_counts
-- is what keeps one person's numbers from another.
--
-- The role_type grouping counts the same rows by the type the person sees: their own
-- word for the title (person_roles.role_type, Change type) over the posting's type
-- (jobs.role_type, K5c). A role with no type is not counted under any.

do $$
begin
  if to_regclass('public.person_roles') is null or to_regclass('public.role_reactions') is null then
    raise exception 'roles_page needs K5a (person_roles) and K8a (role_reactions)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'person_roles' and column_name = 'role_type') then
    raise exception 'roles_page needs K5c (person_roles.role_type)';
  end if;
end $$;

alter table public.role_reactions drop constraint if exists role_reactions_reason_values;
alter table public.role_reactions add constraint role_reactions_reason_values
  check (reason is null or reason in ('too_junior', 'too_senior', 'company', 'domain', 'location', 'relocation', 'agency', 'sponsorship', 'pay', 'other', 'level', 'role_type'));

create or replace function public.role_counts(p_by text)
returns table (key text, n bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_by = 'employer' then
    return query
      select coalesce(j.employer_id, j.company_id)::text, count(*)::bigint
        from public.person_roles pr
        join public.jobs j on j.id = pr.job_id
       where pr.user_id = (select auth.uid())
         and pr.hidden_reason is null
         and (j.posted_at is null or j.posted_at >= now() - interval '180 days')
         and j.still_open is not false
         and coalesce(j.employer_id, j.company_id) is not null
       group by 1;
  elsif p_by = 'role_type' then
    return query
      select coalesce(pr.role_type, j.role_type), count(*)::bigint
        from public.person_roles pr
        join public.jobs j on j.id = pr.job_id
       where pr.user_id = (select auth.uid())
         and pr.hidden_reason is null
         and (j.posted_at is null or j.posted_at >= now() - interval '180 days')
         and j.still_open is not false
         and coalesce(pr.role_type, j.role_type) is not null
       group by 1;
  elsif p_by = 'outside_week' then
    return query
      select pc.reason, sum(pc.n)::bigint
        from public.person_counts pc
       where pc.user_id = (select auth.uid())
         and pc.kind = 'outside_targets'
         and pc.day >= current_date - 6
       group by pc.reason;
  else
    raise exception 'role_counts: unknown grouping %', p_by using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.role_counts(text) from public, anon;
grant execute on function public.role_counts(text) to authenticated;
