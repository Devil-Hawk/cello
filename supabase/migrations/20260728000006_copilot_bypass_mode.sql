-- Copilot "bypass permissions" toggle — a per-conversation flag persisted
-- alongside the other conversation-scoped overrides added in
-- 20260728000003_copilot_conversations.sql (model, enabled_agents).
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   A single `add column if not exists` with a `not null default false`. No
--   existing row's other columns are touched, no object is dropped or
--   renamed. Safe to re-run.
--
-- WHAT bypass_mode MEANS (enforced in app/api/copilot/route.ts, not SQL)
--   When true, READ and ACT tool calls (research, matching, scoring,
--   drafting, tailoring) run without the per-step review-mode pause. It never
--   weakens the SEPARATE, unconditional guard the route applies to any tool
--   call that looks like it would submit a job application or send a message
--   to a real person — those always require an explicit confirmation
--   round-trip, bypass_mode or not. This column only stores the toggle's
--   state; it grants no capability by itself.

alter table public.copilot_conversations
  add column if not exists bypass_mode boolean not null default false;

comment on column public.copilot_conversations.bypass_mode is
  'Per-conversation "bypass permissions" toggle: skips the review-mode pause for READ/ACT tool calls only. Never bypasses the server-side submit/send confirmation guard in route.ts — see that file''s systemPrompt/dispatch comments.';

-- Make the new column visible to PostgREST without waiting for its periodic
-- schema-cache refresh.
notify pgrst, 'reload schema';
