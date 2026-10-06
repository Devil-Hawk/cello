-- A company holds at most 200 open roles. When a role inside the person's
-- targets arrives and the company is full, the sync names the lowest-ranked
-- stored roles to make room for it. This deletes the ones nothing points at
-- (an application, draft, kit, outreach, match...), read from the catalog like
-- clear_unverified_board_jobs, and leaves the rest alone. It returns the
-- external ids it deleted, so the caller inserts no more rows than it freed.
create or replace function public.evict_company_jobs(p_company_id uuid, p_external_ids text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; gone text[];
begin
  if p_company_id is null then
    raise exception 'company is required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_external_ids, 1), 0) = 0 then
    return '{}';
  end if;
  -- The cron (service role, or a direct psql session with no JWT) may evict for any company; a signed-in user only their own.
  if coalesce(auth.jwt()->>'role', 'service_role') <> 'service_role'
     and not exists (select 1 from public.companies c where c.id = p_company_id and c.user_id = auth.uid()) then
    raise exception 'not your company' using errcode = '42501';
  end if;
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.jobs'::regclass and c.contype = 'f'
  loop
    if fk.width <> 1 then raise exception 'multi-column foreign key on jobs from %; refusing', fk.tbl; end if;
    referenced := referenced || format(' or exists (select 1 from %s r where r.%I = j.id)', fk.tbl, fk.col);
  end loop;
  execute 'with d as (delete from public.jobs j where j.company_id = $1 and j.external_id = any($2) and not (' || referenced || ') returning j.external_id) select coalesce(array_agg(external_id), ''{}'') from d'
    into gone using p_company_id, p_external_ids[1:200];
  return gone;
end $$;
revoke execute on function public.evict_company_jobs(uuid, text[]) from public, anon;
grant execute on function public.evict_company_jobs(uuid, text[]) to authenticated, service_role;
