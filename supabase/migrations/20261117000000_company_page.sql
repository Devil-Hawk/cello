-- PG7 Company (blueprint 4.7): keeping one role the person opened from an employer's live list.
--
-- The Company page reads an employer's whole board live and stores nothing. A role is stored only when the person
-- acts on it (Interested, Apply, Save or Change type): keep_company_role writes the posting once for the employer
-- (the same upsert the directory sweep uses) and gives the person one person_roles row marked via = 'company'.
-- Doing it twice leaves one jobs row and one person_roles row. A role the person passed on (not_for_me) stays passed.
--
-- Service role only: the page's action calls it after it has checked who is asking, and the function refuses a
-- session that names another person. No table, so nothing for the ownership lists.

do $$
begin
  if to_regprocedure('public.upsert_employer_jobs(uuid, jsonb)') is null then
    raise exception 'company_page needs K6 (upsert_employer_jobs)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'person_roles' and column_name = 'via') then
    raise exception 'company_page needs K5c (person_roles.via)';
  end if;
end $$;

create or replace function public.keep_company_role(p_user uuid, p_employer uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := coalesce(p_row ->> 'external_id', '');
  v_job uuid;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user then
    raise exception 'not your roles' using errcode = '42501';
  end if;
  if not exists (select 1 from public.company_directory d where d.id = p_employer and d.verified_at is not null) then
    raise exception 'not a verified employer' using errcode = '22023';
  end if;
  if btrim(v_key) = '' then
    raise exception 'a posting needs its own key' using errcode = '22023';
  end if;

  perform public.upsert_employer_jobs(p_employer, jsonb_build_array(p_row));
  select j.id into v_job from public.jobs j where j.employer_id = p_employer and j.posting_key = v_key;
  if v_job is null then
    raise exception 'the posting was not stored' using errcode = '22023';
  end if;

  insert into public.person_roles (user_id, job_id, via)
  values (p_user, v_job, 'company')
  on conflict (user_id, job_id) do update set via = coalesce(public.person_roles.via, 'company');
  return v_job;
end;
$$;

revoke execute on function public.keep_company_role(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.keep_company_role(uuid, uuid, jsonb) to service_role;
