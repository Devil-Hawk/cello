-- Retire the 0-100 match score.
--
-- Nothing writes jobs.match_score or jobs.match_details any more: roles are
-- filtered on facts the person stated, ranked by what they want
-- (person_roles.want_p), and judged on their chance with cited evidence
-- (person_roles.chance, see 20261009000200). Old values are cleared so a stale percentage can never
-- resurface on a screen that has not been told it is gone.
--
-- The columns stay for one release so a rollback is possible and nothing that
-- still selects them breaks. They are dropped after release 2.

update public.jobs
set match_score = null, match_details = null
where match_score is not null or match_details is not null;

comment on column public.jobs.match_score is
  'Retired 2026-10-06. Nothing writes it. Read person_roles.chance, want_p and want_reason instead. Dropped after release 2.';
comment on column public.jobs.match_details is
  'Retired 2026-10-06. Nothing writes it. Read person_roles.chance_detail and want_detail instead. Dropped after release 2.';

-- The match-score verdicts graded a number that no longer exists.
delete from public.eval_verdicts where subject_kind = 'match_score';

-- The same percentage lives on the person's own row once K5a moves it there.
-- lane-stub: K5a person_roles
do $stub$
begin
  if to_regclass('public.person_roles') is null then
    raise notice 'lane-stub: K5a person_roles absent, person_roles.match_score not cleared';
    return;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'person_roles' and column_name = 'match_score'
  ) then
    raise notice 'lane-stub: person_roles has no match_score, nothing to clear';
    return;
  end if;

  update public.person_roles
  set match_score = null, match_details = null
  where match_score is not null or match_details is not null;
end
$stub$;

do $$
begin
  if exists (select 1 from public.jobs where match_score is not null or match_details is not null) then
    raise exception 'match_score values remain after retirement';
  end if;
end
$$;

notify pgrst, 'reload schema';
