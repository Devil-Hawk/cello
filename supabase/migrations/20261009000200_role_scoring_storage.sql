-- Storage for the personal shortlist: what the person said about each role they
-- were shown, what Cello concluded about a role for them, and the daily list.
--
-- The old model wrote one integer to jobs.match_score and every reader treated
-- it as the truth. It could not hold a stated reason for hiding a role, a
-- learned taste, or evidence for a chance judgement.
--
-- A role (a row of jobs) is one posting that many people can see, so what Cello
-- concluded about it for one person lives on that person's own row,
-- public.person_roles, never on jobs:
--
--   person_roles.blocked_reasons  facts the person stated that this role breaks,
--                                 each as a sentence. Empty means nothing was broken.
--   person_roles.want_*           how likely the person is to want it, and why.
--   person_roles.chance*          Strong / Possible / Stretch with the cited evidence.
--   person_roles.checked_at       when Cello last assessed the role for this person.
--
-- What the posting asks for is not stored here: the reader's own extractor
-- writes it to jobs.requirements and scoring reads that.
--
-- Three small tables hold what must not live on a posting:
--
--   role_reactions   the learning signal: Interested / Not for me (with an
--                    optional one-tap reason) / Applied. One row per person and
--                    role. It carries a snapshot of the role, because the prune
--                    deletes old postings and a reaction is training data that
--                    has to outlive the posting.
--   shortlist_items  the daily list: which roles, in what order, which are
--                    exploration picks, and the one sentence for each.
--   taste_models     how the want signals are blended for this person, and the
--                    evidence the blend was chosen on.
--
-- jobs.match_score and jobs.match_details are retired in 20261009000201.
--
-- Nothing here points at public.jobs with a foreign key on purpose: the prune
-- keeps any job that something references, so a reference from a table that grows
-- with every reaction would keep the postings table from ever shrinking.
--
-- Blocks marked "lane-stub: K5a person_roles" touch public.person_roles, which
-- the employer and role work (K5a) creates. They skip with a notice where it is
-- missing and are deleted once K5a is on the base.

-- ---------------------------------------------------------------------------
-- Nothing per person on jobs. An earlier draft of this file put the verdict on
-- the job row; a database that ran it is cleaned here. A no-op everywhere else.
-- ---------------------------------------------------------------------------
drop trigger if exists jobs_reset_fit_on_description on public.jobs;
drop function if exists public.reset_job_fit_on_description_change();

alter table public.jobs
  drop column if exists fit_assessed_at,
  drop column if exists blocked_reasons,
  drop column if exists want_p,
  drop column if exists want_reason,
  drop column if exists want_detail,
  drop column if exists chance,
  drop column if exists chance_detail,
  drop column if exists requirement_items;

-- ---------------------------------------------------------------------------
-- The verdict on a role, on the person's own row
-- ---------------------------------------------------------------------------
-- lane-stub: K5a person_roles
do $stub$
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, verdict columns skipped';
    return;
  end if;

  alter table public.person_roles
    add column if not exists checked_at timestamptz,
    add column if not exists blocked_reasons jsonb not null default '[]'::jsonb,
    add column if not exists want_p real,
    add column if not exists want_reason text,
    add column if not exists want_detail jsonb,
    add column if not exists chance text,
    add column if not exists chance_detail jsonb;

  alter table public.person_roles drop constraint if exists person_roles_want_p_range;
  alter table public.person_roles add constraint person_roles_want_p_range check (want_p is null or (want_p >= 0 and want_p <= 1));
  alter table public.person_roles drop constraint if exists person_roles_want_reason_len;
  alter table public.person_roles add constraint person_roles_want_reason_len check (want_reason is null or char_length(want_reason) <= 300);
  alter table public.person_roles drop constraint if exists person_roles_chance_values;
  alter table public.person_roles add constraint person_roles_chance_values check (chance is null or chance in ('strong', 'possible', 'stretch', 'cannot_assess'));

  comment on column public.person_roles.checked_at is
    'When Cello last assessed this role for this person. Null means not assessed yet.';
  comment on column public.person_roles.blocked_reasons is
    'Facts this person stated that the role breaks: [{kind, text}]. Empty array means none. Filtering with a reason, never points.';
  comment on column public.person_roles.want_p is
    'Probability (0 to 1) this person is interested, from their own reactions and stated preferences. Ranks roles; never shown as a number.';
  comment on column public.person_roles.want_reason is
    'One sentence in the person''s terms for why they might want the role.';
  comment on column public.person_roles.want_detail is
    '{judge, embedding, stated, statedKey, calibrated, nReactions, source}: the signals behind want_p.';
  comment on column public.person_roles.chance is
    'strong | possible | stretch | cannot_assess. cannot_assess means the posting has no usable requirements yet.';
  comment on column public.person_roles.chance_detail is
    '{checks:[{requirement, mustHave, status, evidence:{line, quote}|null}], gaps, confirm, note, resumeKey}: each requirement checked against the resume with a cited line.';

  create index if not exists idx_person_roles_unchecked on public.person_roles (user_id) where checked_at is null;
  create index if not exists idx_person_roles_want on public.person_roles (user_id, want_p desc nulls last) where blocked_reasons = '[]'::jsonb;
end
$stub$;

-- A changed posting invalidates what was concluded from it, for everyone who sees it.
-- lane-stub: K5a person_roles
do $stub$
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, reset trigger skipped';
    return;
  end if;

  create or replace function public.reset_person_roles_on_posting_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  begin
    update public.person_roles
    set chance = null, chance_detail = null, checked_at = null
    where job_id = new.id;
    return null;
  end;
  $fn$;

  revoke all on function public.reset_person_roles_on_posting_change() from public, anon, authenticated;

  drop trigger if exists jobs_reset_person_roles_on_change on public.jobs;
  create trigger jobs_reset_person_roles_on_change
    after update of description, requirements on public.jobs
    for each row
    when (old.description is distinct from new.description or old.requirements is distinct from new.requirements)
    execute function public.reset_person_roles_on_posting_change();
end
$stub$;

-- A session cannot forge a verdict. The person may change what they decide
-- (hide a role); the server, with the service role, writes what Cello concludes.
-- lane-stub: K5a person_roles
do $stub$
declare
  writable text;
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, grants skipped';
    return;
  end if;

  if has_table_privilege('authenticated', 'public.person_roles', 'UPDATE') then
    revoke update on public.person_roles from authenticated;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into writable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'person_roles'
      and column_name not in ('user_id', 'job_id', 'checked_at', 'blocked_reasons', 'want_p', 'want_reason', 'want_detail', 'chance', 'chance_detail');
    execute format('grant update (%s) on public.person_roles to authenticated', writable);
  end if;
  grant update (hidden_reason) on public.person_roles to authenticated;

  drop policy if exists "own person_roles update" on public.person_roles;
  create policy "own person_roles update" on public.person_roles
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
end
$stub$;

-- ---------------------------------------------------------------------------
-- role_reactions
-- ---------------------------------------------------------------------------
create table if not exists public.role_reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid,
  reaction text not null check (reaction in ('interested', 'not_for_me', 'applied')),
  -- Why a role was passed on. Only a pass has a reason.
  reason text,
  note text check (note is null or char_length(note) <= 500),
  -- Where the person reacted, and whether the role was a regular pick or an
  -- exploration pick when they saw it. Calibration needs to tell those apart.
  surface text not null default 'roles',
  pick_kind text check (pick_kind in ('top', 'explore')),
  -- Snapshot of the role at the moment of the reaction.
  job_title text not null,
  company_name text,
  job_location text,
  job_text text not null default '',
  -- Unsized on purpose: the vector comes from whichever embedding model is in
  -- use, and vectors from different models are never compared.
  embedding real[],
  embedding_model text,
  -- What Cello predicted for this role before the person reacted:
  -- {judge, embedding, stated, blended, chance}. The blend is fitted on these,
  -- so it learns from how the signals really did.
  predicted jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint role_reactions_reason_only_on_pass check (reason is null or reaction = 'not_for_me')
);

-- The reason, surface and snapshot limits as named constraints, so a database
-- that ran an earlier draft (auto-named checks, old names) is brought to this shape.
alter table public.role_reactions drop constraint if exists role_reactions_reason_check;
alter table public.role_reactions drop constraint if exists role_reactions_surface_check;
alter table public.role_reactions drop constraint if exists role_reactions_job_text_check;
alter table public.role_reactions drop constraint if exists role_reactions_reason_values;
alter table public.role_reactions drop constraint if exists role_reactions_surface_values;
alter table public.role_reactions drop constraint if exists role_reactions_job_text_len;

update public.role_reactions set surface = 'roles' where surface = 'opportunities';
update public.role_reactions set surface = 'applications' where surface = 'pipeline';
update public.role_reactions set job_text = left(job_text, 2000) where char_length(job_text) > 2000;
alter table public.role_reactions alter column surface set default 'roles';

alter table public.role_reactions add constraint role_reactions_reason_values
  check (reason is null or reason in ('too_junior', 'too_senior', 'company', 'domain', 'location', 'relocation', 'agency', 'sponsorship', 'pay', 'other'));
alter table public.role_reactions add constraint role_reactions_surface_values
  check (surface in ('roles', 'record', 'today', 'applications', 'company', 'chat'));
alter table public.role_reactions add constraint role_reactions_job_text_len
  check (char_length(job_text) <= 2000);

-- Not partial, so an upsert can name it. Rows whose job was pruned have a null
-- job_id, and nulls never collide in a unique index.
create unique index if not exists role_reactions_user_job_key
  on public.role_reactions (user_id, job_id);
create index if not exists idx_role_reactions_user_recent
  on public.role_reactions (user_id, updated_at desc);

comment on table public.role_reactions is
  'What a person said about a role they were shown: interested, not for me (optional reason) or applied. The learning signal behind the shortlist. Carries a snapshot of the role so it survives the daily prune of old jobs.';
comment on column public.role_reactions.predicted is
  'The signals Cello had for this role before the reaction: {judge, embedding, stated, blended, chance}. The blend is fitted against these.';

-- ---------------------------------------------------------------------------
-- shortlist_items
-- ---------------------------------------------------------------------------
create table if not exists public.shortlist_items (
  user_id uuid not null references public.profiles(id) on delete cascade,
  for_date date not null,
  job_id uuid not null,
  position integer not null check (position >= 1),
  pick_kind text not null check (pick_kind in ('top', 'explore')),
  explanation text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, for_date, job_id)
);

create index if not exists idx_shortlist_items_user_date
  on public.shortlist_items (user_id, for_date desc, position);

comment on table public.shortlist_items is
  'The daily shortlist. pick_kind explore marks the deliberate share of roles chosen to learn from rather than to win. Lists older than two weeks are deleted by the writer.';

-- ---------------------------------------------------------------------------
-- taste_models
-- ---------------------------------------------------------------------------
create table if not exists public.taste_models (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  blend jsonb not null,
  n_reactions integer not null default 0,
  n_positive integer not null default 0,
  fitted boolean not null default false,
  evidence jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.taste_models is
  'How the want signals are blended for one person. fitted is false until there are enough reactions and the fitted blend beats the default on that person''s own history.';

-- ---------------------------------------------------------------------------
-- Row level security: owner only. Reactions are written by the person; the
-- rest is written by the server (service role bypasses RLS) and only read by
-- the person. Nothing is granted to anon.
-- ---------------------------------------------------------------------------
alter table public.role_reactions enable row level security;
alter table public.shortlist_items enable row level security;
alter table public.taste_models enable row level security;

drop policy if exists "own role_reactions select" on public.role_reactions;
create policy "own role_reactions select" on public.role_reactions
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own role_reactions insert" on public.role_reactions;
create policy "own role_reactions insert" on public.role_reactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "own role_reactions update" on public.role_reactions;
create policy "own role_reactions update" on public.role_reactions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "own role_reactions delete" on public.role_reactions;
create policy "own role_reactions delete" on public.role_reactions
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own shortlist_items select" on public.shortlist_items;
create policy "own shortlist_items select" on public.shortlist_items
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own taste_models select" on public.taste_models;
create policy "own taste_models select" on public.taste_models
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.role_reactions, public.shortlist_items, public.taste_models from public, anon, authenticated;
grant select, insert, update, delete on public.role_reactions to authenticated;
grant select on public.shortlist_items, public.taste_models to authenticated;
grant select, insert, update, delete on public.role_reactions, public.shortlist_items, public.taste_models to service_role;

-- ---------------------------------------------------------------------------
-- Applying is the strongest positive. Moving a role into the pipeline as
-- applied (or any later stage) records it as a reaction, so the learning does
-- not depend on every screen remembering to do it. The reaction carries what
-- Cello predicted for the role to that person at that moment.
-- ---------------------------------------------------------------------------
-- lane-stub: K5a person_roles
do $stub$
begin
  if to_regclass('public.person_roles') is null or to_regclass('public.company_directory') is null then
    raise notice 'lane-stub: K5a person_roles absent, applied reaction trigger skipped';
    return;
  end if;

  create or replace function public.record_applied_reaction()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  begin
    if new.stage in ('applied', 'screen', 'interview', 'offer', 'accepted') or new.applied_at is not null then
      insert into public.role_reactions (user_id, job_id, reaction, surface, job_title, company_name, job_location, job_text, predicted)
      select new.user_id, j.id, 'applied', 'applications', j.title, coalesce(d.name, c.name), j.location,
             left(j.title || E'\n' || coalesce(d.name, c.name, '') || E'\n' || coalesce(j.location, '') || E'\n' || coalesce(j.description, ''), 2000),
             case when pr.want_p is null then null
                  else jsonb_build_object(
                    'judge', (pr.want_detail ->> 'judge')::float8,
                    'embedding', (pr.want_detail ->> 'embedding')::float8,
                    'stated', (pr.want_detail ->> 'stated')::float8,
                    'blended', pr.want_p,
                    'chance', pr.chance)
             end
      from public.jobs j
      left join public.person_roles pr on pr.job_id = j.id and pr.user_id = new.user_id
      left join public.company_directory d on d.id = j.employer_id
      left join public.companies c on c.id = j.company_id
      where j.id = new.job_id
      on conflict (user_id, job_id)
      do update set reaction = 'applied', reason = null, updated_at = now();
    end if;
    return new;
  end;
  $fn$;

  revoke all on function public.record_applied_reaction() from public, anon, authenticated;

  drop trigger if exists applications_record_applied_reaction on public.applications;
  create trigger applications_record_applied_reaction
    after insert or update of stage, applied_at on public.applications
    for each row execute function public.record_applied_reaction();
end
$stub$;

-- ---------------------------------------------------------------------------
-- Self-check: the guarantees this file exists to give.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['role_reactions', 'shortlist_items', 'taste_models'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'anon can read %', t;
    end if;
  end loop;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs'
      and column_name in ('fit_assessed_at', 'blocked_reasons', 'want_p', 'want_reason', 'want_detail', 'chance', 'chance_detail', 'requirement_items')
  ) then
    raise exception 'a per person verdict column is still on jobs';
  end if;
end;
$$;

-- lane-stub: K5a person_roles
do $stub$
declare
  n integer;
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, closing asserts skipped';
    return;
  end if;
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'person_roles'
    and column_name in ('checked_at', 'blocked_reasons', 'want_p', 'want_reason', 'want_detail', 'chance', 'chance_detail');
  if n <> 7 then
    raise exception 'person_roles is missing verdict columns (% of 7)', n;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'jobs_reset_person_roles_on_change') then
    raise exception 'posting change reset trigger is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'applications_record_applied_reaction') then
    raise exception 'applied reaction trigger is missing';
  end if;
  if has_column_privilege('authenticated', 'public.person_roles', 'want_p', 'UPDATE') then
    raise exception 'a session can write a verdict';
  end if;
end
$stub$;

notify pgrst, 'reload schema';
