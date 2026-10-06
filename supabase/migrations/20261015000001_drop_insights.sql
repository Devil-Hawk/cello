-- K15, post-deploy: drop the second store of what Cello learned.
--
-- Everything `public.insights` and `public.strategy_proposal_outcomes` held now lives in
-- mem0 (the `learnings` collection): scripts/learning-move.ts moved the active insight rows
-- as proposals (key earlier:<row id>) and the accepted proposals as active outcome learnings
-- (key outcome:accepted:...). Nothing reads either table any more, and the six distiller
-- functions and the two insight functions served only them.
--
-- Apply only after the move ran in this environment and the deploy that stopped reading the
-- tables is live. This file refuses to run otherwise: it counts what mem0 holds and raises
-- when that is fewer than what these tables still hold.

do $guard$
declare
  insights_active bigint := 0;
  insights_moved  bigint := 0;
  outcomes_rows   bigint := 0;
  outcomes_moved  bigint := 0;
begin
  if to_regclass('public.insights') is not null then
    select count(*) into insights_active from public.insights where status = 'active';
  end if;
  if to_regclass('public.strategy_proposal_outcomes') is not null then
    select count(*) into outcomes_rows from public.strategy_proposal_outcomes;
  end if;

  -- mem0 creates its own table; read its real name and payload column (id, vector, payload).
  if to_regclass('mem0.learnings') is not null then
    execute $q$select count(*) from mem0.learnings where payload->>'key' like 'earlier:%' and payload->>'key' not like 'earlier:mem0:%'$q$ into insights_moved;
    execute $q$select count(*) from mem0.learnings where payload->>'key' like 'outcome:accepted:%'$q$ into outcomes_moved;
  end if;

  if insights_moved < insights_active then
    raise exception 'refusing to drop public.insights: % active rows, only % moved to mem0 (run scripts/learning-move.ts first)', insights_active, insights_moved;
  end if;
  if outcomes_moved < outcomes_rows then
    raise exception 'refusing to drop public.strategy_proposal_outcomes: % rows, only % moved to mem0 (run scripts/learning-move.ts first)', outcomes_rows, outcomes_moved;
  end if;
end
$guard$;

drop function if exists public.search_insights(uuid, extensions.vector, text[], integer);
drop function if exists public.upsert_insight(uuid, text, text, jsonb, real, text, uuid);
drop function if exists public.distill_match_score_by_score_band(uuid);
drop function if exists public.distill_match_score_by_source(uuid);
drop function if exists public.distill_draft_by_seniority(uuid);
drop function if exists public.distill_outreach_by_company(uuid);
drop function if exists public.distill_chance_by_label(uuid);
drop function if exists public.distill_chance_by_source(uuid);

drop table if exists public.insights;
drop table if exists public.strategy_proposal_outcomes;

do $check$
begin
  if to_regclass('public.insights') is not null or to_regclass('public.strategy_proposal_outcomes') is not null then
    raise exception 'an old learning table is still there';
  end if;
  if exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace
      and (proname like 'distill\_%' or proname in ('search_insights', 'upsert_insight'))
  ) then
    raise exception 'an old learning function is still there';
  end if;
end
$check$;

notify pgrst, 'reload schema';
