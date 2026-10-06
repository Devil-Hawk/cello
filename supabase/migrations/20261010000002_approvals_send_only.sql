-- Approvals execute one action, and only a person decides them.
--
-- WHY
--   Cello sends one thing on the person's behalf from an approval: an email, from
--   their own Gmail. Submitting an application from a stored approval, and a rule
--   deciding an approval in the person's place, are both switched off for now
--   (blueprint 5.1, "the switches"). The database says so, so no route, routine or
--   later change can quietly bring either back.
--
-- WHAT
--   approvals_r2_send_only: action = 'send_email'.
--   approvals_decided_by_person: decided_by is null or 'user'.
--   Both are added NOT VALID, so rows written before this migration are not
--   rechecked, and each is validated only when no existing row breaks it; a row
--   that does is counted in a notice and the constraint stays unvalidated, which
--   still refuses every new write.
--
-- POST-DEPLOY: apply after the code that stops inserting other actions is live.
-- Does nothing on a database that has no approvals table yet. Safe to run twice.

do $$
declare
  bad_action bigint;
  bad_decider bigint;
begin
  if to_regclass('public.approvals') is null then
    raise notice 'public.approvals does not exist yet; nothing to constrain';
    return;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'approvals_r2_send_only' and conrelid = 'public.approvals'::regclass) then
    alter table public.approvals
      add constraint approvals_r2_send_only check (action = 'send_email') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approvals_decided_by_person' and conrelid = 'public.approvals'::regclass) then
    alter table public.approvals
      add constraint approvals_decided_by_person check (decided_by is null or decided_by = 'user') not valid;
  end if;

  select count(*) into bad_action from public.approvals where action is distinct from 'send_email';
  if bad_action = 0 then
    alter table public.approvals validate constraint approvals_r2_send_only;
  else
    raise notice 'approvals_r2_send_only left unvalidated: % row(s) have another action', bad_action;
  end if;

  select count(*) into bad_decider from public.approvals where decided_by is not null and decided_by <> 'user';
  if bad_decider = 0 then
    alter table public.approvals validate constraint approvals_decided_by_person;
  else
    raise notice 'approvals_decided_by_person left unvalidated: % row(s) were decided by a rule', bad_decider;
  end if;
end
$$;
