-- K15 learning: past applications order roles before any reaction exists.
--
-- `record_applied_reaction` (20261009000200) turns an application into an `applied`
-- reaction, but only when an application row is inserted or its stage changes from now
-- on. Every application made before that has no reaction, so `taste:blend` could not
-- count it. This file writes the missing ones, once, with the same select the trigger
-- uses. A role the person already reacted to is left alone (on conflict do nothing), and
-- a second run writes nothing.
--
-- Nothing else in K15 needs SQL: mem0 owns its schema, and the old `public.insights` and
-- `strategy_proposal_outcomes` tables are dropped by 20261015000001 after their rows move.

-- lane-stub: K5a person_roles
do $backfill$
begin
  if to_regclass('public.person_roles') is null or to_regclass('public.company_directory') is null then
    raise notice 'lane-stub: K5a person_roles absent, applied reaction backfill skipped';
    return;
  end if;

  insert into public.role_reactions (user_id, job_id, reaction, surface, job_title, company_name, job_location, job_text, predicted)
  select a.user_id, j.id, 'applied', 'applications', j.title, coalesce(d.name, c.name), j.location,
         left(j.title || E'\n' || coalesce(d.name, c.name, '') || E'\n' || coalesce(j.location, '') || E'\n' || coalesce(j.description, ''), 2000),
         case when pr.want_p is null then null
              else jsonb_build_object(
                'judge', (pr.want_detail ->> 'judge')::float8,
                'embedding', (pr.want_detail ->> 'embedding')::float8,
                'stated', (pr.want_detail ->> 'stated')::float8,
                'blended', pr.want_p,
                'chance', pr.chance)
         end
  from public.applications a
  join public.jobs j on j.id = a.job_id
  left join public.person_roles pr on pr.job_id = j.id and pr.user_id = a.user_id
  left join public.company_directory d on d.id = j.employer_id
  left join public.companies c on c.id = j.company_id
  where (a.stage in ('applied', 'screen', 'interview', 'offer', 'accepted') or a.applied_at is not null)
  on conflict (user_id, job_id) do nothing;

  if exists (
    select 1 from public.applications a
    join public.jobs j on j.id = a.job_id
    where (a.stage in ('applied', 'screen', 'interview', 'offer', 'accepted') or a.applied_at is not null)
      and not exists (select 1 from public.role_reactions r where r.user_id = a.user_id and r.job_id = j.id)
  ) then
    raise exception 'an application at applied or later is still without a reaction';
  end if;
end
$backfill$;

notify pgrst, 'reload schema';
