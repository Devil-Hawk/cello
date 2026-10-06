-- K16: the answer bank (migration 20261016000000).
--
-- One row per question and company scope; the session reads its own rows and writes none; a model's
-- words are never stored as the person's; the trigram index answers a similarity query. Rolls back.
--
--   bash supabase/checks/run.sh supabase/checks/pipeline_answers.sql

\set ON_ERROR_STOP 1
begin;

create temp table fx as select gen_random_uuid() as u1, gen_random_uuid() as u2, gen_random_uuid() as co;
grant select on fx to public;

insert into auth.users (id, email) select u1, 'ab-1@example.invalid' from fx union all select u2, 'ab-2@example.invalid' from fx;
insert into public.companies (id, user_id, name, career_url) select co, u1, 'Bank Co', 'https://bank.example' from fx;

insert into public.answer_bank (user_id, question, question_key, category, source, origin, answer)
select u1, 'Are you willing to relocate?', 'willing to relocate', 'relocation', 'person', 'person', '"Yes"'::jsonb from fx;
insert into public.answer_bank (user_id, question, question_key, category, source, origin)
select u2, 'Are you willing to relocate?', 'willing to relocate', 'relocation', 'person', 'person' from fx;

do $$
declare n integer;
begin
  -- the same key twice for one person and no company: refused
  begin
    insert into public.answer_bank (user_id, question, question_key, category, source, origin)
    select u1, 'Willing to relocate?', 'willing to relocate', 'relocation', 'person', 'person' from fx;
    raise exception 'a second row with the same key and no company was accepted';
  exception when unique_violation then null;
  end;
  -- the same key scoped to a company is a different row
  insert into public.answer_bank (user_id, question, question_key, category, source, origin, company_id)
  select u1, 'Willing to relocate to Bank Co?', 'willing to relocate', 'relocation', 'person', 'person', co from fx;
  -- an open question is a row with a null answer
  select count(*) into n from public.answer_bank where answer is null and not declined;
  if n <> 1 then raise exception 'expected one open question, got %', n; end if;
  -- a model's words cannot be stored as the person's own
  begin
    insert into public.answer_bank (user_id, question, question_key, category, source, origin)
    select u1, 'Chat question', 'chat question', 'other', 'chat', 'person' from fx;
    raise exception 'a chat answer was stored with origin person';
  exception when check_violation then null;
  end;
  -- the trigram index answers a similarity query
  set local enable_seqscan = off;
  select count(*) into n from public.answer_bank where question_key % 'willing to relocate';
  if n < 1 then raise exception 'the trigram query found nothing'; end if;
end
$$;

-- the session reads its own rows and writes none
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select u1 from fx), 'role', 'authenticated')::text, true);
do $$
declare n integer;
begin
  select count(*) into n from public.answer_bank;
  if n <> 2 then raise exception 'the person should see their 2 rows, saw %', n; end if;
  begin
    insert into public.answer_bank (user_id, question, question_key, category, source, origin)
    values (auth.uid(), 'x', 'x', 'other', 'person', 'person');
    raise exception 'a session insert was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.answer_bank set answer = '"No"'::jsonb;
    raise exception 'a session update was accepted';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

rollback;
