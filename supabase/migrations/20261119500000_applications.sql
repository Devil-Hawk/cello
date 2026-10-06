-- PG5: What is working. T33 (each finding's counts equal the hand counts, unconfirmed events move nothing, nothing is
-- shown below its threshold, a Keep changes only what it names) gates the release now that the page is built; its
-- fixture run is written by apps/web/scripts/network-measures.ts `fixtures`.

update public.measures set state = 'gating' where id = 'T33';

do $$
begin
  if not exists (select 1 from public.measures where id = 'T33' and state = 'gating') then
    raise exception 'T33 must be gating';
  end if;
end
$$;
