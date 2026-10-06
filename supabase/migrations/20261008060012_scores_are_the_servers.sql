-- A match score and its details are written by the server (the match route and the two batch scorers use the admin
-- client), never by a signed-in person: a person's own row can be adopted into a shared role, and everyone who follows
-- the employer then reads what the person wrote. A signed-in session keeps what the row had (null on insert).
create or replace function public.jobs_score_is_the_servers()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    if tg_op = 'INSERT' then
      new.match_score := null;
      new.match_details := null;
    else
      new.match_score := old.match_score;
      new.match_details := old.match_details;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_score_is_the_servers on public.jobs;
create trigger jobs_score_is_the_servers
  before insert or update on public.jobs
  for each row execute function public.jobs_score_is_the_servers();
revoke all on function public.jobs_score_is_the_servers() from public, anon, authenticated;
