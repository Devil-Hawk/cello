-- Proves migration 20261120500000 (the relay queue). It applies the migration again
-- inside the transaction (so a re-run is exercised), then checks, as the real client
-- roles, that a person can read only their own jobs and write none, and that
-- relay_complete refuses the wrong person, the wrong claim, an unclaimed job and a
-- second answer.
--
-- The queue half (relay_enqueue and relay_claim use pgmq) runs against real pgmq where
-- it is installed. The checks harness image has none, so there the check makes a small
-- stand-in for the three pgmq calls the functions use (send, read with a conditional,
-- delete) on the same table name pgmq uses, inside the transaction, and says so. The
-- stand-in proves our SQL; it does not prove pgmq. Run this file against a Supabase
-- database to prove the real thing.
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
-- The queue half.
-- ===========================================================================
do $$
begin
  if to_regnamespace('pgmq') is not null then
    raise notice 'pgmq is installed: the queue assertions run against it';
    return;
  end if;
  raise notice 'pgmq is not installed here: the queue assertions run against this check''s own stand-in for send, read and delete';
  create schema pgmq;
  create table pgmq.q_model_jobs (
    msg_id bigserial primary key,
    read_ct integer not null default 0,
    enqueued_at timestamptz not null default now(),
    vt timestamptz not null default now(),
    message jsonb not null,
    headers jsonb
  );
  create function pgmq.send(queue_name text, msg jsonb, delay integer default 0) returns bigint
  language sql as 'insert into pgmq.q_model_jobs (message) values (msg) returning msg_id';
  create function pgmq.delete(queue_name text, msg_id bigint) returns boolean
  language sql as 'with d as (delete from pgmq.q_model_jobs where pgmq.q_model_jobs.msg_id = $2 returning 1) select exists (select 1 from d)';
  create function pgmq.read(queue_name text, vt_secs integer, qty integer, conditional jsonb default '{}'::jsonb)
  returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb, headers jsonb)
  language sql as $f$
    update pgmq.q_model_jobs q
       set read_ct = q.read_ct + 1, vt = now() + make_interval(secs => vt_secs)
     where q.msg_id in (
       select i.msg_id from pgmq.q_model_jobs i
        where i.vt <= now() and i.message @> conditional
        order by i.msg_id limit qty for update skip locked)
    returning q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message, q.headers
  $f$;
end $$;

do $$
declare
  a record; b record; again record; got record; later record; n integer; ok boolean; first_claim uuid;
begin
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
  first_claim := got.claim_id;
  select * into got from public.relay_claim('cccccccc-0000-0000-0000-000000000002', 'R2');
  assert got.job_id = b.job_id, 'person B did not get their own job';
  select count(*) into n from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
  assert n = 0, 'a leased job was handed out again';

  -- A lease that runs out: the next claim gets the job again with a new claim id, and the
  -- carrier that went quiet can no longer answer it.
  update pgmq.q_model_jobs set vt = now() - interval '1 second';
  select * into later from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
  assert later.job_id = a.job_id and later.claim_id <> first_claim, 'an expired lease did not give a new claim id';
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', a.job_id, first_claim, '{"text":"late"}', null);
  assert not ok, 'the old carrier answered after its lease ran out';

  -- Finished once, then handed back with its result instead of asked again.
  ok := public.relay_complete('cccccccc-0000-0000-0000-000000000001', a.job_id, later.claim_id, '{"text":"done"}', null);
  assert ok, 'the claimed job could not be finished';
  select * into again from public.relay_enqueue('cccccccc-0000-0000-0000-000000000001', 'chance', 'R2', 'hq', '{"messages":[]}');
  assert not again.created and again.status = 'done' and again.result ->> 'text' = 'done', 'a finished job was asked again';

  -- A job nobody finishes after three reads is failed, not read forever.
  select * into a from public.relay_enqueue('cccccccc-0000-0000-0000-000000000001', 'forever', 'R2', 'hf', '{"messages":[]}');
  for i in 1..3 loop
    select count(*) into n from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
    assert n = 1, 'read ' || i || ' did not hand the job out';
    update pgmq.q_model_jobs set vt = now() - interval '1 second';
  end loop;
  select count(*) into n from public.relay_claim('cccccccc-0000-0000-0000-000000000001', 'R2');
  assert n = 0, 'a job read three times was handed out a fourth time';
  assert (select status from public.model_jobs where id = a.job_id) = 'failed', 'a job nobody finished did not fail';
end $$;

rollback;
