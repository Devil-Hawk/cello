-- K17 made things, one store: the expand half (blueprint 3.3).
--
-- Everything Cello makes for a person becomes a row in `artifacts` with numbered versions:
-- resumes (the base one and each tailored one), cover letters, answers drafted for a form,
-- messages, research, comparisons, kept answers and shortlists. This file widens the store,
-- copies what the older tables hold into it, and links the older rows to the copies. It does
-- not remove anything: the deploy that follows reads and writes `artifacts` first, and
-- 20261017000001 (the contract, applied after that deploy) retires the old names and makes
-- `resume_documents` read-only.
--
-- Safe to run twice. Every copied row carries idempotency_key 'k17:<table>:<id>', so a second
-- run inserts nothing, and the postconditions at the end check the counts per source.
--
-- Origin and prov on the copied rows: K11 adds those columns and maps `author` onto them in its
-- own file, which covers these rows too. This file does not guess at columns that are not here.

-- ---------------------------------------------------------------------------
-- 1. The type set, widened to both names (expand), and the columns the one store needs.
-- ---------------------------------------------------------------------------
alter table public.artifacts drop constraint if exists artifacts_type_check;
alter table public.artifacts add constraint artifacts_type_check check (type in (
  'resume', 'cover_letter', 'answers', 'message', 'research', 'comparison', 'answer', 'shortlist',
  'outreach_email', 'dossier'
));

alter table public.artifacts add column if not exists about jsonb not null default '[]'::jsonb;
alter table public.artifacts add column if not exists application_id uuid references public.applications (id) on delete set null;
alter table public.artifacts add column if not exists is_base boolean not null default false;

-- Each person has at most one base resume.
create unique index if not exists uq_artifacts_one_base_per_user on public.artifacts (user_id) where is_base;
create index if not exists idx_artifacts_application on public.artifacts (application_id) where application_id is not null;

-- A resume version keeps one id for its whole life, so every URL and every
-- applications.resume_version value that names a resume_documents id stays valid.
alter table public.artifact_versions add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.artifact_versions'::regclass and conname = 'artifact_versions_id_key') then
    alter table public.artifact_versions add constraint artifact_versions_id_key unique (id);
  end if;
end
$$;

-- A message's text lives on its artifact version. The row keeps who, approval, sending and reply,
-- and still mirrors the text in its own columns until the readers that use them have moved.
alter table public.outreach_messages add column if not exists artifact_id uuid references public.artifacts (id) on delete set null;
alter table public.outreach_messages add column if not exists artifact_version int;

-- Two older columns point at resume_documents ids (resume_claims.resume_document_id,
-- application_drafts.resume_document_id). A version written from now on lives on artifact_versions
-- and carries a new id, so those pointers can no longer be foreign keys. The ids of copied versions
-- are unchanged, so every existing pointer still names the same version.
do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint where contype = 'f' and confrelid = 'public.resume_documents'::regclass loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The profiles.resume_text mirror follows the base resume artifact.
--    (The resume_documents trigger stays until the contract.)
-- ---------------------------------------------------------------------------
create or replace function public.sync_resume_text_from_artifacts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  aid uuid := coalesce(new.artifact_id, old.artifact_id);
  uid uuid;
  latest text;
begin
  select a.user_id into uid from public.artifacts a where a.id = aid and a.is_base;
  if uid is null then return null; end if;
  -- Serialise base writes per person, then read the newest version in a fresh snapshot.
  perform 1 from public.profiles where id = uid for update;
  select v.content_text into latest from public.artifact_versions v where v.artifact_id = aid order by v.version desc limit 1;
  -- Deleting every version leaves the last text in place: matching keeps working until a new resume arrives.
  if latest is not null then
    update public.profiles set resume_text = latest where id = uid and resume_text is distinct from latest;
  end if;
  return null;
end
$$;
revoke all on function public.sync_resume_text_from_artifacts() from public, anon, authenticated;

drop trigger if exists artifact_versions_resume_mirror on public.artifact_versions;
create trigger artifact_versions_resume_mirror
  after insert or delete on public.artifact_versions
  for each row execute function public.sync_resume_text_from_artifacts();

-- ---------------------------------------------------------------------------
-- 3. The copy. Each block is one source table, keyed so a rerun writes nothing.
-- ---------------------------------------------------------------------------

-- 3a. Resumes: one artifact per (person, job) bucket, its versions in order, ids preserved.
insert into public.artifacts (user_id, type, title, job_id, current_version, is_base, idempotency_key, created_at, updated_at)
select b.user_id, 'resume',
       case when b.job_id is null then 'Base resume' else left('Resume for ' || coalesce(j.title, 'a role'), 200) end,
       b.job_id, b.last_version, b.job_id is null,
       'k17:resume_documents:' || b.user_id || ':' || coalesce(b.job_id::text, 'base'),
       b.first_at, b.last_at
from (
  select user_id, job_id, max(version) as last_version, min(created_at) as first_at, max(coalesce(updated_at, created_at)) as last_at
  from public.resume_documents
  group by user_id, job_id
) b
left join public.jobs j on j.id = b.job_id
on conflict (user_id, idempotency_key) do nothing;

insert into public.artifact_versions (id, artifact_id, version, author, content, content_text, created_at)
select d.id, a.id, d.version, case when d.source = 'tailored' then 'cello' else 'user' end,
       jsonb_build_object('text', d.content, 'content_json', d.content_json, 'title', d.title, 'ats_score', d.ats_score, 'source', d.source, 'draft_id', d.draft_id),
       d.content, d.created_at
from public.resume_documents d
join public.artifacts a on a.user_id = d.user_id
  and a.idempotency_key = 'k17:resume_documents:' || d.user_id || ':' || coalesce(d.job_id::text, 'base')
on conflict (artifact_id, version) do nothing;

-- 3b. A person with only profiles.resume_text gets a base resume with that text as version 1.
with only_text as (
  select p.id as user_id, p.resume_text
  from public.profiles p
  where nullif(btrim(coalesce(p.resume_text, '')), '') is not null
    and not exists (select 1 from public.resume_documents d where d.user_id = p.id and d.job_id is null)
    and not exists (select 1 from public.artifacts a where a.user_id = p.id and a.is_base)
), made as (
  insert into public.artifacts (user_id, type, title, current_version, is_base, idempotency_key)
  select user_id, 'resume', 'Base resume', 1, true, 'k17:profiles:resume_text:' || user_id from only_text
  on conflict (user_id, idempotency_key) do nothing
  returning id, user_id
)
insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select m.id, 1, 'user', jsonb_build_object('text', o.resume_text, 'source', 'base'), o.resume_text
from made m join only_text o on o.user_id = m.user_id
on conflict (artifact_id, version) do nothing;

-- 3c. Cover letters and drafted answers from application_drafts.
with src as (
  select d.id, d.user_id, d.job_id, d.cover_letter, d.created_at, d.updated_at, j.title as job_title
  from public.application_drafts d left join public.jobs j on j.id = d.job_id
  where nullif(btrim(coalesce(d.cover_letter, '')), '') is not null
), made as (
  insert into public.artifacts (user_id, type, title, job_id, current_version, idempotency_key, created_at, updated_at)
  select user_id, 'cover_letter', left('Cover letter for ' || coalesce(job_title, 'a role'), 200), job_id, 1, 'k17:application_drafts:cover_letter:' || id, created_at, updated_at
  from src
  on conflict (user_id, idempotency_key) do nothing
  returning id, user_id, idempotency_key
)
insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select m.id, 1, 'cello', jsonb_build_object('text', s.cover_letter), s.cover_letter
from made m join src s on m.idempotency_key = 'k17:application_drafts:cover_letter:' || s.id
on conflict (artifact_id, version) do nothing;

with src as (
  select d.id, d.user_id, d.job_id, d.answers, d.created_at, d.updated_at, j.title as job_title
  from public.application_drafts d left join public.jobs j on j.id = d.job_id
  where d.answers is not null and d.answers <> 'null'::jsonb and d.answers <> '{}'::jsonb
), made as (
  insert into public.artifacts (user_id, type, title, job_id, current_version, idempotency_key, created_at, updated_at)
  select user_id, 'answers', left('Answers for ' || coalesce(job_title, 'a role'), 200), job_id, 1, 'k17:application_drafts:answers:' || id, created_at, updated_at
  from src
  on conflict (user_id, idempotency_key) do nothing
  returning id, user_id, idempotency_key
)
insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select m.id, 1, 'cello', jsonb_build_object('answers', s.answers), jsonb_pretty(s.answers)
from made m join src s on m.idempotency_key = 'k17:application_drafts:answers:' || s.id
on conflict (artifact_id, version) do nothing;

-- 3d. Company dossiers as research.
with src as (
  select d.id, d.user_id, d.company_id, d.summary, d.sponsors_visa, d.sources, d.created_at, d.refreshed_at, c.name as company
  from public.company_dossiers d join public.companies c on c.id = d.company_id
), made as (
  insert into public.artifacts (user_id, type, title, company_id, current_version, idempotency_key, created_at, updated_at)
  select user_id, 'research', left('Research on ' || company, 200), company_id, 1, 'k17:company_dossiers:' || id, created_at, coalesce(refreshed_at, created_at)
  from src
  on conflict (user_id, idempotency_key) do nothing
  returning id, user_id, idempotency_key
)
insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select m.id, 1, 'cello',
       jsonb_build_object('company', s.company, 'summary', s.summary, 'sponsors_visa', s.sponsors_visa, 'sources', coalesce(s.sources, '[]'::jsonb), 'dossier_id', s.id),
       '# ' || s.company || E'\n\n' || coalesce(s.summary, 'No summary yet. Public signals were collected.')
from made m join src s on m.idempotency_key = 'k17:company_dossiers:' || s.id
on conflict (artifact_id, version) do nothing;

-- 3e. Outreach messages as messages, then link each row to its copy.
with src as (
  select o.id, o.user_id, o.job_id, o.company_id, o.contact_id, o.subject, o.body, o.to_email, o.to_name, o.kind, o.created_at, o.updated_at
  from public.outreach_messages o
), made as (
  insert into public.artifacts (user_id, type, title, job_id, company_id, contact_id, current_version, idempotency_key, created_at, updated_at)
  select user_id, 'message', left(subject, 200), job_id, company_id, contact_id, 1, 'k17:outreach_messages:' || id, created_at, updated_at
  from src
  on conflict (user_id, idempotency_key) do nothing
  returning id, user_id, idempotency_key
)
insert into public.artifact_versions (artifact_id, version, author, content, content_text)
select m.id, 1, 'cello',
       jsonb_build_object('subject', s.subject, 'body', s.body, 'to_name', s.to_name, 'to_email', s.to_email, 'outreach_id', s.id, 'kind', s.kind),
       case when s.to_name is not null then 'To: ' || s.to_name || ' <' || s.to_email || E'>\n' else '' end || 'Subject: ' || s.subject || E'\n\n' || s.body
from made m join src s on m.idempotency_key = 'k17:outreach_messages:' || s.id
on conflict (artifact_id, version) do nothing;

update public.outreach_messages o
   set artifact_id = a.id, artifact_version = 1
  from public.artifacts a
 where a.user_id = o.user_id and a.idempotency_key = 'k17:outreach_messages:' || o.id and o.artifact_id is null;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 4. Postconditions: counts equal per source, one base resume per person with a resume.
-- ---------------------------------------------------------------------------
do $$
declare n_src bigint; n_copy bigint;
begin
  select count(*) into n_src from (select distinct user_id, job_id from public.resume_documents) x;
  select count(*) into n_copy from public.artifacts where idempotency_key like 'k17:resume_documents:%';
  if n_src <> n_copy then raise exception 'resume buckets: % in resume_documents, % copied', n_src, n_copy; end if;

  select count(*) into n_src from public.resume_documents;
  select count(*) into n_copy from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id where a.idempotency_key like 'k17:resume_documents:%';
  if n_src <> n_copy then raise exception 'resume versions: % in resume_documents, % copied', n_src, n_copy; end if;

  select count(*) into n_src from public.application_drafts where nullif(btrim(coalesce(cover_letter, '')), '') is not null;
  select count(*) into n_copy from public.artifacts where idempotency_key like 'k17:application_drafts:cover_letter:%';
  if n_src <> n_copy then raise exception 'cover letters: % in application_drafts, % copied', n_src, n_copy; end if;

  select count(*) into n_src from public.application_drafts where answers is not null and answers <> 'null'::jsonb and answers <> '{}'::jsonb;
  select count(*) into n_copy from public.artifacts where idempotency_key like 'k17:application_drafts:answers:%';
  if n_src <> n_copy then raise exception 'answers: % in application_drafts, % copied', n_src, n_copy; end if;

  select count(*) into n_src from public.company_dossiers;
  select count(*) into n_copy from public.artifacts where idempotency_key like 'k17:company_dossiers:%';
  if n_src <> n_copy then raise exception 'dossiers: % in company_dossiers, % copied', n_src, n_copy; end if;

  select count(*) into n_src from public.outreach_messages;
  select count(*) into n_copy from public.artifacts where idempotency_key like 'k17:outreach_messages:%';
  if n_src <> n_copy then raise exception 'messages: % in outreach_messages, % copied', n_src, n_copy; end if;
  if exists (select 1 from public.outreach_messages where artifact_id is null) then
    raise exception 'an outreach message is not linked to its copy';
  end if;

  if exists (
    select 1 from public.profiles p
    where (nullif(btrim(coalesce(p.resume_text, '')), '') is not null or exists (select 1 from public.resume_documents d where d.user_id = p.id))
      and not exists (select 1 from public.artifacts a where a.user_id = p.id and a.is_base)
  ) then
    raise exception 'a person with a resume has no base resume artifact';
  end if;
end
$$;
