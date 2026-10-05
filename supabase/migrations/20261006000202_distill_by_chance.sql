-- Reward-loop candidates grouped by Cello's chance call instead of the retired
-- 0-100 match score (see 20261006000201).
--
-- The question these answer is the one the strategy panel asks: does Cello's
-- chance call predict how an application goes? Positive is an application that
-- reached interview, offer or accepted; negative is rejected. Applications still
-- waiting are excluded from both, the same discipline as the functions they
-- replace.
--
-- The old candidates carried the eval_verdicts rows that graded each score.
-- A chance call is read off the job row, so there are no verdict rows to name and
-- verdict_ids is empty; the evidence is the applications themselves.
--
-- SECURITY INVOKER with an explicit p_user_id on every table joined, as before.

drop function if exists public.distill_match_score_by_score_band(uuid);
drop function if exists public.distill_match_score_by_source(uuid);

create or replace function public.distill_chance_by_label(p_user_id uuid)
returns table (band text, positive_count bigint, negative_count bigint, verdict_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  select
    j.chance as band,
    count(*) filter (where a.stage in ('interview', 'offer', 'accepted')) as positive_count,
    count(*) filter (where a.stage = 'rejected') as negative_count,
    '{}'::uuid[] as verdict_ids
  from public.applications a
  join public.jobs j on j.id = a.job_id
  where a.user_id = p_user_id
    and j.chance in ('strong', 'possible', 'stretch')
    and a.stage in ('interview', 'offer', 'accepted', 'rejected')
  group by j.chance;
$$;

comment on function public.distill_chance_by_label(uuid) is
  'Distillation candidate rows: Cello''s chance label (strong, possible, stretch) -> stage-progression outcome, per-class counts.';

create or replace function public.distill_chance_by_source(p_user_id uuid)
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
    '{}'::uuid[] as verdict_ids
  from public.applications a
  join public.jobs j on j.id = a.job_id
  where a.user_id = p_user_id
    and j.chance in ('strong', 'possible', 'stretch')
    and a.stage in ('interview', 'offer', 'accepted', 'rejected')
  group by coalesce(j.source, 'unknown');
$$;

comment on function public.distill_chance_by_source(uuid) is
  'Distillation candidate rows: job source -> stage-progression outcome among roles with a chance call, per-class counts.';

revoke all on function public.distill_chance_by_label(uuid) from public, anon;
revoke all on function public.distill_chance_by_source(uuid) from public, anon;
grant execute on function public.distill_chance_by_label(uuid) to authenticated, service_role;
grant execute on function public.distill_chance_by_source(uuid) to authenticated, service_role;

do $$
begin
  if to_regprocedure('public.distill_chance_by_label(uuid)') is null then
    raise exception 'public.distill_chance_by_label was not created';
  end if;
  if to_regprocedure('public.distill_chance_by_source(uuid)') is null then
    raise exception 'public.distill_chance_by_source was not created';
  end if;
  if to_regprocedure('public.distill_match_score_by_score_band(uuid)') is not null then
    raise exception 'the match score distillation function is still there';
  end if;
end
$$;

notify pgrst, 'reload schema';
