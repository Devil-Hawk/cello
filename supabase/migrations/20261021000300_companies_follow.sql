-- companies/follow: "Not this company". A person's report that an employer's board is not the employer's own.
--
-- The report is the person's input and is kept (one row per report). The route that takes it unfollows the employer
-- and clears company_directory.verified_at so the next sweep proves the board again (lib/companies/follow.ts).
-- A person can read their own reports; every write is the service role's.
--
-- Browser writes on public.companies are NOT revoked here and companies_derive_watching stays. Checked with
--   grep -rn "from('companies')" apps/web/app apps/web/components
-- which still shows browser writes outside what this PR removes:
--   apps/web/app/(app)/companies/page.tsx:222        .update({ is_dream_company })   (client component)
--   apps/web/app/(app)/companies/page.tsx:242        .delete()                       (client component)
--   apps/web/app/(app)/companies/[id]/page.tsx:130   .update({ is_dream_company })   (client component)
-- The revoke waits until those pages are rebuilt on the contract.

create table if not exists public.employer_reports (
  user_id uuid not null references public.profiles (id) on delete cascade,
  employer_id uuid not null references public.company_directory (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, employer_id, created_at)
);

alter table public.employer_reports enable row level security;
revoke all on public.employer_reports from public, anon, authenticated;
grant select on public.employer_reports to authenticated;
grant all on public.employer_reports to service_role;

drop policy if exists employer_reports_select_own on public.employer_reports;
create policy employer_reports_select_own on public.employer_reports for select to authenticated using (user_id = (select auth.uid()));

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employer_reports' and policyname = 'employer_reports_select_own') then
    raise exception 'employer_reports needs its select-own policy';
  end if;
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'employer_reports' and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type <> 'SELECT'))) then
    raise exception 'employer_reports must be read-only for a person';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'companies_derive_watching' and tgrelid = 'public.companies'::regclass) then
    raise exception 'companies_derive_watching must stay until the browser writes on companies are gone';
  end if;
end $$;

notify pgrst, 'reload schema';
