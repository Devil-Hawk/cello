-- Rows that hold something a model wrote remember where it came from.
--
-- A person approves, edits, skips, applies or replies days after Cello wrote
-- something. To score that on the generation that wrote it, the row needs the
-- Langfuse trace id (32 hex) and observation id (16 hex) of the call, and,
-- where the person can edit the text, what the model first wrote so the edit
-- can be measured. All columns are nullable: rows made before this, template
-- fallbacks and traces that were not exported have none.
--
-- No new table, policy or grant: the columns sit on tables that already have
-- row level security and owner-scoped policies.

alter table public.outreach_messages
  add column if not exists trace_id text check (trace_id ~ '^[0-9a-f]{32}$'),
  add column if not exists observation_id text check (observation_id ~ '^[0-9a-f]{16}$'),
  add column if not exists generated_subject text,
  add column if not exists generated_body text;

alter table public.application_drafts
  add column if not exists trace_id text check (trace_id ~ '^[0-9a-f]{32}$'),
  add column if not exists observation_id text check (observation_id ~ '^[0-9a-f]{16}$'),
  add column if not exists generated_cover_letter text,
  add column if not exists generated_resume_summary text;

-- A role's assessment is the person's own, so its trace sits on their person_roles row.
-- lane-stub: K5a person_roles
do $stub$
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, trace columns skipped';
    return;
  end if;
  alter table public.person_roles
    add column if not exists trace_id text check (trace_id ~ '^[0-9a-f]{32}$'),
    add column if not exists observation_id text check (observation_id ~ '^[0-9a-f]{16}$');
  comment on column public.person_roles.trace_id is 'Langfuse trace of the call that assessed this role for this person, so later outcomes can be scored on it.';
end
$stub$;

comment on column public.outreach_messages.generated_body is 'What the model wrote, kept so edits can be measured.';
comment on column public.outreach_messages.generated_subject is 'What the model wrote, kept so edits can be measured.';
comment on column public.application_drafts.generated_cover_letter is 'What the model wrote, kept so edits can be measured.';
comment on column public.application_drafts.generated_resume_summary is 'What the model wrote, kept so edits can be measured.';
comment on column public.outreach_messages.trace_id is 'Langfuse trace of the call that wrote this row, so later outcomes can be scored on it.';
comment on column public.application_drafts.trace_id is 'Langfuse trace of the call that wrote this row, so later outcomes can be scored on it.';

do $$
declare
  missing text;
begin
  select string_agg(t || '.' || c, ', ') into missing
  from (values
    ('outreach_messages', 'trace_id'), ('outreach_messages', 'observation_id'),
    ('outreach_messages', 'generated_subject'), ('outreach_messages', 'generated_body'),
    ('application_drafts', 'trace_id'), ('application_drafts', 'observation_id'),
    ('application_drafts', 'generated_cover_letter'), ('application_drafts', 'generated_resume_summary'),
    ('person_roles', 'trace_id'), ('person_roles', 'observation_id')
  ) as want(t, c)
  where (want.t <> 'person_roles' or to_regclass('public.person_roles') is not null) -- lane-stub: K5a person_roles
    and not exists (
    select 1 from information_schema.columns i
    where i.table_schema = 'public' and i.table_name = want.t and i.column_name = want.c
  );
  if missing is not null then
    raise exception 'feedback_ids: missing columns %', missing;
  end if;
end
$$;

notify pgrst, 'reload schema';
