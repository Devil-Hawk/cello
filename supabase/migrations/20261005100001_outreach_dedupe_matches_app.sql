-- Outreach: make the database's dedupe rule the same rule the app enforces,
-- and record whether a draft was written by a model.
--
-- 1. The unique index on (user, contact, job) for initial messages had no
--    status predicate, but the app's duplicate check (findDuplicateInitial)
--    only counts pending_review / approved / sent. A draft the user dismissed
--    ('skipped') passed the app check, the model call was paid for, and then
--    the insert died on the index with a raw 500. The index now covers the
--    same four statuses the app counts (failed is included because a failed
--    message can be retried, and the retry must never find its slot taken).
--    The new predicate is narrower than the old one, so every existing row
--    that satisfied the old index satisfies this one.
--
-- 2. used_llm is false when the text is the deterministic template the drafter
--    falls back to (no key, budget cap, model error), so the card can say so.
--    NULL on rows written before this column existed.

drop index if exists public.uniq_outreach_initial_contact_job;

create unique index if not exists uniq_outreach_initial_contact_job
    on public.outreach_messages (user_id, contact_id, job_id)
    where kind = 'initial'
      and contact_id is not null
      and job_id is not null
      and status in ('pending_review', 'approved', 'sent', 'failed');

alter table public.outreach_messages
    add column if not exists used_llm boolean;
