-- The backfill in 20261008050000 keyed names with a plain lower case and punctuation strip, so 'Acme, Inc.' is stored as
-- 'acme inc' while every reader and the name claim compare company_name_norm ('acme'). Give every row the one key.
-- The name claim lets exactly this rewrite through: the name is unchanged and the key is the key of that name.
create or replace function public.company_directory_name_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.source not in ('seed', 'yc') and new.name_norm <> ''
       and exists (select 1 from public.company_directory d where d.name_norm = new.name_norm and d.verified_at is not null and d.id <> new.id) then
      return null;
    end if;
  elsif old.source not in ('seed', 'yc') and not (new.name = old.name and new.name_norm = public.company_name_norm(old.name)) then
    new.name := old.name;
    new.name_norm := old.name_norm;
  end if;
  return new;
end;
$$;

update public.company_directory
   set name_norm = public.company_name_norm(name)
 where name_norm is distinct from public.company_name_norm(name);
