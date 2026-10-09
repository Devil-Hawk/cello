-- profiles.resume_text is a derived mirror of the latest BASE resume version.
--
-- Studio saves never updated it, so matching, outreach and the copilot read a
-- stale resume after an edit. A trigger on resume_documents makes the mirror
-- atomic with the version write, correct under concurrent saves and applied on
-- delete too, and it covers every writer (upload, save, tailor, demo seed).
--
-- No table is created, so no grants or policies are needed. The function is
-- SECURITY INVOKER: the admin client bypasses RLS and an authenticated writer
-- already has the own-row profile update policy.

create or replace function public.sync_resume_text_mirror()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := coalesce(new.user_id, old.user_id);
  latest text;
begin
  -- Tailored rows never touch the mirror.
  if coalesce(new.job_id, old.job_id) is not null then return null; end if;
  -- Serialise base writes per user. The SELECT below is a new statement, so it
  -- takes a fresh snapshot after the lock and sees the other writer's commit.
  perform 1 from public.profiles where id = uid for update;
  select d.content into latest
    from public.resume_documents d
   where d.user_id = uid and d.job_id is null
   order by d.version desc limit 1;
  -- Deleting every base version leaves the last text in place: matching keeps
  -- working until a new resume is uploaded.
  if latest is not null then
    update public.profiles set resume_text = latest
     where id = uid and resume_text is distinct from latest;
  end if;
  return null;
end $$;

revoke all on function public.sync_resume_text_mirror() from public, anon, authenticated;

drop trigger if exists resume_documents_mirror on public.resume_documents;
create trigger resume_documents_mirror
  after insert or delete on public.resume_documents
  for each row execute function public.sync_resume_text_mirror();

-- One-time sync for existing users, whose mirror went stale on every studio edit.
update public.profiles p set resume_text = d.content
  from (select distinct on (user_id) user_id, content
          from public.resume_documents where job_id is null
         order by user_id, version desc) d
 where d.user_id = p.id and p.resume_text is distinct from d.content;
