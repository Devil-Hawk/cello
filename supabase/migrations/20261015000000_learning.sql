-- K15 learning: past applications order roles before any reaction exists.
--
-- `record_applied_reaction` (20261009000200) turns an application into an `applied`
-- reaction, but only when an application row is inserted or its stage changes from now
-- on. Every application made before that has no reaction, so `taste:blend` could not
-- count it. This file writes the missing ones, once, with the same select the trigger
-- uses. A role the person already reacted to is left alone (on conflict do nothing), and
-- a second run writes nothing.
--
-- Until the employer and role work (K5a) is in this database, the trigger's select cannot
-- run as written: there is no person_roles for Cello's earlier prediction and no
-- company_directory for the employer's name. The backfill then writes the same reaction
-- from the company on the job row and without a prediction. The prediction is only a
-- snapshot for the blend's fit, so a reaction without one is still a reaction.
--
-- Nothing else in K15 needs SQL: mem0 owns its schema, and the old `public.insights` and
-- `strategy_proposal_outcomes` tables are dropped by 20261015000001 after their rows move.

-- lane-stub: K5a person_roles
do $backfill$
declare
  k5a boolean := to_regclass('public.person_roles') is not null and to_regclass('public.company_directory') is not null;
  name_expr text := case when k5a then 'coalesce(d.name, c.name)' else 'c.name' end;
  joins text := case when k5a
    then 'left join public.person_roles pr on pr.job_id = j.id and pr.user_id = a.user_id left join public.company_directory d on d.id = j.employer_id'
    else '' end;
  predicted text := case when k5a
    then $p$case when pr.want_p is null then null
                 else jsonb_build_object(
                   'judge', (pr.want_detail ->> 'judge')::float8,
                   'embedding', (pr.want_detail ->> 'embedding')::float8,
                   'stated', (pr.want_detail ->> 'stated')::float8,
                   'blended', pr.want_p,
                   'chance', pr.chance)
            end$p$
    else 'null::jsonb' end;
begin
  execute format($sql$
    insert into public.role_reactions (user_id, job_id, reaction, surface, job_title, company_name, job_location, job_text, predicted)
    select a.user_id, j.id, 'applied', 'applications', j.title, %1$s, j.location,
           left(j.title || E'\n' || coalesce(%1$s, '') || E'\n' || coalesce(j.location, '') || E'\n' || coalesce(j.description, ''), 2000),
           %2$s
    from public.applications a
    join public.jobs j on j.id = a.job_id
    left join public.companies c on c.id = j.company_id
    %3$s
    where (a.stage in ('applied', 'screen', 'interview', 'offer', 'accepted') or a.applied_at is not null)
    on conflict (user_id, job_id) do nothing
  $sql$, name_expr, predicted, joins);

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
