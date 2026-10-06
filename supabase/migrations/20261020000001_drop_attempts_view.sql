-- K20, POST-DEPLOY: drop the compatibility view that kept the old name for what was sent.
--
-- K13 renamed application_receipts to application_attempts and left a view under the old name so the
-- code that was still live kept working through the deploy. Apply this file only after the new code is
-- live and a source scan shows nothing outside the migrations reads the old name
-- (apps/web/lib/needs-you/needs-you.test.ts holds that scan).

drop view if exists public.application_receipts;

do $$
begin
  if to_regclass('public.application_receipts') is not null then
    raise exception 'the old name is still there';
  end if;
  if to_regclass('public.application_attempts') is null then
    raise exception 'the attempts table is missing';
  end if;
end
$$;
