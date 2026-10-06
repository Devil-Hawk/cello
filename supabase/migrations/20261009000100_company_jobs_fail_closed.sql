-- evict_company_jobs and clear_unverified_board_jobs bypass RLS, so their owner
-- check is the only fence. It used to treat a missing JWT claim as the service
-- role. Now a signed-in role (by the session role or the claim) must own the
-- company; the cron and a direct psql session still pass. A null auth.uid()
-- fails the exists() test. create or replace keeps the grants.
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
  if (current_setting('role', true) = 'authenticated' or auth.jwt()->>'role' = 'authenticated')
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

create or replace function public.clear_unverified_board_jobs(p_company_id uuid, p_source text)
returns table(deleted integer, closed integer)
language plpgsql security definer set search_path = ''
as $$
declare referenced text := 'false'; fk record; n_closed integer; n_deleted integer;
begin
  if p_company_id is null or coalesce(p_source, '') = '' then
    raise exception 'company and source are required' using errcode = '22023';
  end if;
  if (current_setting('role', true) = 'authenticated' or auth.jwt()->>'role' = 'authenticated')
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
  execute 'update public.jobs j set still_open = false, last_verified_at = now() where j.company_id = $1 and j.source = $2 and (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_closed = row_count;
  execute 'delete from public.jobs j where j.company_id = $1 and j.source = $2 and not (' || referenced || ')'
    using p_company_id, p_source;
  get diagnostics n_deleted = row_count;
  return query select n_deleted, n_closed;
end $$;
