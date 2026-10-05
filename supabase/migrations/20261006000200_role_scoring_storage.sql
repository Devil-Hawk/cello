-- Storage for the personal shortlist: what the person said about each role they
-- were shown, what Cello concluded about a role for them, and the daily list.
--
-- The old model wrote one integer to jobs.match_score and every reader treated
-- it as the truth. It could not hold a stated reason for hiding a role, a
-- learned taste, or evidence for a chance judgement, so it is replaced by:
--
--   role_reactions    the learning signal. Interested / Not for me (with an
--                     optional one-tap reason) / Applied. One row per person and
--                     role. It carries a snapshot of the role, because the daily
--                     prune deletes old jobs and the reaction is training data
--                     that has to outlive the posting.
--   job_assessments   the verdict for one person and one role: hard constraints
--                     that apply (with the stated reason), how much they are
--                     likely to want it, and the chance with its evidence.
--   job_requirements  the structured requirements read out of a posting, so the
--                     extraction is paid for once per posting, not per check.
--   job_embeddings    one vector per posting, for the taste similarity.
--   shortlist_items   the daily list: which roles, in what order, which are
--                     exploration picks, and the one sentence for each.
--   taste_models      how the want signals are blended for this person, and the
--                     evidence the blend was chosen on.
--
-- jobs.match_score and jobs.match_details stay as a read-only legacy projection
-- (see 20261006000201) so existing readers keep working while they move over.
--
-- Nothing here points at public.jobs with a foreign key on purpose: the prune
-- keeps any job that something references, so a reference from a table that grows
-- with every assessment would keep the whole postings table from ever shrinking.
-- A trigger on jobs removes the per-job rows instead.

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
  embedding extensions.vector(1536),
  embedding_model text,
  -- What Cello predicted for this role before the person reacted. The blend is
  -- fitted on these, so it learns from how the signals really did.
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
  'The want signals Cello had for this role before the reaction: {judge, embedding, blended}. The blend is fitted against these.';

-- ---------------------------------------------------------------------------
-- job_assessments
-- ---------------------------------------------------------------------------
create table if not exists public.job_assessments (
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null,
  assessed_at timestamptz not null default now(),

  -- Hard constraints: facts the person stated. Filtering with a reason, never points.
  blocked boolean not null default false,
  blocked_reasons jsonb not null default '[]'::jsonb,

  -- Want: the probability the person is interested, and why, in their terms.
  want_p real check (want_p is null or (want_p >= 0 and want_p <= 1)),
  want_reason text,
  want_calibrated boolean not null default false,
  want_components jsonb,

  -- Chance: evidence, not a number.
  chance text check (chance in ('strong', 'possible', 'stretch', 'cannot_assess')),
  chance_checks jsonb not null default '[]'::jsonb,
  chance_gaps jsonb not null default '[]'::jsonb,
  chance_note text,

  prompt_versions jsonb,
  primary key (user_id, job_id)
);

create index if not exists idx_job_assessments_user_want
  on public.job_assessments (user_id, want_p desc nulls last) where blocked = false;

comment on table public.job_assessments is
  'Cello''s verdict on one role for one person: the hard constraints that apply, how likely they are to want it, and the chance with cited evidence. Replaces jobs.match_score.';
comment on column public.job_assessments.chance is
  'strong | possible | stretch | cannot_assess. cannot_assess means the posting has no usable description yet.';

-- ---------------------------------------------------------------------------
-- job_requirements, job_embeddings
-- ---------------------------------------------------------------------------
create table if not exists public.job_requirements (
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null,
  requirements jsonb not null,
  extractor_version integer not null,
  extracted_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

comment on table public.job_requirements is
  'Structured requirements read out of a posting description, once per posting. See lib/scoring/requirements.ts.';

create table if not exists public.job_embeddings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null,
  model text not null,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now(),
  primary key (user_id, job_id, model)
);

comment on table public.job_embeddings is
  'One vector per posting for the taste similarity. Vectors from different models are never compared, hence the model in the key.';

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
  'The daily shortlist. pick_kind explore marks the deliberate share of roles chosen to learn from rather than to win.';

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
-- the person.
-- ---------------------------------------------------------------------------
alter table public.role_reactions enable row level security;
alter table public.job_assessments enable row level security;
alter table public.job_requirements enable row level security;
alter table public.job_embeddings enable row level security;
alter table public.shortlist_items enable row level security;
alter table public.taste_models enable row level security;

create policy "own role_reactions select" on public.role_reactions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own role_reactions insert" on public.role_reactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own role_reactions update" on public.role_reactions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own role_reactions delete" on public.role_reactions
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own job_assessments select" on public.job_assessments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own job_requirements select" on public.job_requirements
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own job_embeddings select" on public.job_embeddings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own shortlist_items select" on public.shortlist_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own taste_models select" on public.taste_models
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.role_reactions, public.job_assessments, public.job_requirements,
  public.job_embeddings, public.shortlist_items, public.taste_models from public, anon;
grant select, insert, update, delete on public.role_reactions to authenticated;
grant select on public.job_assessments, public.job_requirements, public.job_embeddings,
  public.shortlist_items, public.taste_models to authenticated;
grant select, insert, update, delete on public.role_reactions, public.job_assessments,
  public.job_requirements, public.job_embeddings, public.shortlist_items, public.taste_models to service_role;

-- ---------------------------------------------------------------------------
-- When a posting is pruned, its per-job rows go with it. (Reactions keep their
-- snapshot and only lose the pointer.)
-- ---------------------------------------------------------------------------
create or replace function public.forget_job_scoring_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.job_assessments where job_id = old.id;
  delete from public.job_requirements where job_id = old.id;
  delete from public.job_embeddings where job_id = old.id;
  delete from public.shortlist_items where job_id = old.id;
  update public.role_reactions set job_id = null where job_id = old.id;
  return old;
end;
$$;

revoke all on function public.forget_job_scoring_rows() from public, anon, authenticated;

drop trigger if exists jobs_forget_scoring_rows on public.jobs;
create trigger jobs_forget_scoring_rows
  after delete on public.jobs
  for each row execute function public.forget_job_scoring_rows();

-- ---------------------------------------------------------------------------
-- Applying is the strongest positive. Moving a role into the pipeline as
-- applied (or any later stage) records it as a reaction, so the learning does
-- not depend on every screen remembering to do it.
-- ---------------------------------------------------------------------------
create or replace function public.record_applied_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage in ('applied', 'screen', 'interview', 'offer') or new.applied_at is not null then
    insert into public.role_reactions (user_id, job_id, reaction, surface, job_title, company_name, job_location, job_text)
    select new.user_id, j.id, 'applied', 'pipeline', j.title, c.name, j.location,
           left(j.title || E'\n' || coalesce(c.name, '') || E'\n' || coalesce(j.location, '') || E'\n' || coalesce(j.description, ''), 4000)
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

notify pgrst, 'reload schema';
