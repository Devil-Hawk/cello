-- Proves K17's migrations (20261017000000 expand, 20261017000001 contract):
--   * the copy moves every resume bucket and version (ids kept), cover letter, drafted answers,
--     dossier and outreach message into `artifacts` once: counts equal per source;
--   * a second run inserts nothing;
--   * exactly one base resume per person, and the mirror follows it;
--   * between expand and contract an old-named row and a new-named row both exist; after the
--     contract no row holds an old name and the check refuses them;
--   * a message's text reads the same through its artifact version as on its own row (the
--     send that started on the old text reads the same words);
--   * resume_documents is read-only for the service role once the contract has run.
-- The harness applies every migration before it runs a check, so this file puts the expand
-- state back (the expand file is safe to run again) and then runs the contract on it.
-- One transaction, rolled back.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/learning_writer_k17.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as
select gen_random_uuid() as user_id, gen_random_uuid() as other_id, gen_random_uuid() as company_id, gen_random_uuid() as job_id,
       gen_random_uuid() as base1, gen_random_uuid() as base2, gen_random_uuid() as tailored1,
       gen_random_uuid() as draft_id, gen_random_uuid() as dossier_id, gen_random_uuid() as message_id;
insert into auth.users (id, email) select user_id, 'k17@example.invalid' from fx union all select other_id, 'k17-other@example.invalid' from fx;
insert into public.profiles (id, email) select user_id, 'k17@example.invalid' from fx union all select other_id, 'k17-other@example.invalid' from fx on conflict (id) do nothing;
update public.profiles set resume_text = 'text only resume' where id = (select other_id from fx);
insert into public.companies (id, user_id, name, career_url) select company_id, user_id, 'K17 Check', 'https://example.invalid/jobs' from fx;
insert into public.jobs (id, company_id, title, description, url, external_id) select job_id, company_id, 'k17 role', 'd', 'https://x/k17', 'k17-1' from fx;

-- The old stores as they were.
insert into public.resume_documents (id, user_id, job_id, version, title, content, source)
select base1, user_id, null::uuid, 1, 'Base', 'base one', 'base' from fx
union all select base2, user_id, null::uuid, 2, 'Base', 'base two', 'edited' from fx
union all select tailored1, user_id, job_id, 1, 'Tailored', 'tailored one', 'tailored' from fx;
insert into public.application_drafts (id, user_id, job_id, cover_letter, answers)
select draft_id, user_id, job_id, 'Dear team, I am writing about the k17 role.', '{"visa": "no"}'::jsonb from fx;
insert into public.company_dossiers (id, company_id, user_id, summary, sponsors_visa) select dossier_id, company_id, user_id, 'Builds checks.', 'likely' from fx;
insert into public.outreach_messages (id, user_id, job_id, company_id, to_email, to_name, subject, body)
select message_id, user_id, job_id, company_id, 'dana@example.invalid', 'Dana', 'Hello from k17', 'Hi Dana, a short note.' from fx;

-- Back to the expand state (both names allowed), then run the copy.
\ir ../migrations/20261017000000_made_things_expand.sql

do $$
declare f record;
begin
  select * into f from fx;
  assert (select count(*) from public.artifacts where user_id = f.user_id and type = 'resume') = 2, 'two resume buckets: base and tailored';
  assert (select count(*) from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id where a.user_id = f.user_id and a.type = 'resume') = 3, 'three resume versions';
  assert exists (select 1 from public.artifact_versions where id = f.base2), 'a resume version keeps the id it had';
  assert (select current_version from public.artifacts where user_id = f.user_id and is_base) = 2, 'the base artifact is at version 2';
  assert (select count(*) from public.artifacts where user_id = f.user_id and is_base) = 1, 'one base resume';
  assert (select resume_text from public.profiles where id = f.user_id) = 'base two', 'the mirror follows the base resume';
  assert (select count(*) from public.artifacts where user_id = f.user_id and type = 'cover_letter') = 1, 'the cover letter is copied';
  assert (select count(*) from public.artifacts where user_id = f.user_id and type = 'answers') = 1, 'the answers are copied';
  assert (select count(*) from public.artifacts where user_id = f.user_id and type = 'research' and company_id = f.company_id) = 1, 'the dossier is copied as research';
  assert (select count(*) from public.artifacts where user_id = f.user_id and type = 'message') = 1, 'the message is copied';
  -- A person with only profiles.resume_text gets a base resume with that text.
  assert (select v.content_text from public.artifacts a join public.artifact_versions v on v.artifact_id = a.id where a.user_id = f.other_id and a.is_base) = 'text only resume', 'text-only person gets a base artifact';
  -- The text reads the same through the version as on the row.
  assert (select v.content_text from public.outreach_messages o join public.artifact_versions v on v.artifact_id = o.artifact_id and v.version = o.artifact_version where o.id = f.message_id)
       = E'To: Dana <dana@example.invalid>\nSubject: Hello from k17\n\nHi Dana, a short note.', 'the message reads the same through its version';
end $$;

-- A second run writes nothing.
create temp table before_run as select (select count(*) from public.artifacts) as a, (select count(*) from public.artifact_versions) as v;
\ir ../migrations/20261017000000_made_things_expand.sql
do $$
begin
  assert (select a from before_run) = (select count(*) from public.artifacts), 'a second run must add no artifact';
  assert (select v from before_run) = (select count(*) from public.artifact_versions), 'a second run must add no version';
end $$;

-- Exactly one base resume per person.
do $$
declare f record;
begin
  select * into f from fx;
  begin
    insert into public.artifacts (user_id, type, title, is_base) values (f.user_id, 'resume', 'Second base', true);
    raise exception 'a second base resume was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Between expand and contract both names list and open.
do $$
declare f record;
begin
  select * into f from fx;
  insert into public.artifacts (user_id, type, title) values (f.user_id, 'outreach_email', 'old name'), (f.user_id, 'message', 'new name');
  assert (select count(*) from public.artifacts where user_id = f.user_id and type in ('outreach_email', 'message') and title in ('old name', 'new name')) = 2, 'both names are stored while expanding';
end $$;

-- The contract.
\ir ../migrations/20261017000001_made_things_contract.sql

do $$
declare f record;
begin
  select * into f from fx;
  assert not exists (select 1 from public.artifacts where type in ('outreach_email', 'dossier')), 'no row holds an old name after the contract';
  assert (select type from public.artifacts where user_id = f.user_id and title = 'old name') = 'message', 'the old-named row now reads as message';
  begin
    insert into public.artifacts (user_id, type, title) values (f.user_id, 'dossier', 'refused');
    raise exception 'the old name was accepted after the contract';
  exception when check_violation then null;
  end;
  assert not has_table_privilege('service_role', 'public.resume_documents', 'insert'), 'resume_documents must be read-only';
  assert has_table_privilege('service_role', 'public.resume_documents', 'select'), 'resume_documents stays readable';
  raise notice 'ALL K17 ASSERTIONS PASSED';
end $$;

rollback;
