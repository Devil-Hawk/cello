-- Allow authenticated users to insert/update jobs for companies they own.
-- The live database only had the SELECT policy on public.jobs, so every
-- user-session write (POST /api/jobs/refresh, /api/scraper/trigger upserts,
-- /api/agents/match score updates, /api/gmail/sync job inserts) was blocked
-- by RLS. The service-role scraper is unaffected (service role bypasses RLS).
-- Idempotent: guarded by pg_policy existence checks. Applied to prod
-- 2026-07-17 via the Supabase Management API.

do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass
      and polname = 'Users can insert jobs for own companies'
  ) then
    create policy "Users can insert jobs for own companies"
      on public.jobs for insert to authenticated
      with check (
        exists (
          select 1 from public.companies
          where companies.id = jobs.company_id
            and companies.user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.jobs'::regclass
      and polname = 'Users can update jobs for own companies'
  ) then
    create policy "Users can update jobs for own companies"
      on public.jobs for update to authenticated
      using (
        exists (
          select 1 from public.companies
          where companies.id = jobs.company_id
            and companies.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.companies
          where companies.id = jobs.company_id
            and companies.user_id = auth.uid()
        )
      );
  end if;
end
$$;
