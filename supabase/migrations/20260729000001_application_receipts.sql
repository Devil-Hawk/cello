-- Application receipts: the record of "this application was actually
-- submitted" that any of Cello's THREE producers can write — a user typing
-- "I already applied" by hand, Cello's own official-ATS submit path
-- (lib/ats-apply), or a future browser companion — carrying enough to answer
-- "what happened, where, with what documents, and how do we know" without
-- ever requiring Gmail. See apps/web/lib/applications/types.ts for the TS
-- mirror of this table and apps/web/lib/applications/receipts.ts for the
-- read/write contract.
--
-- WHY A NEW TABLE, NOT `activities`
-- lib/strategy/bucket.ts's repliedApplicationIds() treats "this application
-- has ANY activities row" as "the employer replied" (see that file's own
-- doc comment: "a row is written ONLY when Gmail sync classifies an INBOUND
-- email ... there is no other writer of activities"). Writing a
-- self-reported submission event into `activities` would silently corrupt
-- every strategy reply-rate computation — a user's own "I applied" action
-- would misread as an employer response. Receipts describe an OUTBOUND
-- submission (asserted by the applicant, or witnessed by Cello), which is
-- categorically different from `activities`' INBOUND-reply semantics, so
-- they get their own table rather than overloading that one.
--
-- PROVENANCE VS VERIFICATION STATE (same separation as
-- 20260728000007_contact_provenance.sql's source/verified split, and
-- 20260728000008_job_provenance.sql's last_verified_at/still_open split)
--   provenance         — WHO produced this row: manual | ats_direct |
--                         browser_companion. Vocabulary lives in TS, not a
--                         CHECK constraint, so a future producer (the
--                         browser companion this migration deliberately
--                         leaves room for) ships without a migration.
--   verification_state — HOW MUCH Cello independently witnessed, not just
--                         who typed it in: user_confirmed (the applicant
--                         asserts it — the ONLY value the public
--                         manual-entry API is allowed to write) vs
--                         system_confirmed (Cello's own code executed the
--                         submission and observed a positive result, e.g.
--                         lib/ats-apply getting a real submissionRef back).
--                         A user must be able to tell what Cello witnessed
--                         from what they themselves asserted — collapsing
--                         these two into one column would lose that.
--
-- Additive, matching this repo's migration convention: `create table if not
-- exists`, RLS mirrors outreach_messages' full-CRUD-by-owner shape.

create table if not exists public.application_receipts (
    id uuid default uuid_generate_v4() primary key,
    application_id uuid references public.applications(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    provenance text not null default 'manual',
    verification_state text not null default 'user_confirmed',
    submitted_at timestamptz not null,
    destination text,
    documents jsonb not null default '[]',
    confirmation_identifier text,
    confirmation_note text,
    confirmation_attachment_url text,
    source_detail jsonb,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

comment on table public.application_receipts is
  'One row per witnessed-or-asserted "this application was submitted" event. An application may have zero (never logged), one, or several receipts (e.g. a manual entry later corroborated by a browser-companion capture) — this is intentionally append-friendly, not a single mutable fact on `applications`.';
comment on column public.application_receipts.provenance is
  'Which of the three producers wrote this receipt: manual (the applicant typed it in) | ats_direct (lib/ats-apply submitted through an official ATS API) | browser_companion (a future companion witnessed the submission). Vocabulary lives in TS (lib/applications/types.ts ReceiptProvenance), not a CHECK, so a new producer ships without a migration.';
comment on column public.application_receipts.verification_state is
  'How much Cello independently witnessed: user_confirmed (the applicant asserts it — the ONLY value the public manual-entry API may write) | system_confirmed (Cello''s own code performed/observed the submission directly) | unconfirmed (reserved for a future partial signal, e.g. a companion that saw a click but not a success page). Never conflate an assertion with a confirmation.';
comment on column public.application_receipts.destination is
  'Where the application went, in the applicant''s own words or a short preset (company site, LinkedIn, referral, recruiter, job board, ATS name...). Free text by design — see the "seconds, not CRM data entry" constraint in lib/applications/receipts.ts.';
comment on column public.application_receipts.documents is
  'ReceiptDocument[] — which resume/cover-letter/other document was used, with a resume_documents.id pointer when it is one of Cello''s own tracked versions. See lib/applications/types.ts.';
comment on column public.application_receipts.confirmation_attachment_url is
  'Optional screenshot/confirmation image. Today this holds a size-capped data: URL written directly by the upload form; a future move to real object storage can populate the SAME column with an https: URL — no migration, no read-side change.';
comment on column public.application_receipts.source_detail is
  'Provenance-specific extra detail Cello does not need to query on — e.g. {"atsProvider":"greenhouse","submissionRef":"..."} for ats_direct, or a future browser_companion''s captured page URL/selector. Always optional; a manual receipt typically leaves this null.';

create index if not exists idx_application_receipts_application
  on public.application_receipts (application_id, submitted_at desc);
create index if not exists idx_application_receipts_user
  on public.application_receipts (user_id, created_at desc);

alter table public.application_receipts enable row level security;

create policy "own receipts select" on public.application_receipts for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "own receipts insert" on public.application_receipts for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "own receipts update" on public.application_receipts for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own receipts delete" on public.application_receipts for delete to authenticated
    using ((select auth.uid()) = user_id);

notify pgrst, 'reload schema';
