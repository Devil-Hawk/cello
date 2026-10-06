-- K17 made things, one store: the contract half (blueprint 3.3, 14.1).
--
-- Apply only after the deploy that writes `artifacts` first and reads both names through
-- lib/artifacts/types.ts is live, so nothing deployed still reads the old shape.
--
--   * the two renames finish: outreach_email becomes message, dossier becomes research, and
--     the type check allows only the new set;
--   * `resume_documents` becomes read-only history: every writer now appends a version to
--     the base or tailored resume artifact, and the profiles.resume_text mirror follows
--     `artifact_versions` (20261017000000), so the older trigger goes;
--   * `application_drafts` stays writable. Its status machine (approve, reject, submit) is still
--     the apply flow's record until the pipeline work replaces it; its text already lives on
--     artifacts and is written there first.

update public.artifacts set type = 'message' where type = 'outreach_email';
update public.artifacts set type = 'research' where type = 'dossier';

alter table public.artifacts drop constraint if exists artifacts_type_check;
alter table public.artifacts add constraint artifacts_type_check check (type in (
  'resume', 'cover_letter', 'answers', 'message', 'research', 'comparison', 'answer', 'shortlist'
));

drop trigger if exists resume_documents_mirror on public.resume_documents;
drop function if exists public.sync_resume_text_mirror();

revoke insert, update, delete on public.resume_documents from authenticated, service_role;

notify pgrst, 'reload schema';

do $$
begin
  if exists (select 1 from public.artifacts where type in ('outreach_email', 'dossier')) then
    raise exception 'a made thing still holds an old type name';
  end if;
  if has_table_privilege('service_role', 'public.resume_documents', 'insert')
     or has_table_privilege('service_role', 'public.resume_documents', 'update')
     or has_table_privilege('service_role', 'public.resume_documents', 'delete')
     or has_table_privilege('authenticated', 'public.resume_documents', 'insert') then
    raise exception 'resume_documents must be read-only';
  end if;
  if exists (select 1 from public.artifacts where is_base group by user_id having count(*) > 1) then
    raise exception 'a person has more than one base resume';
  end if;
end
$$;
