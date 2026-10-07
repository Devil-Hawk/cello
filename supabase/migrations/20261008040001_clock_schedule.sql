-- K4 clock, part 2 (post-deploy): start the minute sweeper.
--
-- Apply only after the deploy answers on /api/agent/continue and the two Vault rows are set
-- (agent_continue_url, agent_continue_secret). Until this runs nothing in 20261008040000 fires,
-- and background_ready() is false.

create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'cello-agent-sweep') then
    perform cron.schedule('cello-agent-sweep', '* * * * *', 'select public.agent_sweep()');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'cello-agent-sweep') then
    raise exception 'the sweeper job is not scheduled';
  end if;
end
$$;
