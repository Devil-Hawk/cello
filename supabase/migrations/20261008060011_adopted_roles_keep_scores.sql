-- A role the read adopts keeps the score and details it already had (blueprint R2: a shared row shows the last scorer's
-- value, and a person can already overwrite it through the match route). Only the rest of what a person wrote is cleared.
create or replace function public.jobs_clear_on_adopt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.apply_url := null;
  new.description_md := null;
  new.description_md5 := null;
  new.description_state := null;
  new.description_source := null;
  new.role_type := null;
  new.type_origin := null;
  new.type_prov := null;
  new.discovered_at := now();
  new.still_open := true;
  new.closed_at := null;
  new.missed_checks := 0;
  new.last_verified_at := null;
  new.legit_label := null;
  return new;
end;
$$;
