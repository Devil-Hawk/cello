-- K5b follow-up: a company's employer, and the board its roles come from, are the directory's, never the person's.
--
-- A role is shared only when the employer's own verified source wrote it. Every input the person controls
-- (companies.employer_id, domain, career_url, metadata.ats) used to pick the employer or the board of a shared
-- read, so a person could point their company at another employer, or at a board of their own, and have the
-- service-role refresh write that board's roles into rows every follower reads.
--
--   1. companies_link_employer always derives the employer from the verified directory row (a board employer by
--      domain or by its verified board; a board-less one by its careers address) and ignores the value sent. A
--      linked company's board pointer is forced to the directory's, a board-less employer's pointer is removed.
--      Every linked company is derived again now.
--   2. A role gets an employer from its company only when the employer's board wrote it (its source is the
--      board's provider). Mail placeholders, aggregator and site rows stay the person's own.
--   3. Adopting a person's own row into the shared one starts from the read: every column a person could have
--      planted is reset.
--   4. Placeholders a database that already folded shared are unshared again (idempotent).

create or replace function public.companies_link_employer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.metadata, '{}'::jsonb);
  e_id uuid;
  e_provider text;
  e_token text;
  e_by text;
begin
  select d.id, d.ats_provider, d.ats_token, d.verified_by into e_id, e_provider, e_token, e_by
    from public.company_directory d
   where d.verified_at is not null
     and ((d.ats_provider is not null
           and ((nullif(btrim(new.domain), '') is not null and d.domain = lower(btrim(new.domain)))
             or (d.ats_provider = meta -> 'ats' ->> 'provider' and d.ats_token = meta -> 'ats' ->> 'token')))
       or (d.ats_provider is null and nullif(btrim(new.career_url), '') is not null and d.careers_url = new.career_url))
   order by (d.ats_token is not null and d.ats_token = meta -> 'ats' ->> 'token') desc
   limit 1;

  new.employer_id := e_id;
  if e_id is not null then
    if e_provider is not null then
      new.metadata := meta || jsonb_build_object('ats',
        case when jsonb_typeof(meta -> 'ats') = 'object' then meta -> 'ats' else '{}'::jsonb end
        || jsonb_build_object('provider', e_provider, 'token', e_token, 'verified_by', coalesce(e_by, 'manual'), 'source', 'known'));
    else
      new.metadata := meta - 'ats';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists companies_link_employer on public.companies;
create trigger companies_link_employer
  before insert or update of domain, metadata, career_url, employer_id on public.companies
  for each row execute function public.companies_link_employer();
revoke all on function public.companies_link_employer() from public, anon, authenticated;

-- every linked company is derived again (a column trigger fires for a column in the SET list)
update public.companies set employer_id = employer_id where employer_id is not null;

create or replace function public.jobs_set_employer_posting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.posting_key is null then
    new.posting_key := coalesce(nullif(new.external_id, ''), md5(new.url));
  end if;
  -- Only a row the employer's own board wrote is shared; a site employer's rows are shared by the service role
  -- through upsert_shared_jobs, which sets the employer itself.
  if new.employer_id is null and new.company_id is not null then
    select c.employer_id into new.employer_id
      from public.companies c
      join public.company_directory d on d.id = c.employer_id
     where c.id = new.company_id and d.ats_provider is not null and d.ats_provider = new.source;
  end if;
  return new;
end;
$$;

create or replace function public.jobs_clear_on_adopt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.apply_url := null;
  new.description_md := null;
  new.description_md5 := null;
  new.description_state := null;
  new.description_source := null;
  new.role_type := null;
  new.type_origin := null;
  new.type_prov := null;
  new.discovered_at := now();
  new.still_open := true;
  new.closed_at := null;
  new.missed_checks := 0;
  new.last_verified_at := null;
  new.legit_label := null;
  new.match_score := null;
  new.match_details := null;
  return new;
end;
$$;

-- a database that already folded: mail placeholders are the person's own again, and only the owner holds one
update public.jobs set employer_id = null where source in ('gmail_sync', 'gmail_share') and employer_id is not null;
delete from public.person_roles pr
 using public.jobs j
 where j.id = pr.job_id and j.employer_id is null and j.company_id is not null and pr.saved_at is null
   and not exists (select 1 from public.companies c where c.id = j.company_id and c.user_id = pr.user_id);
