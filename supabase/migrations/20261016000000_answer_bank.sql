-- K16: the answer bank. The person's screening answers are stored once and reused. A question Cello
-- has no answer for is a row with a null answer (an open question), so the same question asked by
-- three applications is one row and one thing to answer.
--
-- Provenance: `source` is the detail (person, profile, resume, approved_draft, chat); `origin` is the
-- one word code gates on. person and profile are the person's own, resume is code, approved_draft and
-- chat are a model's words. Confirming a model's answer sets confirmed_at and keeps origin 'model':
-- Send for me reads only origin 'person'.
--
-- The session reads its own rows and writes none; every write goes through the answers routes, which
-- validate first (service role).

create table if not exists public.answer_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  question text not null check (char_length(question) <= 500),
  -- lower case, punctuation and filler removed, whitespace collapsed (lib/answers/normalize.ts)
  question_key text not null check (char_length(question_key) between 1 and 500),
  category text not null check (category in (
    'contact', 'links', 'work_auth', 'sponsorship', 'relocation', 'location', 'start_date', 'notice',
    'salary', 'education', 'experience', 'eeo', 'consent', 'motivation', 'other')),
  sensitive boolean not null default false,
  -- names a place, a company, a number of days, a date or an amount: never matched by similarity
  specific boolean not null default false,
  kind text not null default 'text' check (kind in ('text', 'long_text', 'yes_no', 'select', 'multi_select', 'number', 'date', 'file')),
  options jsonb,
  -- null is an open question
  answer jsonb,
  declined boolean not null default false,
  -- set when the question names the employer; never reused elsewhere
  company_id uuid references public.companies (id) on delete cascade,
  source text not null check (source in ('person', 'profile', 'resume', 'approved_draft', 'chat')),
  -- where it came from, application_id included when saved from one application's form
  source_ref jsonb,
  origin text not null check (origin in ('person', 'code', 'model')),
  prov jsonb,
  confirmed_at timestamptz,
  use_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint answer_bank_origin_matches_source check (
    origin = case source when 'person' then 'person' when 'profile' then 'person' when 'resume' then 'code' else 'model' end)
);

create unique index if not exists answer_bank_key_idx
  on public.answer_bank (user_id, question_key, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists answer_bank_key_trgm on public.answer_bank using gin (question_key gin_trgm_ops);
create index if not exists answer_bank_open_idx on public.answer_bank (user_id) where answer is null and not declined;

alter table public.answer_bank enable row level security;
drop policy if exists answer_bank_select_own on public.answer_bank;
create policy answer_bank_select_own on public.answer_bank for select to authenticated using (user_id = auth.uid());

revoke all on public.answer_bank from public, anon, authenticated;
grant select on public.answer_bank to authenticated;
grant all on public.answer_bank to service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Self-check: the unique key and the trigram index exist, and a session cannot write.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'answer_bank_key_idx') then
    raise exception 'answer_bank_key_idx is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'answer_bank_key_trgm' and indexdef ilike '%gin%gin_trgm_ops%') then
    raise exception 'the trigram index on answer_bank.question_key is missing';
  end if;
  if has_table_privilege('authenticated', 'public.answer_bank', 'insert')
     or has_table_privilege('authenticated', 'public.answer_bank', 'update')
     or has_table_privilege('authenticated', 'public.answer_bank', 'delete') then
    raise exception 'the session must not write answer_bank';
  end if;
end
$$;
