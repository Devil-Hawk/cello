-- Planted failing check. run.sh must exit non-zero on this file.
-- It sits in fixtures/ so the default run does not pick it up.
begin;

do $$
begin
  assert false, 'planted check: run.sh must fail on this';
end $$;

rollback;
