-- K5b follow-up: a person cannot rewrite a role they do not alone hold.
--
-- After the fold a role is one row shared by every follower, and jobs.company_id is the company of whoever
-- stored it first. "Users can update jobs for own companies" let that first follower change the title or the
-- apply link every other holder reads. A role linked to an employer (employer_id set) is written through the
-- service role and the security definer upsert_shared_jobs only; the own-company update stays for a role with
-- no employer, which nobody else can hold.
--
-- The insert policy stays: a new row is no one else's, and a second copy of a posting is refused by the unique
-- (employer_id, posting_key) index rather than overwritten. Gmail placeholders insert through it.

drop policy if exists "Users can update jobs for own companies" on public.jobs;
create policy "Users can update jobs for own companies"
  on public.jobs for update to authenticated
  using (
    jobs.employer_id is null
    and exists (select 1 from public.companies where companies.id = jobs.company_id and companies.user_id = (select auth.uid()))
  )
  with check (
    jobs.employer_id is null
    and exists (select 1 from public.companies where companies.id = jobs.company_id and companies.user_id = (select auth.uid()))
  );
