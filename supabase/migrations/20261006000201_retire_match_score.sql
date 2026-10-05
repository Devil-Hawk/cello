-- Retire the 0-100 match score.
--
-- Nothing writes jobs.match_score or jobs.match_details any more: roles are
-- filtered on facts the person stated, ranked by what they want (jobs.want_p),
-- and judged on their chance with cited evidence (jobs.chance, see
-- 20261006000200). Old values are cleared so a stale percentage can never
-- resurface on a screen that has not been told it is gone.
--
-- The columns stay for one release so a rollback is possible and nothing that
-- still selects them breaks. They are dropped after release 2.

update public.jobs
set match_score = null, match_details = null
where match_score is not null or match_details is not null;

comment on column public.jobs.match_score is
  'Retired 2026-10-06. Nothing writes it. Read chance, want_p and want_reason instead. Dropped after release 2.';
comment on column public.jobs.match_details is
  'Retired 2026-10-06. Nothing writes it. Read chance_detail and want_detail instead. Dropped after release 2.';

-- The match-score verdicts graded a number that no longer exists.
delete from public.eval_verdicts where subject_kind = 'match_score';

do $$
begin
  if exists (select 1 from public.jobs where match_score is not null or match_details is not null) then
    raise exception 'match_score values remain after retirement';
  end if;
end
$$;

notify pgrst, 'reload schema';
