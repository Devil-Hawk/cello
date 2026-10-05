-- Proves migrations 20261005000004 (access_codes hardening) and 20261005000005
-- (atomic LLM spend). It applies both migrations TWICE inside the transaction
-- (so idempotency is exercised and an unmigrated database can be checked), runs
-- the assertions as the real client roles, and rolls everything back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/access_codes_and_spend.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

\ir ../migrations/20261005000004_access_codes_hardening.sql
\ir ../migrations/20261005000004_access_codes_hardening.sql
\ir ../migrations/20261005000005_atomic_llm_spend.sql
\ir ../migrations/20261005000005_atomic_llm_spend.sql

-- Fixed ids: client roles cannot read a postgres-owned temp table.
--   owner  aaaaaaaa-0000-0000-0000-000000000001
--   other  aaaaaaaa-0000-0000-0000-000000000002
--   flood  aaaaaaaa-0000-0000-0000-000000000003
--   demo   aaaaaaaa-0000-0000-0000-000000000004
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ac-owner@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ac-other@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'ac-flood@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'ac-demo@example.invalid');
insert into public.profiles (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ac-owner@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ac-other@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'ac-flood@example.invalid'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'ac-demo@example.invalid')
on conflict (id) do nothing;

-- ===========================================================================
-- Part 1: access_codes, as a signed-in owner talking to PostgREST directly
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

-- A hostile insert is clamped, not trusted.
do $$
declare r public.access_codes;
begin
  insert into public.access_codes
    (owner_user_id, code_hash, code_prefix, expires_at, revoked_at, redemption_count,
     first_redeemed_at, last_used_at, demo_user_id, created_at)
  values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'hash-hostile', 'HOST', '2099-01-01',
     now(), 7, now(), now(), 'aaaaaaaa-0000-0000-0000-000000000004', '2000-01-01')
  returning * into r;
  assert r.expires_at <= now() + interval '72 hours', 'expiry must be clamped to 72h';
  assert r.expires_at > now() + interval '71 hours', 'clamp must not shorten a legitimate expiry';
  assert r.revoked_at is null, 'born revoked must be reset';
  assert r.redemption_count = 0, 'redemption_count must be reset';
  assert r.first_redeemed_at is null and r.last_used_at is null, 'usage stamps must be reset';
  assert r.demo_user_id is null, 'demo_user_id must be reset';
  assert r.created_at > now() - interval '1 minute', 'created_at must be reset';
end $$;

-- The app's own insert shape passes untouched.
do $$
declare r public.access_codes;
begin
  insert into public.access_codes (owner_user_id, code_hash, code_prefix, label, expires_at)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'hash-app', 'APPX', 'note',
          now() + interval '72 hours')
  returning * into r;
  assert r.label = 'note';
end $$;

-- Cap: 2 live now, fill to 25, the 26th is refused.
insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
select 'aaaaaaaa-0000-0000-0000-000000000001', 'hash-fill-' || g, 'FILL', now() + interval '72 hours'
from generate_series(1, 23) g;

do $$
begin
  begin
    insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'hash-26', 'OVER', now() + interval '1 hour');
    raise exception 'the 26th live code was accepted';
  exception when check_violation then null;
  end;
end $$;

-- Updates: only revoke, shorten and relabel are allowed.
do $$
declare
  id1 uuid;
  rr public.access_codes;
begin
  select id into id1 from public.access_codes where code_hash = 'hash-app';

  -- Each forbidden change must raise insufficient_privilege.
  begin update public.access_codes set expires_at = '2099-01-01' where id = id1;
    raise exception 'extension accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set code_hash = 'hash-own' where id = id1;
    raise exception 'code_hash change accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set code_prefix = 'ZZZZ' where id = id1;
    raise exception 'code_prefix change accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set owner_user_id = 'aaaaaaaa-0000-0000-0000-000000000002' where id = id1;
    raise exception 'owner reassignment accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set demo_user_id = 'aaaaaaaa-0000-0000-0000-000000000004' where id = id1;
    raise exception 'demo reassignment accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set redemption_count = 99 where id = id1;
    raise exception 'redemption_count change accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set created_at = created_at - interval '1 day' where id = id1;
    raise exception 'created_at change accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set last_used_at = now() where id = id1;
    raise exception 'last_used_at change accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set first_redeemed_at = now() where id = id1;
    raise exception 'first_redeemed_at change accepted'; exception when insufficient_privilege then null; end;

  -- Allowed: relabel, shorten, revoke.
  update public.access_codes set label = 'renamed' where id = id1;
  update public.access_codes set expires_at = now() + interval '1 hour' where id = id1;
  update public.access_codes set revoked_at = now() where id = id1 returning * into rr;
  assert rr.revoked_at is not null, 'revoke must work';

  -- A revoked code stays revoked and its timestamp is the record.
  begin update public.access_codes set revoked_at = null where id = id1;
    raise exception 'un-revoke accepted'; exception when insufficient_privilege then null; end;
  begin update public.access_codes set revoked_at = now() + interval '1 day' where id = id1;
    raise exception 'revoked_at rewrite accepted'; exception when insufficient_privilege then null; end;
  -- Re-writing the same timestamp (an idempotent re-revoke) is not a change.
  update public.access_codes set revoked_at = rr.revoked_at where id = id1;
end $$;

-- Revoking one frees a live slot (cap counts live codes only).
insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'hash-after-revoke', 'AFTR', now() + interval '1 hour');

-- Delete: nobody deletes codes (policy and grant are gone).
do $$
declare n integer;
begin
  begin
    delete from public.access_codes where owner_user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    assert n = 0, 'owner deleted ' || n || ' access codes';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Another owner's rows are still invisible and unwritable.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n integer;
begin
  update public.access_codes set revoked_at = now() where owner_user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another owner could revoke these codes';
end $$;

-- ---------------------------------------------------------------------------
-- The service role (redeem bookkeeping) keeps working, unclamped.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  id1 uuid;
  r public.access_codes;
begin
  select id into id1 from public.access_codes where code_hash = 'hash-app';
  update public.access_codes
     set demo_user_id = 'aaaaaaaa-0000-0000-0000-000000000004',
         last_used_at = now(), first_redeemed_at = now(), redemption_count = 3,
         expires_at = now() + interval '200 days'
   where id = id1 returning * into r;
  assert r.redemption_count = 3 and r.demo_user_id is not null, 'service role must be exempt (update)';

  insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
  values ('aaaaaaaa-0000-0000-0000-000000000002', 'hash-svc', 'SVCX', now() + interval '200 days')
  returning * into r;
  assert r.expires_at > now() + interval '100 days', 'service role must be exempt (insert)';
end $$;

-- 100 codes in 24h (revoked or not) stops a mint/revoke loop.
insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at, revoked_at)
select 'aaaaaaaa-0000-0000-0000-000000000003', 'hash-flood-' || g, 'FLOD', now() + interval '1 hour', now()
from generate_series(1, 100) g;
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
begin
  begin
    insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
    values ('aaaaaaaa-0000-0000-0000-000000000003', 'hash-flood-x', 'FLOD', now() + interval '1 hour');
    raise exception 'the 101st code in 24h was accepted';
  exception when check_violation then null;
  end;
end $$;

-- Trigger functions are not callable by clients.
do $$
begin
  begin
    perform public.enforce_access_code_insert();
    raise exception 'authenticated could execute the insert trigger function';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ===========================================================================
-- Part 2: record_llm_spend
-- ===========================================================================
create temp table spend_fx (name text primary key, id uuid, p text);
grant all on spend_fx to public;
insert into spend_fx values ('cur', 'aaaaaaaa-0000-0000-0000-000000000001',
  to_char(now() at time zone 'utc', 'YYYY-MM'));

update public.profiles set preferences =
  jsonb_build_object('theme', 'dark',
    'budget', jsonb_build_object('periodStart', (select p from spend_fx), 'spentUsd', 1, 'monthlyUsd', 20))
where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.profiles set preferences =
  '{"budget":{"periodStart":"2020-01","spentUsd":999,"monthlyUsd":20}}'::jsonb
where id = 'aaaaaaaa-0000-0000-0000-000000000002';
update public.profiles set preferences = '{}'::jsonb
where id = 'aaaaaaaa-0000-0000-0000-000000000003';
update public.profiles set preferences = jsonb_build_object('budget',
  jsonb_build_object('periodStart', (select p from spend_fx), 'spentUsd', -10, 'monthlyUsd', -5))
where id = 'aaaaaaaa-0000-0000-0000-000000000004';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  cur text := to_char(now() at time zone 'utc', 'YYYY-MM');
  s numeric;
  b jsonb;
begin
  -- accumulates in-period, keeps other keys and the configured cap
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000001', 12);
  assert s = 13, 'in-period accumulate: got ' || s;
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000001', 0.1234567);
  assert s = 13.123457, 'six-decimal rounding: got ' || s;
  select preferences into b from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  assert b ->> 'theme' = 'dark', 'other preference keys must survive';
  assert (b #>> '{budget,monthlyUsd}')::numeric = 20, 'configured cap must survive';
  assert b #>> '{budget,periodStart}' = cur;

  -- stale period rolls over: 999 is not carried
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000002', 0.25);
  assert s = 0.25, 'rollover must restart at the cost: got ' || s;
  select preferences into b from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  assert b #>> '{budget,periodStart}' = cur, 'rollover must stamp the current period';
  assert (b #>> '{budget,monthlyUsd}')::numeric = 20, 'rollover must keep the cap';

  -- no budget at all: default cap 10
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000003', 0.5);
  assert s = 0.5;
  select preferences into b from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000003';
  assert (b #>> '{budget,monthlyUsd}')::numeric = 10, 'default cap is 10';

  -- negative stored spend counts as 0, invalid cap falls back to the default
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000004', 0.5);
  assert s = 0.5, 'negative stored spend must read as 0: got ' || s;
  select preferences into b from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000004';
  assert (b #>> '{budget,monthlyUsd}')::numeric = 10, 'non-positive cap falls back to 10';

  -- a negative or null cost never reduces the ledger
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000004', -3);
  assert s = 0.5, 'negative cost must not lower spend: got ' || s;
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000004', null);
  assert s = 0.5, 'null cost must not change spend: got ' || s;

  -- unknown profile: nothing to update, no error
  assert public.record_llm_spend('aaaaaaaa-0000-0000-0000-0000000000ff', 1) is null;
end $$;

-- Cost recorded twice in one statement still lands twice (the row lock
-- serialises; this is the in-transaction analogue of two parallel calls).
do $$
declare s numeric;
begin
  perform public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000003', 0.25);
  s := public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000003', 0.25);
  assert s = 1.0, 'sequential increments must add: got ' || s;
end $$;
reset role;

-- Clients cannot call it.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000001', 0);
    raise exception 'authenticated could call record_llm_spend';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.record_llm_spend('aaaaaaaa-0000-0000-0000-000000000001', 0);
    raise exception 'anon could call record_llm_spend';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin raise notice 'ALL ACCESS_CODES AND SPEND ASSERTIONS PASSED'; end $$;
rollback;
