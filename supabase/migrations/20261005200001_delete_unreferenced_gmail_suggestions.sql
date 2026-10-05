-- Gmail sync used to insert a "suggested" company for every sender it could not
-- match, and the Companies page listed them beside the ones the person added.
-- About half were wrong: recruiters' names, job titles, mail relays. Sync no
-- longer creates companies; this removes what it already wrote.
--
-- A company that anything references stays. Most of those foreign keys cascade,
-- so deleting the company would delete jobs, applications, contacts, drafts and
-- kits with it. The references are read from the catalog when the function
-- runs, so a table added later is covered without editing this file.

create or replace function public.delete_unreferenced_gmail_suggestions()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  keep text := '';
  fk record;
  n integer;
begin
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, array_length(c.conkey, 1) as width
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.companies'::regclass and c.contype = 'f'
  loop
    -- A composite key cannot be guarded by one column. Stop rather than guess.
    if fk.width <> 1 then
      raise exception 'multi-column foreign key on companies from %; refusing to delete', fk.tbl;
    end if;
    keep := keep || format(' and not exists (select 1 from %s r where r.%I = c.id)', fk.tbl, fk.col);
  end loop;

  execute 'delete from public.companies c'
    || ' where c.metadata->>''source'' = ''gmail'' and c.metadata->>''suggested'' = ''true'''
    || keep;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Housekeeping, not an API: a function in public is callable over PostgREST
-- unless EXECUTE is taken away.
revoke execute on function public.delete_unreferenced_gmail_suggestions() from public, anon, authenticated;

select public.delete_unreferenced_gmail_suggestions();
