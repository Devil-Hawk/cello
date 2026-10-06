-- Proves migrations 20261008030000 (spend ledger), 20261008030001 (access code
-- functions) and 20261008030002 (cutover). It asserts the hole BEFORE applying
-- them, applies all three TWICE inside the transaction (so idempotency is
-- exercised and an unmigrated database can be checked), runs the assertions as the
-- real client roles, and rolls everything back.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/llm_spend_and_access.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

-- Fixed ids: client roles cannot read a postgres-owned temp table.
--   user   bbbbbbbb-0000-0000-0000-000000000001  signed-in, not a demo, $10 cap
--   other  bbbbbbbb-0000-0000-0000-000000000002
--   demo   bbbbbbbb-0000-0000-0000-000000000003  a demo with a $1 cap
insert into auth.users (id, email) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'sp-user@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'sp-other@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'sp-demo@example.invalid');
insert into public.profiles (id, email) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'sp-user@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'sp-other@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'sp-demo@example.invalid')
on conflict (id) do nothing;
update public.profiles
set is_demo = true,
    demo_expires_at = now() + interval '72 hours',
    preferences = jsonb_build_object('budget', jsonb_build_object('monthlyUsd', 1))
where id = 'bbbbbbbb-0000-0000-0000-000000000003';

-- The user has spent $9.50 of a $10 cap this month, in the OLD counter.
update public.profiles
set preferences = jsonb_build_object('budget', jsonb_build_object(
      'monthlyUsd', 10, 'spentUsd', 9.5,
      'periodStart', to_char(now() at time zone 'utc', 'YYYY-MM')))
where id = 'bbbbbbbb-0000-0000-0000-000000000001';

-- ===========================================================================
-- Part 1: THE HOLE, as it stood before the ledger. A signed-in, non-demo user
-- may write their own preferences over the Data API, and the demo lockdown
-- trigger returns early for every non-demo row, so the old counter could be
-- zeroed with one request. (Still true afterwards: it is the counter that no
-- longer matters, which Part 3 proves.)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n integer; spent numeric;
begin
  update public.profiles
  set preferences = jsonb_set(preferences, '{budget,spentUsd}', '0')
  where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'HOLE: a signed-in user can no longer write their own preferences, so this check needs revisiting';
  select (preferences #>> '{budget,spentUsd}')::numeric into spent
  from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert spent = 0, 'HOLE: the old spend counter was resettable over the Data API';
end $$;

reset role;
-- The migrations run as the database owner with no request in flight.
select set_config('request.jwt.claims', '', true);

-- Put the counter back so the carry-over has something to carry.
update public.profiles
set preferences = jsonb_set(preferences, '{budget,spentUsd}', '9.5')
where id = 'bbbbbbbb-0000-0000-0000-000000000001';

-- ===========================================================================
-- Apply the three migrations, twice.
-- ===========================================================================
\ir ../migrations/20261008030000_llm_spend_ledger.sql
\ir ../migrations/20261008030000_llm_spend_ledger.sql
\ir ../migrations/20261008030001_access_code_redemption.sql
\ir ../migrations/20261008030001_access_code_redemption.sql
\ir ../migrations/20261008030002_llm_spend_cutover.sql
\ir ../migrations/20261008030002_llm_spend_cutover.sql

-- ===========================================================================
-- Part 2: the carried-over spend is in the ledger exactly once, and the counters
-- are gone from the profile.
-- ===========================================================================
do $$
declare carried numeric; counters boolean;
begin
  select coalesce(sum(actual_usd), 0) into carried
  from public.llm_spend
  where user_id = 'bbbbbbbb-0000-0000-0000-000000000001' and model = 'carried-over';
  assert carried = 9.5, format('carry-over should be 9.5 once, got %s', carried);

  select (preferences -> 'budget') ?| array['spentUsd', 'periodStart'] into counters
  from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  assert counters is false, 'the old counters must be stripped from preferences.budget';

  assert (select (preferences #>> '{budget,monthlyUsd}')::numeric
          from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 10,
    'the user-editable cap must survive the cutover';
  assert to_regprocedure('public.record_llm_spend(uuid, numeric)') is null,
    'record_llm_spend must be gone';
end $$;

-- ===========================================================================
-- Part 3: resetting the old counter no longer frees anything. The user writes
-- the same preferences update as in Part 1, then asks for $1 more against the
-- $9.50 already in the ledger and a $10 cap: refused.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}', true);

update public.profiles
set preferences = jsonb_set(preferences, '{budget,spentUsd}', '0')
where id = 'bbbbbbbb-0000-0000-0000-000000000001';

-- The ledger is theirs to read and nobody's to write over the Data API.
do $$
begin
  assert (select count(*) from public.llm_spend) = 1, 'the owner reads exactly their own ledger rows';
  assert (select count(*) from public.llm_spend where user_id <> 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'another user''s ledger rows must be invisible';
  begin
    insert into public.llm_spend (user_id, period, model, estimate_usd, rung, step)
    values ('bbbbbbbb-0000-0000-0000-000000000001', now(), 'm', 0, 'R3', 'x');
    raise exception 'an authenticated insert into llm_spend must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.llm_spend set actual_usd = 0;
    raise exception 'an authenticated update of llm_spend must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.llm_spend;
    raise exception 'an authenticated delete from llm_spend must be denied';
  exception when insufficient_privilege then null;
  end;
  -- The functions are not callable from the Data API.
  begin
    perform public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000001', 'm', 0.01, 'R4', 'x', null, null);
    raise exception 'reserve_llm_spend must not be executable by authenticated';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.settle_llm_spend(gen_random_uuid(), 0, null);
    raise exception 'settle_llm_spend must not be executable by authenticated';
  exception when insufficient_privilege then null;
  end;
  -- Access codes: no direct writes, no function calls.
  begin
    insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'x', 'X', now() + interval '1 hour');
    raise exception 'an authenticated insert into access_codes must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.redeem_access_code(array['x']);
    raise exception 'redeem_access_code must not be executable by authenticated';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- A demo cannot raise its own cap over the Data API.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
begin
  begin
    update public.profiles
    set preferences = jsonb_set(preferences, '{budget,monthlyUsd}', '50')
    where id = 'bbbbbbbb-0000-0000-0000-000000000003';
    raise exception 'a demo must not be able to raise preferences.budget.monthlyUsd';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare r jsonb;
begin
  r := public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000001', 'anthropic/claude-sonnet-5', 1, 'R4', 'check');
  assert (r ->> 'ok')::boolean is false, 'a reset of the old counter must not free the cap';
  assert r ->> 'scope' = 'user', 'a user cap refusal carries scope user';
  r := public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000001', 'anthropic/claude-sonnet-5', 0.5, 'R4', 'check');
  assert (r ->> 'ok')::boolean is true, 'headroom under the cap is still admitted';
  -- A free call is admitted even though the paid headroom is nearly used, and
  -- writes a $0 row with its rung and step; a free rung cannot carry money.
  r := public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000001', 'google/gemma-4-31b-it:free', 0, 'R3', 'check');
  assert (r ->> 'ok')::boolean is true, 'a $0 reservation is never refused';
  assert (select rung = 'R3' and step = 'check' and estimate_usd = 0 and door is null
          from public.llm_spend where id = (r ->> 'id')::uuid), 'the free row carries rung and step and no door';
  begin
    perform public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000001', 'm', 0.01, 'R3', 'check');
    raise exception 'a free rung must not reserve money';
  exception when sqlstate '22023' then null;
  end;
  -- A demo nobody funds may still run free work.
  r := public.reserve_llm_spend('bbbbbbbb-0000-0000-0000-000000000003', 'llama3.1', 0, 'R2', 'check');
  assert (r ->> 'ok')::boolean is true, 'an unfunded demo may run a free call';
end $$;
reset role;

rollback;
