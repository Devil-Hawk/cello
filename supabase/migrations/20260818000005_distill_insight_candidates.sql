-- Reward-loop distillation candidates (langgraph port design doc Step 6,
-- lib/graph/distill.ts#distillInsights): four SQL aggregates that join
-- eval_verdicts to their real-world outcome and group by one feature
-- dimension each — "per-class counts computed in SQL first" (invariant 7's
-- floor-before-spend, applied to the distiller): distillInsights checks
-- positive_count/negative_count against MIN_SAMPLE_PER_CLASS BEFORE calling
-- callLlm for a candidate, and these functions are what hand it those counts
-- pre-grouped rather than raw eval_verdicts rows to count in application
-- code. Every candidate carries `verdict_ids` (the exact eval_verdicts rows
-- that fed its counts) straight through into the insight's evidence jsonb —
-- lib/insights/store.ts#ingestInsight's "auditable back to raw signals."
--
-- WHY FOUR FUNCTIONS, NOT ONE PARAMETERIZED ONE
-- Each groups a different join shape (jobs+applications, application_drafts+
-- jobs, outreach_messages alone) by a different column. A single dynamic-SQL
-- function would need to interpolate the GROUP BY expression from a text
-- argument — exactly the injection surface a fixed, named function per shape
-- avoids, and it matches this migration's own precedent (search_insights,
-- upsert_insight, find_company_merge_candidates are each one job, one
-- function).
--
-- WHY POSITIVE/NEGATIVE ONLY, AMBIGUOUS ROWS EXCLUDED FROM BOTH
-- Same discipline as lib/evals/harness.ts#rankingAuc (positives/negatives
-- only) and lib/strategy/bucket.ts: an application still sitting at
-- 'applied'/'screen', an outreach reply classified 'neutral', or a draft
-- still 'pending_review' is not yet a verdict on the underlying pattern —
-- counting it as either class would dilute a real signal with an undecided
-- one. Every WHERE clause below restricts to the decided outcomes ONLY, so
-- positive_count + negative_count always equals the group's row count and
-- verdict_ids always names exactly those rows.
--
-- COMPANY SIZE IS NOT BUCKETED HERE ON PURPOSE
-- distill_outreach_by_company groups by raw company_id, not a small/large
-- band — bucketing needs lib/entities/companies.ts#trackedRoleCount (the
-- one company-size accessor, see that file), which chases a company through
-- its merge-canonical id first. That correctness step belongs in application
-- code, not duplicated as a second, divergent size proxy in SQL; this
-- function's job ends at "per-class counts computed in SQL first," and
-- lib/graph/distill.ts does the (cheap, already-tiny-result-set) bucket+sum
-- pass before the floor check runs.
--
-- SECURITY INVOKER + explicit p_user_id predicates on every table joined:
-- same justification as search_insights/search_kb_chunks — correct whether
-- called by the service-role admin client (the only caller today,
-- lib/graph/distill.ts) or a future cookie-scoped RLS client, because RLS
-- would independently enforce the same scoping for the latter.
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

-- ---------------------------------------------------------------------------
-- distill_match_score_by_score_band — outcome: applications stage
-- progression (interview/offer/accepted = positive, rejected = negative).
-- Dimension: match_score banded 0-49/50-69/70-84/85-100, the same boundaries
-- lib/strategy/questions/matchScoreAccuracy.ts's BANDS use (mirrors
-- lib/format.ts's matchTone bands — see that file's own comment).
-- ---------------------------------------------------------------------------
create or replace function public.distill_match_score_by_score_band(p_user_id uuid)
returns table (band text, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    case
      when j.match_score <= 49 then '0-49'
      when j.match_score <= 69 then '50-69'
      when j.match_score <= 84 then '70-84'
      else '85-100'
    end as band,
    count(*) filter (where a.stage in ('interview', 'offer', 'accepted')) as positive_count,
    count(*) filter (where a.stage = 'rejected') as negative_count,
    array_agg(v.id) as verdict_ids
  from public.eval_verdicts v
  join public.jobs j on j.id = v.subject_id
  join public.applications a on a.job_id = j.id and a.user_id = p_user_id
  where v.user_id = p_user_id
    and v.subject_kind = 'match_score'
    and j.match_score is not null
    and a.stage in ('interview', 'offer', 'accepted', 'rejected')
  group by band;
$$;

comment on function public.distill_match_score_by_score_band(uuid) is
  'Distillation candidate rows: match_score band -> stage-progression outcome, per-class counts + contributing verdict ids.';

grant execute on function public.distill_match_score_by_score_band(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- distill_match_score_by_source — same outcome, grouped by jobs.source
-- (the ingest adapter/source id, e.g. 'greenhouse'/'lever') instead of score.
-- ---------------------------------------------------------------------------
create or replace function public.distill_match_score_by_source(p_user_id uuid)
returns table (band text, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    coalesce(j.source, 'unknown') as band,
    count(*) filter (where a.stage in ('interview', 'offer', 'accepted')) as positive_count,
    count(*) filter (where a.stage = 'rejected') as negative_count,
    array_agg(v.id) as verdict_ids
  from public.eval_verdicts v
  join public.jobs j on j.id = v.subject_id
  join public.applications a on a.job_id = j.id and a.user_id = p_user_id
  where v.user_id = p_user_id
    and v.subject_kind = 'match_score'
    and a.stage in ('interview', 'offer', 'accepted', 'rejected')
  group by band;
$$;

comment on function public.distill_match_score_by_source(uuid) is
  'Distillation candidate rows: job source -> stage-progression outcome, per-class counts + contributing verdict ids.';

grant execute on function public.distill_match_score_by_source(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- distill_draft_by_seniority — outcome: a human review decision on a
-- cv_tailor draft (application_drafts.status + reviewed_at, ruling 4).
-- Dimension: jobs.seniority (already a band — intern|junior|...|unknown).
-- ---------------------------------------------------------------------------
create or replace function public.distill_draft_by_seniority(p_user_id uuid)
returns table (band text, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    coalesce(j.seniority, 'unknown') as band,
    count(*) filter (where d.status = 'approved') as positive_count,
    count(*) filter (where d.status = 'rejected') as negative_count,
    array_agg(v.id) as verdict_ids
  from public.eval_verdicts v
  join public.application_drafts d on d.id = v.subject_id
  join public.jobs j on j.id = d.job_id
  where v.user_id = p_user_id
    and v.subject_kind = 'cv_tailor_draft'
    and d.user_id = p_user_id
    and d.reviewed_at is not null
    and d.status in ('approved', 'rejected')
  group by band;
$$;

comment on function public.distill_draft_by_seniority(uuid) is
  'Distillation candidate rows: job seniority band -> draft approve/reject outcome, per-class counts + contributing verdict ids.';

grant execute on function public.distill_draft_by_seniority(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- distill_outreach_by_company — outcome: an outreach reply's classification
-- (ruling 4's replied_at/reply_classification columns; positive = reply
-- classified 'positive', negative = 'negative' or 'bounce' — 'neutral' and
-- not-yet-replied rows are ambiguous, excluded from both classes same as
-- every other function above). Grouped by RAW company_id — see this file's
-- header for why the small/large bucket is computed in application code,
-- not here.
-- ---------------------------------------------------------------------------
create or replace function public.distill_outreach_by_company(p_user_id uuid)
returns table (company_id uuid, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    o.company_id,
    count(*) filter (where o.reply_classification = 'positive') as positive_count,
    count(*) filter (where o.reply_classification in ('negative', 'bounce')) as negative_count,
    array_agg(v.id) as verdict_ids
  from public.eval_verdicts v
  join public.outreach_messages o on o.id = v.subject_id
  where v.user_id = p_user_id
    and v.subject_kind = 'outreach_draft'
    and o.user_id = p_user_id
    and o.company_id is not null
    and o.reply_classification in ('positive', 'negative', 'bounce')
  group by o.company_id;
$$;

comment on function public.distill_outreach_by_company(uuid) is
  'Distillation candidate rows: outreach reply outcome per company_id (small/large bucketing happens in lib/graph/distill.ts via the entities accessor), per-class counts + contributing verdict ids.';

grant execute on function public.distill_outreach_by_company(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POSTCONDITION
-- ---------------------------------------------------------------------------
do $$
begin
    if to_regprocedure('public.distill_match_score_by_score_band(uuid)') is null then
        raise exception 'public.distill_match_score_by_score_band was not created';
    end if;
    if to_regprocedure('public.distill_match_score_by_source(uuid)') is null then
        raise exception 'public.distill_match_score_by_source was not created';
    end if;
    if to_regprocedure('public.distill_draft_by_seniority(uuid)') is null then
        raise exception 'public.distill_draft_by_seniority was not created';
    end if;
    if to_regprocedure('public.distill_outreach_by_company(uuid)') is null then
        raise exception 'public.distill_outreach_by_company was not created';
    end if;
end
$$;

notify pgrst, 'reload schema';
