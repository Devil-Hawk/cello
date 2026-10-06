-- K7 scorecard: every measure of the register, seeded as watch, and the measures computed from the
-- database.
--
-- WHY
--   Directive 24: every capability has a named measure, a bar and a place the owner sees the number.
--   The register (blueprint 13.1) is seeded here as `watch`; the package named in `gates` flips its
--   rows to `gating` when it ships. lib/measures/register.ts holds the same rows and a test keeps
--   the two equal.
--
-- WHAT
--   public.measure_<id>() returns (value, passed, sample_n, note) for a measure that is computed from
--   the database. run_measure(id) runs one and writes a measure_runs row; run_true_measures() runs
--   every measure of the true layer whose function exists and is what the owner.health routine calls
--   once a day. A measure that has no function yet shows "No run yet".
--
--   The known failures of 2026-10-05 (blueprint 13.4) are pinned as measure_runs rows on S4, S1 and
--   T5, so the scorecard says what is not proven.

insert into public.measures (id, layer, name, bar, direction, source, gates) values
  ('T1', 'true', 'wrong-employer roles stored', '0', 'equal', 'live check-sourcing.ts on every followed employer', array['K6']::text[]),
  ('T2', 'true', 'roles shown older than 180 days', '0', 'equal', 'SQL over shown lists', array['K5a']::text[]),
  ('T3', 'true', 'stored roles outside every person''s targets (no-target rows counted apart)', '0', 'equal', 'SQL (directive 26)', array['K5a']::text[]),
  ('T4', 'true', 'followed employers that cannot be read', 'under 5 percent, each with a reason', 'lower', 'heartbeats', array['K4']::text[]),
  ('T5', 'true', 'hours since the last successful role check, per person', 'at most 7', 'lower', 'job_heartbeats', array['K4']::text[]),
  ('T6', 'true', 'hours since the last successful mail read, per connected person', 'at most 2', 'lower', 'job_heartbeats', array['K19']::text[]),
  ('T7', 'true', 'rows and bytes per person per table after a day of checks, no-target rows apart, description_md bytes on their own', 'reported; owner sets the bar after the first week', 'reported', 'catalog sizes', '{}'::text[]),
  ('T8', 'true', 'database size, with description_md bytes on their own', 'under 350 MB', 'lower', 'catalog', '{}'::text[]),
  ('T9', 'true', 'companies Cello followed for a person: watching = true not set by companies.follow from that person''s session, plus company_directory rows that did not pass the verifier', '0', 'equal', 'SQL', array['K5a', 'K6', 'K19']::text[]),
  ('T10', 'true', 'unconfirmed events moving a count', '0', 'equal', 'SQL over counts', array['K13']::text[]),
  ('T11', 'true', 'directory full-cycle days', 'reported, no bar until SP6', 'reported', 'heartbeats', '{}'::text[]),
  ('T12', 'true', 'numbers on screen traced to code', 'every one, in the pull request', 'equal', 'review', '{}'::text[]),
  ('T13', 'true', 'filled values equal to the person''s own values', 'every fixture field; at least 0.98 on the owner''s real sends, 0 wrong in a sensitive field', 'equal', 'fill fixtures in CI, then attempts against the owner''s record', array['K18', 'K21']::text[]),
  ('T14', 'true', 'automatic sends marked Sent without a seen confirmation', '0', 'equal', 'attempts and events', array['K21', 'K30']::text[]),
  ('T15', 'true', 'a second submit for one application', '0', 'equal', 'submission.sending events', array['K21', 'K30']::text[]),
  ('T16', 'true', 'Send for me stops handed to the person with their cause and never retried', 'every one', 'equal', 'stop fixtures, then events', array['K21', 'K30']::text[]),
  ('T17', 'true', 'duplicate stored roles (same employer and requisition id, or normalised title and location)', '0', 'equal', 'SQL', array['K5a']::text[]),
  ('T18', 'true', 'hours from posting to shown: followed employers; directory', 'at most 7; reported until SP6, then the owner''s bar', 'lower', 'posted_at against visible_since', array['K4', 'K6']::text[]),
  ('T19', 'true', 'share of new distinct titles decided by each tier (code, embedder, model, none); share of stored roles whose type needed a model; untyped stored roles', 'model under 15 percent of new titles a week [X]; untyped under 2 percent of stored roles; reported weekly', 'reported', 'title_types, jobs, roles.type heartbeats', array['K15b', 'K5c']::text[]),
  ('T20', 'true', 'while role_types_live is off: roles the type step would keep that the old filter drops, and the reverse, per person per day', 'reported', 'reported', 'person_counts (shadow_keep, shadow_drop)', array['K5c']::text[]),
  ('T21', 'true', 'description completeness: share of kept roles whose stored posting is the employer''s whole text, against a fresh read of the live page (token recall at least 0.98 [X]), on a weekly sample of 50 across tiers; partial postings with reasons; silent truncation', 'at least 0.95 complete; partial reported; silent truncation 0', 'higher', 'live re-read of the sample', array['K5d']::text[]),
  ('T22', 'true', 'page performance on a mid-range phone, per page (4.0a): LCP, Total Blocking Time, main-thread work, CLS, INP; the 3D chunk and first-load growth', 'LCP at most 2.5 s; TBT at most 200 ms; main thread at most 2.0 s, the layer at most 150 ms; CLS at most 0.05; INP at most 200 ms; 3D chunk at most 200 KB gzipped, first-load growth at most 5 KB', 'lower', 'Lighthouse CI and Playwright on fixtures in CI, then production weekly', array['PG0']::text[]),
  ('T23', 'true', 'browsing an employer''s open roles (companies.roles, roles.preview): jobs, person_roles and seen_postings rows written by browsing; the counted line''s buckets against the read''s total, on a weekly sample of 20 employers across tiers; share of reads that return a total or a named cannot-read reason', '0 rows; equal on every sampled read; 1.0', 'equal', 'SQL row counts before and after scripted browsing; live reads of the sample', array['K5b', 'K5d', 'PG7']::text[]),
  ('T24', 'true', 'directory search coverage: the share of the owner''s 35 real past employers (his trusted application history, S8''s set) that companies.search returns by name among its first 3 verified rows; each miss with its reason (not in the seed, still pending, failed check, cannot read); the seed''s verification progress', 'at least 34 of 35, every miss named; progress reported', 'higher', 'his 35 names run weekly; directory.sweep heartbeats', array['K6', 'PG11']::text[]),
  ('T25', 'true', 'add by link: the right outcome on 20 real careers links the owner picks (careers pages, boards and single postings across providers, with Retell AI''s careers page, a Workday host, a page with no board, a board another employer owns and an unused board among them): the right employer verified, added and followed, or Could not verify with the right reason and its offer', '20 of 20; 0 wrong employers added', 'reported', 'live runs of companies.add', array['K6', 'PG11']::text[]),
  ('T26', 'true', 'autodiscovery fill: share of the seed''s candidates verified or failed (not pending) within 30 days of the first directory.sweep slice; the first day''s count projected to the whole seed', 'at least 0.9 in 30 days; K6''s first day projects inside 30 days', 'higher', 'directory_candidates states, sweep heartbeats', array['K6', 'PG11']::text[]),
  ('T27', 'true', 'boundary checks kept from main: every old address redirects to its new home; a page or plain read in hour 73 of a demo is refused and the session refreshes on each request; a cross-site POST to every session command is refused; the clock and runner routes refuse a missing or bad signature; stdio tools and local command-line models refuse unless isSelfHosted(); a planted server error reaches Sentry scrubbed', 'every check passes', 'equal', 'CI route and source tests', array['K3', 'K4', 'K10', 'K25', 'PG1', 'PG9']::text[]),
  ('T28', 'true', 'sponsorship lines: every "Past H-1B filings" shown is traced to h1b-sponsors.json; any "does not sponsor"', 'every one; 0', 'equal', 'source test and fixtures', array['PG3', 'PG7', 'PG11']::text[]),
  ('T29', 'true', 'Chat''s workings: task lines equal their agent_tasks rows (research, drafts, chance, starts and checks of several employers); a turn''s shown cost equals its llm_spend sum; the model a turn ran on equals the choice, or ran names the step down; writes after Stop; time from Stop to stopped', 'every one; every one; every one; 0; under 5 s [X]', 'equal', 'fixtures, then production turns sampled weekly', array['K24d', 'PG9']::text[]),
  ('T30', 'true', 'Network extraction: of people network.sync kept, the share that are real people the owner has been in touch with about his search (not bots, bulk, relays or role inboxes); left-out counts by rule; real people found among 50 left out', 'at least 0.95; recall reported', 'higher', '100 kept and 50 left out from his 12 months, marked by him', array['K26']::text[]),
  ('T31', 'true', 'employer ties: share of people tied to the right employer and application; people whose employer came from a relay or a personal domain', 'at least 0.95; 0', 'higher', 'the same 100, marked by him', array['K26']::text[]),
  ('T32', 'true', 'follow-up nudges on scripted threads (yours unanswered, theirs unanswered, a reply that answered, weekends, a zone change, a person''s own rule, snooze, a closed application, two unanswered follow-ups, and a reply on Friday at 19:00, due Sunday at 19:00): due exactly when the rule says; any after the person answered', 'every one; 0', 'equal', 'fixture threads on a fixture clock, then the owner''s week', array['K26', 'PG12']::text[]),
  ('T33', 'true', 'What is working: each finding''s counts against hand counts on fixture events; unconfirmed events counted; findings shown below their threshold; a Keep that changes anything it does not name', 'every one equal; 0; 0; 0', 'equal', 'fixture events in CI, then the owner''s applications counted by hand', array['K19', 'PG5']::text[]),
  ('S1', 'step', 'requirements, item by item: precision (a real requirement of the posting, of the right kind) and quote rate (every quote verbatim in description_md)', 'precision at least 0.90; quotes 1.0; recall reported', 'higher', '50 postings the owner labels item by item', array['K5d', 'K17']::text[]),
  ('S2', 'step', 'role types: precision and recall per type; recall of the keep decision on the owner''s chosen types', 'per type with at least 10 labels: precision and recall at least 0.90; keep recall at least 0.95; under 10 labels "Too few to tell"', 'higher', '100 titles from the owner''s kept roles and application history, labelled by him; then his corrections and 100 directory titles sampled per tier', array['K5c', 'K15b']::text[]),
  ('S3', 'step', 'chance band agreement; Strong-for-Stretch swaps', 'at least 0.7; 0', 'higher', '60 roles labelled by the owner', array['K17']::text[]),
  ('S4', 'step', 'picks: precision at 5 against code order', 'a rise of at least 0.10', 'higher', 'the owner''s held-out reactions', array['K17']::text[]),
  ('S5', 'step', 'tailoring: uncited lines; Reviewer pass', '0; at least 0.8', 'equal', '10 real postings, the owner''s resume', array['K17']::text[]),
  ('S6', 'step', 'drafts pass code checks first try; invented claims', 'at least 0.9; 0', 'higher', 'outputs sets', array['K17']::text[]),
  ('S7', 'step', 'Reviewer catches planted invented claims', 'at least 0.9', 'higher', 'claims set', array['K17']::text[]),
  ('S8', 'step', 'mail: precision of linked applications; recall against the owner''s 35', 'at least 0.95; at least 0.9', 'higher', 'the owner''s mailbox, 12 months', array['K19']::text[]),
  ('S9', 'step', 'employer from email accepted wrongly', '0', 'equal', '100 owner mails', array['K19']::text[]),
  ('S10', 'step', 'answer category; sensitive recall; near pairs matched', '0.9; 0.95; 0', 'equal', '120 public questions', array['K16']::text[]),
  ('S11', 'step', 'rendered read: links not on the page; recall', '0; at least 0.8', 'equal', '20 pages', array['K4']::text[]),
  ('S12', 'step', 'embed recall at 5 over words-only', 'above words-only', 'higher', '50 queries', '{}'::text[]),
  ('S13', 'step', 'research claims citing a fetched source', '1.0', 'equal', 'research set', array['K24b']::text[]),
  ('S14', 'step', 'Chat command selection; person-only and injection writes, the injection set including Cello''s own answer text quoted back by selection as if typed', 'at or above a re-measured baseline; 0', 'reported', 'Chat sets', array['K24b']::text[]),
  ('S15', 'step', 'judge agreement with the owner''s labels', 'at least 0.8', 'higher', '50 owner-labelled pairs per judged step', array['K17', 'K24b']::text[]),
  ('S16', 'step', 'learnings: reads used before Keep; planted instructions made active', '0; 0', 'equal', 'learning set', array['K15']::text[]),
  ('S17', 'step', 'agency and repost labels: precision', 'at least 0.9', 'higher', '50 roles labelled by the owner', array['K6']::text[]),
  ('S18', 'step', 'people.find "how sure" against checked emails', 'stated sureness within 10 points of the observed rate per band', 'reported', '50 emails the owner checks', array['K26']::text[]),
  ('S19', 'step', 'each skill''s eval set', 'the skill''s own bar, set with its set', 'reported', 'skill evals', '{}'::text[]),
  ('S20', 'step', 'strengths and gaps: precision of Strength and of Gap; quotes found in their cited source; Not found (code) scored apart as the share the owner marks as held under other words, reported', 'Strength at least 0.90, Gap at least 0.85; quotes 1.0', 'reported', '30 of the owner''s kept roles, each requirement''s verdict marked by him', array['K17b']::text[]),
  ('S21', 'step', 'answers about many things: on 10 scripted asks over chats with 3 to 6 attached roles, companies, applications and people, the share of answer parts whose about names the right objects, and facts (numbers, dates, quotes) tied to the wrong object', 'at least 0.95 of parts right; 0 facts on the wrong object', 'higher', '10 asks the owner writes and labels part by part, run on R2 and R3', array['K24b']::text[]),
  ('S22', 'step', 'recall across chats: on 10 scripted pairs (a first chat states a fact, makes a comparison or takes a decision; a later new chat with no tiles refers to it in words only), the right earlier item used and its source chat shown; recall from another person''s chats', 'at least 9 of 10 on R2 and R3; 0 from another person', 'higher', '10 pairs the owner writes, on the demo seed and his own account', array['K24c']::text[]),
  ('S23', 'step', 'name lookup (companies.resolve_name): on 10 company names the owner picks that companies.search cannot find, the employer''s right domain proposed, and wrong employers added after the verifier', 'at least 8 of 10; 0 wrong employers', 'higher', '10 names he picks, run live on R1 and R2', array['K6', 'PG11']::text[]),
  ('S24', 'step', 'recent hires (later): share of people shown as recently hired whose cited page names them, the employer and a join date inside the window', 'at least 0.95; 0 without a source', 'higher', '30 the owner checks', array['K31']::text[]),
  ('S25', 'step', 'public profiles: share of kept profiles that are the right person, on 20 contacts the owner marks; profiles from behind a login or from a page Cello opened', 'at least 0.9 (18 of 20); 0', 'higher', '20 contacts he marks, run on R1 and R2', array['K26']::text[]),
  ('S26', 'step', 'person memories: quotes verbatim in their message; share the owner marks right; planted instructions in mail that change anything', '1.0; at least 0.9 of 30; 0', 'reported', '30 memories from his mail; a planted-mail set', array['K26']::text[]),
  ('P1', 'person', 'share of shown roles marked Interested; Not for me reasons that are role type, level or place', 'rising over 6 weeks; under 10 percent', 'higher', 'the person''s reactions', '{}'::text[]),
  ('P2', 'person', 'edit size on drafts (diff-words-v1, median)', 'falling; bar by the owner', 'lower', 'feedback_events', '{}'::text[]),
  ('P3', 'person', 'minutes per application, Ready to sent', 'bar by the owner', 'reported', 'fill and submission events', '{}'::text[]),
  ('P4', 'person', 'replies and interviews per 10 applications against the person''s email history before Cello', 'above the baseline', 'higher', 'trusted events and the pre-Cello mailbox', '{}'::text[]),
  ('P5', 'person', 'free requests per active day; days hitting the 429; Needs you rows that waited for the limit; share using each door', 'reported', 'reported', 'llm_spend', '{}'::text[]),
  ('P6', 'person', 'a no-model person completes Welcome, reacts, applies as is, fills, tracks a reply, sees Results', 'passes', 'reported', 'task test', array['PG1', 'PG5']::text[]),
  ('P7', 'person', 'the owner clears Needs you in under 3 minutes and flags no row as wrong in a week', 'passes', 'reported', 'owner''s days', '{}'::text[]),
  ('P8', 'person', 'Chat page task success on the demo flows: the seven requests of 5.6, an empty chat''s suggestion, switching the model for one message and reading its cost, opening a made thing in the side panel and saving an edit, stopping one worker, editing an earlier turn, a quick chat from a record, reopening an earlier chat''s draft, attaching a second role and a company and removing one, referring to an earlier chat with "@" (a chip in the composer, a tile once sent, and a chip removed before sending attaches nothing), following a made thing to its object with its provenance', 'every flow passes scripted on R2 and R3; 4 of 5 strangers finish each unaided', 'equal', 'demo seed, stranger sessions', array['PG9']::text[]),
  ('P9', 'person', 'the taste panel on the dimensional layer (4.0a), per page at 390 and 1440, WebGL on and off', 'the owner says yes on every page; 0 blocking tells from either reviewer', 'reported', 'the owner and both reviewers', array['PG0']::text[])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- T4: followed employers that cannot be read
-- ---------------------------------------------------------------------------
create or replace function public.measure_t4()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_followed integer;
  n_cannot integer;
  n_no_reason integer;
  n_reading integer;
begin
  select count(*),
         count(*) filter (where c.metadata->'source_check'->>'readable' = 'false' and coalesce(c.metadata->'source_check'->>'reason', '') <> 'reading'),
         count(*) filter (where c.metadata->'source_check'->>'readable' = 'false' and coalesce(c.metadata->'source_check'->>'reason', '') = ''),
         count(*) filter (where c.metadata->'source_check'->>'reason' = 'reading')
    into n_followed, n_cannot, n_no_reason, n_reading
    from public.companies c
   where (c.metadata->>'suggested' is null or c.metadata->>'suggested' <> 'true')
     and (nullif(btrim(coalesce(c.career_url, '')), '') is not null or c.metadata ? 'ats');
  if n_followed = 0 then
    return query select null::numeric, null::boolean, 0, 'No followed employers yet.'::text;
    return;
  end if;
  return query select
    round(100.0 * n_cannot / n_followed, 2),
    (100.0 * n_cannot / n_followed) < 5 and n_no_reason = 0,
    n_followed,
    format('%s of %s followed employers cannot be read; %s without a reason; %s waiting for a browser read.', n_cannot, n_followed, n_no_reason, n_reading);
end;
$$;

-- ---------------------------------------------------------------------------
-- T5: hours since the last successful role check, per person (the worst one)
-- ---------------------------------------------------------------------------
create or replace function public.measure_t5()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_people integer;
  worst numeric;
  n_late integer;
begin
  select count(*),
         max(extract(epoch from (now() - coalesce(h.succeeded_at, r.created_at))) / 3600.0),
         count(*) filter (where extract(epoch from (now() - coalesce(h.succeeded_at, r.created_at))) / 3600.0 > 7)
    into n_people, worst, n_late
    from public.routines r
    left join public.job_heartbeats h on h.job = r.command and h.user_id = r.user_id
   where r.command = 'roles.check' and r.user_id is not null and r.enabled;
  if n_people = 0 then
    return query select null::numeric, null::boolean, 0, 'No one has a role check yet.'::text;
    return;
  end if;
  return query select
    round(worst, 2),
    worst <= 7,
    n_people,
    format('%s of %s people have gone more than 7 hours without a successful check.', n_late, n_people);
end;
$$;

-- ---------------------------------------------------------------------------
-- T8: database size
-- ---------------------------------------------------------------------------
create or replace function public.measure_t8()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  mb numeric;
  body_bytes bigint := 0;
begin
  mb := pg_database_size(current_database()) / 1048576.0;
  -- The posting text is the biggest column Cello adds; it is counted on its own once it exists.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'description_md'
  ) then
    execute 'select coalesce(sum(octet_length(description_md)), 0) from public.jobs' into body_bytes;
  end if;
  return query select
    round(mb, 1),
    mb < 350,
    null::integer,
    format('The database is %s MB; description_md is %s MB of it. The free plan stops at 500 MB.', round(mb, 1), round(body_bytes / 1048576.0, 1));
end;
$$;

-- ---------------------------------------------------------------------------
-- T18: hours from posting to shown, followed employers (90th percentile)
-- ---------------------------------------------------------------------------
create or replace function public.measure_t18()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  p90 numeric;
begin
  select count(*),
         percentile_cont(0.9) within group (order by extract(epoch from (j.discovered_at - j.posted_at)) / 3600.0)
    into n, p90
    from public.jobs j
    join public.companies c on c.id = j.company_id
   where j.posted_at > now() - interval '14 days'
     and j.discovered_at >= j.posted_at
     and (c.metadata->>'suggested' is null or c.metadata->>'suggested' <> 'true');
  if n = 0 then
    return query select null::numeric, null::boolean, 0, 'No role posted in the last 14 days has been read yet.'::text;
    return;
  end if;
  return query select
    round(p90::numeric, 1),
    p90 <= 7,
    n,
    format('The 90th percentile of %s roles posted in the last 14 days, from the posting time to the first read. Some providers give only a date, which reads as late.', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Running a measure
-- ---------------------------------------------------------------------------
create or replace function public.run_measure(p_id text)
returns public.measure_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  out public.measure_runs;
begin
  if to_regprocedure(format('public.measure_%s()', lower(p_id))) is null then
    raise exception 'measure % is not computed from the database', p_id using errcode = 'undefined_function';
  end if;
  execute format('select * from public.measure_%s()', lower(p_id)) into r;
  insert into public.measure_runs (measure_id, value, passed, sample_n, note)
  values (upper(p_id), r.value, r.passed, r.sample_n, r.note)
  returning * into out;
  return out;
end;
$$;

-- Every measure of the true layer that has a function. One that fails to run is a failing row.
create or replace function public.run_true_measures()
returns setof public.measure_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  out public.measure_runs;
begin
  for m in
    select id from public.measures
     where layer = 'true' and to_regprocedure(format('public.measure_%s()', lower(id))) is not null
     order by id
  loop
    begin
      out := public.run_measure(m.id);
    exception when others then
      insert into public.measure_runs (measure_id, passed, note)
      values (m.id, false, 'The measure did not run (' || sqlstate || ').')
      returning * into out;
    end;
    return next out;
  end loop;
  return;
end;
$$;

revoke all on function public.measure_t4(), public.measure_t5(), public.measure_t8(), public.measure_t18() from public, anon, authenticated;
revoke all on function public.run_measure(text), public.run_true_measures() from public, anon, authenticated;
grant execute on function public.measure_t4(), public.measure_t5(), public.measure_t8(), public.measure_t18() to service_role;
grant execute on function public.run_measure(text), public.run_true_measures() to service_role;

-- ---------------------------------------------------------------------------
-- The known failures of 2026-10-05 (blueprint 13.4), pinned so the scorecard never hides them.
-- ---------------------------------------------------------------------------
insert into public.measure_runs (measure_id, ran_at, value, passed, sample_n, note)
select v.measure_id, timestamptz '2026-10-05 12:00:00+00', v.value, false, null, v.note
from (values
  ('S4', 0.70::numeric, 'Pinned 2026-10-05: the shortlist''s proof bar was not met. Precision at 5 stayed at 0.70 against a required rise of 0.10. The shortlist is not proven.'),
  ('S1', 0.78::numeric, 'Pinned 2026-10-05: requirement extraction measured 0.78 to 0.81 against 0.90. It is not proven.'),
  ('T5', null::numeric, 'Pinned 2026-10-05: no scheduled role check has succeeded for the owner on production. GitHub started the 6-hourly job once in 14 hours, two hours late, and it failed.')
) as v (measure_id, value, note)
where not exists (
  select 1 from public.measure_runs r where r.measure_id = v.measure_id and r.note like 'Pinned 2026-10-05:%'
);

do $$
begin
  if (select count(*) from public.measures) < 68 then
    raise exception 'the register must hold every measure of 13.1';
  end if;
  if has_function_privilege('anon', 'public.run_measure(text)', 'execute')
     or has_function_privilege('authenticated', 'public.run_true_measures()', 'execute') then
    raise exception 'measures must not be runnable by client roles';
  end if;
end
$$;
