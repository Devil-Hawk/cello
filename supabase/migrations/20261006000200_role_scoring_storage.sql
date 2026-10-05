-- Storage for the personal shortlist: what the person said about each role they
-- were shown, what Cello concluded about a role for them, and the daily list.
--
-- The old model wrote one integer to jobs.match_score and every reader treated
-- it as the truth. It could not hold a stated reason for hiding a role, a
-- learned taste, or evidence for a chance judgement.
--
-- A job already belongs to exactly one person (jobs -> companies.user_id), so the
-- verdict about a role for that person lives on the job row itself:
--
--   jobs.blocked_reasons   facts the person stated that this role breaks, each as
--                          a sentence. Empty means nothing was broken.
--   jobs.want_*            how likely the person is to want it, and why.
--   jobs.chance*           Strong / Possible / Stretch with the cited evidence.
--   jobs.requirement_items what the posting asks for, with verbatim quotes, read
--                          once and kept until the description changes.
--
-- Readers embed and order these exactly as they did match_score, and the daily
-- prune needs no changes because nothing points at jobs from outside.
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
-- jobs.match_score and jobs.match_details are retired in 20261006000201.
--
-- Nothing here points at public.jobs with a foreign key on purpose: the prune
-- keeps any job that something references, so a reference from a table that grows
-- with every reaction would keep the postings table from ever shrinking.

-- ---------------------------------------------------------------------------
-- The verdict on a role, on the job row
-- ---------------------------------------------------------------------------
alter table public.jobs
  add column if not exists fit_assessed_at timestamptz,
  add column if not exists blocked_reasons jsonb not null default '[]'::jsonb,
  add column if not exists want_p real,
  add column if not exists want_reason text,
  add column if not exists want_detail jsonb,
  add column if not exists chance text,
  add column if not exists chance_detail jsonb,
  add column if not exists requirement_items jsonb;

alter table public.jobs drop constraint if exists jobs_want_p_range;
alter table public.jobs add constraint jobs_want_p_range check (want_p is null or (want_p >= 0 and want_p <= 1));
alter table public.jobs drop constraint if exists jobs_want_reason_len;
alter table public.jobs add constraint jobs_want_reason_len check (want_reason is null or char_length(want_reason) <= 300);
alter table public.jobs drop constraint if exists jobs_chance_values;
alter table public.jobs add constraint jobs_chance_values check (chance is null or chance in ('strong', 'possible', 'stretch', 'cannot_assess'));

comment on column public.jobs.fit_assessed_at is
  'When Cello last assessed this role for its owner. Null means not assessed yet.';
comment on column public.jobs.blocked_reasons is
  'Facts the owner stated that this role breaks: [{kind, text}]. Empty array means none. Filtering with a reason, never points.';
comment on column public.jobs.want_p is
  'Probability (0 to 1) the owner is interested, from their own reactions and stated preferences. Ranks roles; never shown as a number.';
comment on column public.jobs.want_reason is
  'One sentence in the owner''s terms for why they might want the role.';
comment on column public.jobs.want_detail is
  '{judge, embedding, stated, statedKey, calibrated, nReactions, source}: the signals behind want_p.';
comment on column public.jobs.chance is
  'strong | possible | stretch | cannot_assess. cannot_assess means the posting has no usable requirements yet.';
comment on column public.jobs.chance_detail is
  '{checks:[{requirement, mustHave, status, evidence:{line, quote}|null}], gaps, confirm, note, resumeKey}: each requirement checked against the resume with a cited line.';
comment on column public.jobs.requirement_items is
  '{version, kind: ok|thin, items:[{id, text, kind, mustHave, quote}] | reason}: what the posting asks for, with verbatim quotes. Reset when the description changes.';

create index if not exists idx_jobs_fit_todo on public.jobs (company_id) where fit_assessed_at is null;
create index if not exists idx_jobs_fit_rank on public.jobs (company_id, want_p desc nulls last) where blocked_reasons = '[]'::jsonb;

-- A changed description invalidates what was read from it.
create or replace function public.reset_job_fit_on_description_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.description is distinct from old.description then
    new.requirement_items := null;
    new.chance := null;
    new.chance_detail := null;
    new.fit_assessed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.reset_job_fit_on_description_change() from public, anon, authenticated;

drop trigger if exists jobs_reset_fit_on_description on public.jobs;
create trigger jobs_reset_fit_on_description
  before update of description on public.jobs
  for each row execute function public.reset_job_fit_on_description_change();

-- ---------------------------------------------------------------------------
-- role_reactions
-- ---------------------------------------------------------------------------
create table if not exists public.role_reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid,
  reaction text not null check (reaction in ('interested', 'not_for_me', 'applied')),
  -- Why a role was passed on. Only a pass has a reason.
  reason text check (reason in ('too_junior', 'too_senior', 'company', 'domain', 'location', 'pay', 'other')),
  note text check (note is null or char_length(note) <= 500),
  -- Where the person reacted, and whether the role was a regular pick or an
  -- exploration pick when they saw it. Calibration needs to tell those apart.
  surface text not null default 'opportunities' check (surface in ('today', 'opportunities', 'chat', 'pipeline')),
  pick_kind text check (pick_kind in ('top', 'explore')),
  -- Snapshot of the role at the moment of the reaction.
  job_title text not null,
  company_name text,
  job_location text,
  job_text text not null default '' check (char_length(job_text) <= 4000),
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

create unique index if not exists role_reactions_user_job_key
  on public.role_reactions (user_id, job_id) where job_id is not null;
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

revoke all on public.role_reactions, public.shortlist_items, public.taste_models from public, anon;
grant select, insert, update, delete on public.role_reactions to authenticated;
grant select on public.shortlist_items, public.taste_models to authenticated;
grant select, insert, update, delete on public.role_reactions, public.shortlist_items, public.taste_models to service_role;

-- ---------------------------------------------------------------------------
-- Applying is the strongest positive. Moving a role into the pipeline as
-- applied (or any later stage) records it as a reaction, so the learning does
-- not depend on every screen remembering to do it. The reaction carries what
-- Cello predicted for the role at that moment.
-- ---------------------------------------------------------------------------
create or replace function public.record_applied_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage in ('applied', 'screen', 'interview', 'offer', 'accepted') or new.applied_at is not null then
    insert into public.role_reactions (user_id, job_id, reaction, surface, job_title, company_name, job_location, job_text, predicted)
    select new.user_id, j.id, 'applied', 'pipeline', j.title, c.name, j.location,
           left(j.title || E'\n' || coalesce(c.name, '') || E'\n' || coalesce(j.location, '') || E'\n' || coalesce(j.description, ''), 4000),
           case when j.want_p is null then null
                else jsonb_build_object(
                  'judge', (j.want_detail ->> 'judge')::float8,
                  'embedding', (j.want_detail ->> 'embedding')::float8,
                  'stated', (j.want_detail ->> 'stated')::float8,
                  'blended', j.want_p,
                  'chance', j.chance)
           end
    from public.jobs j
    join public.companies c on c.id = j.company_id
    where j.id = new.job_id
    on conflict (user_id, job_id) where job_id is not null
    do update set reaction = 'applied', reason = null, updated_at = now();
  end if;
  return new;
end;
$$;

revoke all on function public.record_applied_reaction() from public, anon, authenticated;

drop trigger if exists applications_record_applied_reaction on public.applications;
create trigger applications_record_applied_reaction
  after insert or update of stage, applied_at on public.applications
  for each row execute function public.record_applied_reaction();

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
  if not exists (select 1 from pg_trigger where tgname = 'jobs_reset_fit_on_description') then
    raise exception 'description reset trigger is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'applications_record_applied_reaction') then
    raise exception 'applied reaction trigger is missing';
  end if;
end;
$$;

notify pgrst, 'reload schema';
