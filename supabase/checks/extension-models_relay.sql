-- Proves migration 20261120500000 (the relay queue). It applies the migration again
-- inside the transaction (so a re-run is exercised), then checks, as the real client
-- roles, that a person can read only their own jobs and write none, and that
-- relay_complete refuses the wrong person, the wrong claim, an unclaimed job and a
-- second answer.
--
-- The queue half (relay_enqueue and relay_claim read pgmq) runs only where pgmq is
-- installed. The checks harness image has no pgmq yet: there the queue assertions
-- are skipped and the check says so. They are not faked; K12's harness stub, or a
-- run against a Supabase database, runs them.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/extension-models_relay.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'relay-a@example.invalid'),
  ('cccccccc-0000-0000-0000-000000000002', 'relay-b@example.invalid');

\ir ../migrations/20261120500000_model_jobs.sql

-- Two claimed jobs, written the way the server's functions write them.
insert into public.model_jobs (id, user_id, step_id, rung, prompt_hash, request, status, claim_id, claimed_at) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'inbox.classify', 'R2', 'h1',
   '{"messages":[{"role":"user","content":"a"}]}', 'claimed', 'eeeeeeee-0000-0000-0000-000000000001', now()),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'inbox.classify', 'R2', 'h1',
   '{"messages":[{"role":"user","content":"b"}]}', 'claimed', 'eeeeeeee-0000-0000-0000-000000000002', now()),
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'inbox.employer', 'R2', 'h2',
   '{"messages":[{"role":"user","content":"c"}]}', 'queued', null, null);

-- ===========================================================================
-- A person reads only their own jobs and writes none.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n integer;
begin
  select count(*) into n from public.model_jobs;
  assert n = 2, 'a person must read exactly their own two jobs, read ' || n;
  select count(*) into n from public.model_jobs where user_id = 'cccccccc-0000-0000-0000-000000000002';
  assert n = 0, 'a person must not read another person''s job';

  begin
    insert into public.model_jobs (user_id, step_id, rung, prompt_hash, request)
    values ('cccccccc-0000-0000-0000-000000000001', 's', 'R2', 'x', '{}');
    assert false, 'authenticated could insert a job';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.model_jobs set status = 'done', result = '{"text":"forged"}';
    assert false, 'authenticated could update a job';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.model_jobs;
    assert false, 'authenticated could delete a job';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
      'eeeeeeee-0000-0000-0000-000000000001', '{"text":"forged"}', null);
    assert false, 'authenticated could call relay_complete';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
    assert false, 'authenticated could call relay_claim';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- relay_complete: wrong person, wrong claim, unclaimed job, second answer.
-- ===========================================================================
do $$
declare ok boolean; st text;
begin
  -- The wrong claim id.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
    'eeeeeeee-0000-0000-0000-0000000000ff', '{"text":"x"}', null);
  assert not ok, 'a wrong claim id was accepted';
  -- Another person's job, even with its right claim id.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002',
    'eeeeeeee-0000-0000-0000-000000000002', '{"text":"x"}', null);
  assert not ok, 'another person''s job was accepted';
  -- A job nobody claimed.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000003',
    null, '{"text":"x"}', null);
  assert not ok, 'an unclaimed job was accepted';
  select status into st from public.model_jobs where id = 'dddddddd-0000-0000-0000-000000000003';
  assert st = 'queued', 'the unclaimed job changed';

  -- The right answer is taken once.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
    'eeeeeeee-0000-0000-0000-000000000001', '{"text":"hello"}', null);
  assert ok, 'the right answer was refused';
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
    'eeeeeeee-0000-0000-0000-000000000001', '{"text":"again"}', null);
  assert not ok, 'a second answer was accepted';
  select status into st from public.model_jobs where id = 'dddddddd-0000-0000-0000-000000000001';
  assert st = 'done', 'the finished job is not done';
  assert (select result ->> 'text' from public.model_jobs where id = 'dddddddd-0000-0000-0000-000000000001') = 'hello',
    'the second answer replaced the first';

  -- An answer that is an error fails the job and stores no result.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002',
    'eeeeeeee-0000-0000-0000-000000000002', null, 'The local model is not running.');
  assert ok, 'a carrier error was refused';
  assert (select status from public.model_jobs where id = 'dddddddd-0000-0000-0000-000000000002') = 'failed', 'an error did not fail the job';
  assert (select result from public.model_jobs where id = 'dddddddd-0000-0000-0000-000000000002') is null, 'a failed job kept a result';
end $$;

-- A result over 64 KB cannot be stored.
do $$
begin
  insert into public.model_jobs (user_id, step_id, rung, prompt_hash, request, result)
  values ('cccccccc-0000-0000-0000-000000000001', 'big', 'R2', 'big', '{}', jsonb_build_object('text', repeat('x', 70000)));
  assert false, 'a result over 64 KB was stored';
exception when check_violation then null;
end $$;

-- One job in flight per person, step and prompt.
do $$
begin
  insert into public.model_jobs (user_id, step_id, rung, prompt_hash, request)
  values ('cccccccc-0000-0000-0000-000000000001', 'inbox.employer', 'R2', 'h2', '{}');
  assert false, 'two jobs in flight for one step and prompt';
exception when unique_violation then null;
end $$;

-- ===========================================================================
-- The queue half, where pgmq is installed.
-- ===========================================================================
do $$
declare
  a record; b record; again record; got record; n integer; ok boolean;
begin
  if to_regnamespace('pgmq') is null then
    raise notice 'pgmq is not installed here: the relay_enqueue and relay_claim assertions were skipped, not run';
    return;
  end if;

  select * into a from public.relay_enqueue('cccccccc-0000-0000-0000-000000000001', 'chance', 'R2', 'hq', '{"messages":[]}');
  select * into b from public.relay_enqueue('cccccccc-0000-0000-0000-000000000002', 'chance', 'R2', 'hq', '{"messages":[]}');
  assert a.created and b.created, 'both people should get a new job';
  select * into again from public.relay_enqueue('cccccccc-0000-0000-0000-000000000001', 'chance', 'R2', 'hq', '{"messages":[]}');
  assert not again.created and again.job_id = a.job_id, 'the same ask enqueued twice';

  -- A claim at the wrong rung finds nothing; a claim returns only the caller's job.
  select count(*) into n from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R1');
  assert n = 0, 'a claim at another rung returned a job';
  select * into got from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
  assert got.job_id = a.job_id, 'person A did not get their own job';
  select * into got from public.relay_claim('cccccccc-0000-0000-0000-000000000002', 'R2');
  assert got.job_id = b.job_id, 'person B did not get their own job';
  select count(*) into n from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
  assert n = 0, 'a leased job was handed out again';

  -- Finished once, then handed back with its result instead of asked again.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', a.job_id,
    (select claim_id from public.model_jobs where id = a.job_id), '{"text":"done"}', null);
  assert ok, 'the claimed job could not be finished';
  select * into again from public.relay_enqueue('cccccccc-0000-0000-0000-000000000001', 'chance', 'R2', 'hq', '{"messages":[]}');
  assert not again.created and again.status = 'done' and again.result ->> 'text' = 'done', 'a finished job was asked again';
end $$;

rollback;
