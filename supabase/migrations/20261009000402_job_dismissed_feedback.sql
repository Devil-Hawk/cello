-- "Not for me" on a role is feedback on the call that assessed it.
--
-- The role reactions table comes from the scoring work (migration 200 range) and
-- the assessment's trace is on the person's own person_roles row. When the
-- reactions table exists, a reaction of not_for_me queues a job_dismissed event on
-- the job, with the reason as its comment. When it does not exist yet this
-- migration does nothing and says so; run it again after the scoring
-- migrations land and the trigger is created.

create or replace function public.feedback_from_role_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
begin
  -- lane-stub: K5a person_roles
  if to_regclass('public.person_roles') is not null
     and new.reaction = 'not_for_me' and (tg_op = 'INSERT' or old.reaction is distinct from 'not_for_me') then
    select pr.trace_id, pr.observation_id, coalesce(pr.assessed_at, pr.visible_since) as traced_at
      into j from public.person_roles pr where pr.user_id = new.user_id and pr.job_id = new.job_id;
    if found then
      perform public.enqueue_feedback(new.user_id, 'job_dismissed', 'jobs', new.job_id,
        j.trace_id, j.observation_id, j.traced_at, new.reason);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.feedback_from_role_reaction() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.role_reactions') is null then
    raise notice 'role_reactions does not exist yet: job_dismissed feedback is not attached. Re-run this migration after the scoring migrations.';
    return;
  end if;
  drop trigger if exists feedback_role_reactions on public.role_reactions;
  create trigger feedback_role_reactions
    after insert or update of reaction on public.role_reactions
    for each row execute function public.feedback_from_role_reaction();
end
$$;

notify pgrst, 'reload schema';

do $$
begin
  if to_regprocedure('public.feedback_from_role_reaction()') is null then
    raise exception 'feedback_from_role_reaction is missing';
  end if;
  if has_function_privilege('anon', 'public.feedback_from_role_reaction()', 'execute')
     or has_function_privilege('authenticated', 'public.feedback_from_role_reaction()', 'execute') then
    raise exception 'feedback_from_role_reaction must not be executable by anon or authenticated';
  end if;
end
$$;
