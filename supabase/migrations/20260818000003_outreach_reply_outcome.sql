-- Ground-truth columns the reward loop reads back (binding ruling 4 +
-- design doc: "Ground truth wired: application_drafts.status + reviewed_at,
-- outreach reply columns written by the Gmail bridge, application_receipts,
-- stage transitions.").
--
-- OUTREACH REPLY OUTCOME (ruling 4, exactly): replied_at, reply_classification
-- (positive|neutral|negative|bounce), reply_gmail_message_id. Single writer:
-- gmail/stage.ts's bridge (not landed in this stage — this migration only
-- lands the columns it will write). All three nullable: an outreach message
-- with no reply yet, or a message sent before this migration, leaves them
-- NULL forever, same "nullable, no default, additive" shape as every prior
-- ALTER in this codebase (see phaseB's application_drafts.resume_document_id).
--
-- APPLICATION_DRAFTS.REVIEWED_AT: when a human review decision moved a draft
-- OFF pending_review (approved/rejected/submitted/failed), stamped by the
-- flip route in the same request that changes .status — see
-- app/api/drafts/approve/route.ts, app/api/drafts/reject/route.ts and
-- app/api/drafts/batch-approve/route.ts, each updated in this same commit.
-- Distinct from submitted_at (only set on an actual ATS submission) and from
-- created_at (when the draft was first generated, before any human looked at
-- it) — reviewed_at is specifically "when a person acted on this."
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

alter table public.outreach_messages
  add column if not exists replied_at timestamptz,
  add column if not exists reply_classification text
    check (reply_classification in ('positive', 'neutral', 'negative', 'bounce')),
  add column if not exists reply_gmail_message_id text;

comment on column public.outreach_messages.replied_at            is 'When an inbound reply to this outreach was detected. NULL = no reply yet. Written only by gmail/stage.ts''s bridge.';
comment on column public.outreach_messages.reply_classification  is 'positive|neutral|negative|bounce. NULL until replied_at is set.';
comment on column public.outreach_messages.reply_gmail_message_id is 'Gmail message id of the reply, for dedupe and linking back to the thread.';

create index if not exists idx_outreach_user_replied
  on public.outreach_messages (user_id, replied_at)
  where replied_at is not null;

alter table public.application_drafts
  add column if not exists reviewed_at timestamptz;

comment on column public.application_drafts.reviewed_at is 'When a human review decision moved this draft off pending_review (approve/reject/batch-approve). NULL = never reviewed. See this migration''s header.';

notify pgrst, 'reload schema';
