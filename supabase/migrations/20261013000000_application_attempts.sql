-- K13: what was sent, under its new name.
--
-- WHY
--   The table that holds "this application was submitted" was named for a word the product no
--   longer uses. It is renamed to application_attempts in the same migration that extends it, so an
--   attempt that was blocked, not confirmed or taken back has a place beside one that was sent.
--
-- EXPAND, THEN CONTRACT
--   Code deployed before this migration reads and writes application_receipts. A view of that name
--   (security_invoker, so the caller's own row policies apply) keeps it working until K20 drops the
--   view in a post-deploy migration, once no code reads the old name.
--
-- WHAT
--   - the rename, with its constraints, indexes and policies
--   - the columns an attempt needs: the posting and its employer, the values sent, the documents by
--     version, the screenshot's path, the final address, the confirmation text, the outcome, who sent
--     it, the rule in force, the extension's version and the cost
--   - application_id is kept when the application is deleted (set null), so what was sent survives
--   - the person's session may write only a row it asserts itself (manual, user_confirmed)
--   - the private bucket `attempts` for screenshots, readable by their owner
--   - interactions.ref_table renamed with it

alter table public.application_receipts rename to application_attempts;

do $$
declare
  c record;
begin
  for c in
    select conname from pg_catalog.pg_constraint
     where conrelid = 'public.application_attempts'::regclass
       and conname like 'application\_receipts\_%'
  loop
    execute format('alter table public.application_attempts rename constraint %I to %I',
                   c.conname, replace(c.conname, 'application_receipts_', 'application_attempts_'));
  end loop;
end
$$;

alter index if exists public.idx_application_receipts_application rename to idx_application_attempts_application;
alter index if exists public.idx_application_receipts_user rename to idx_application_attempts_user;

-- What was sent outlives the application it was sent for.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_catalog.pg_constraint
     where conrelid = 'public.application_attempts'::regclass
       and contype = 'f'
       and confrelid = 'public.applications'::regclass
  loop
    execute format('alter table public.application_attempts drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.application_attempts alter column application_id drop not null;
alter table public.application_attempts
  add constraint application_attempts_application_id_fkey
  foreign key (application_id) references public.applications (id) on delete set null;

alter table public.application_attempts
  add column if not exists job_id uuid,
  add column if not exists posting_url_hash text,
  add column if not exists company_name text,
  add column if not exists title text,
  -- allowlisted fields only; every other field reads {"answered_by_you": true}
  add column if not exists values_sent jsonb,
  add column if not exists resume_artifact_id uuid,
  add column if not exists resume_artifact_version integer,
  add column if not exists cover_letter_artifact_id uuid,
  add column if not exists screenshot_path text,
  add column if not exists final_url text,
  add column if not exists confirmation_text text check (char_length(confirmation_text) <= 2000),
  add column if not exists attempt_outcome text not null default 'marked'
    check (attempt_outcome in ('sent', 'unconfirmed', 'not_sent', 'marked', 'blocked', 'retracted')),
  add column if not exists sent_by text not null default 'person' check (sent_by in ('person', 'cello')),
  -- the rule and the cap in force for an automatic send
  add column if not exists send_rule jsonb,
  add column if not exists extension_version text,
  add column if not exists cost_usd numeric(10, 4);

-- Rows written before this migration: a witnessed one was sent, an asserted one was marked.
update public.application_attempts
   set attempt_outcome = case when verification_state = 'system_confirmed' then 'sent' else 'marked' end,
       sent_by = case when provenance = 'ats_direct' then 'cello' else 'person' end;

comment on table public.application_attempts is
  'One row per try at sending an application: sent, not confirmed, not sent, marked by the person, blocked or taken back. Written by the person (manual, user_confirmed) or by the server for the extension. Survives the deletion of its application.';
comment on column public.application_attempts.screenshot_path is
  'Path of the confirmation screenshot in the private bucket `attempts`, `{user_id}/{attempt id}.jpg`. confirmation_attachment_url holds the older data URLs until scripts/move-attempt-images.ts moves them.';

drop policy if exists "own receipts select" on public.application_attempts;
drop policy if exists "own receipts insert" on public.application_attempts;
drop policy if exists "own receipts update" on public.application_attempts;
drop policy if exists "own receipts delete" on public.application_attempts;

create policy attempts_select on public.application_attempts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy attempts_insert on public.application_attempts for insert to authenticated
  with check ((select auth.uid()) = user_id and provenance = 'manual' and verification_state = 'user_confirmed');
create policy attempts_update on public.application_attempts for update to authenticated
  using ((select auth.uid()) = user_id and provenance = 'manual' and verification_state = 'user_confirmed')
  with check ((select auth.uid()) = user_id and provenance = 'manual' and verification_state = 'user_confirmed');
create policy attempts_delete on public.application_attempts for delete to authenticated
  using ((select auth.uid()) = user_id and provenance = 'manual' and verification_state = 'user_confirmed');

revoke all on public.application_attempts from anon;

-- The old name, for code that has not been redeployed. Dropped by K20.
create view public.application_receipts with (security_invoker = true) as
  select * from public.application_attempts;

revoke all on public.application_receipts from anon;
grant select, insert, update, delete on public.application_receipts to authenticated, service_role;

update public.interactions set ref_table = 'application_attempts' where ref_table = 'application_receipts';

-- Screenshots: private, 256 KB, JPEG, readable by their owner. Storage cannot be written from here;
-- scripts/move-attempt-images.ts moves the older data URLs in.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('attempts', 'attempts', false, 262144, array['image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = 262144, allowed_mime_types = array['image/jpeg'];
  end if;
  if to_regclass('storage.objects') is not null then
    drop policy if exists attempts_owner_read on storage.objects;
    create policy attempts_owner_read on storage.objects for select to authenticated
      using (bucket_id = 'attempts' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
exception when insufficient_privilege then
  raise notice 'the owner-read policy on storage.objects needs the storage owner; the bucket is private and reads go through signed urls';
end
$$;

notify pgrst, 'reload schema';

do $$
begin
  if to_regclass('public.application_attempts') is null then
    raise exception 'application_attempts is missing';
  end if;
  if (select c.relkind from pg_catalog.pg_class c where c.oid = to_regclass('public.application_receipts')) is distinct from 'v' then
    raise exception 'application_receipts must be a view now';
  end if;
  if not coalesce((select 'security_invoker=true' = any (c.reloptions) from pg_catalog.pg_class c where c.oid = to_regclass('public.application_receipts')), false) then
    raise exception 'the compatibility view must be security_invoker';
  end if;
  if to_regclass('storage.buckets') is not null
     and not exists (select 1 from storage.buckets where id = 'attempts' and not public) then
    raise exception 'the private bucket attempts is missing';
  end if;
  if exists (select 1 from public.interactions where ref_table = 'application_receipts') then
    raise exception 'interactions.ref_table still names the old table';
  end if;
end
$$;
