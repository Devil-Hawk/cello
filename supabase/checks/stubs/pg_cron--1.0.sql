-- Stub of pg_cron for local checks. Records jobs in cron.job and never runs them.
create schema if not exists cron;

create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text default 'localhost',
  nodeport int default 5432,
  database text default current_database(),
  username text default current_user,
  active boolean default true,
  jobname text unique
);

create table cron.job_run_details (
  jobid bigint,
  runid bigserial primary key,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

create function cron.schedule(schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (schedule, command) values (schedule, command) returning jobid
$$;

create function cron.unschedule(job_name text) returns boolean
language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;

create function cron.unschedule(job_id bigint) returns boolean
language sql as $$
  with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d)
$$;
