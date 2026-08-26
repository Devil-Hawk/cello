-- Fix-round follow-up to 20260819000003_assisted_apply.sql, addressing two
-- review findings on apply_phase_tokens without touching that migration:
--
--   1. issuePhaseToken()'s "at most one live row per (draft, phase)" claim
--      (lib/ats-apply/phase-tokens.ts) was caller discipline only — a
--      genuine double-mint race (two /api/apply/prepare or /api/apply/
--      confirm calls whose invalidation UPDATEs both run before either
--      INSERT commits) could leave two live rows, which would then make
--      consumePhaseToken()'s `UPDATE ... WHERE consumed_at IS NULL
--      RETURNING` match more than one row — an ambiguous write, and (per
--      PostgREST's .maybeSingle()) an error surfacing as a confusing 500 on
--      a legitimate retry rather than a clean refusal. A partial unique
--      index makes the invariant true at the database, not just in
--      comments: the SECOND insert in a true race now fails loudly with a
--      constraint violation, which issuePhaseToken() already turns into a
--      thrown error its callers (prepare/confirm) already catch.
--
--   2. token_hash was, at issue time, a hash of a value never returned to
--      any caller — an audit artifact, not a bearer secret (see that
--      migration's header for why: workflow_dispatch inputs are the only
--      channel to a not-yet-running job, and GitHub logs those in plain
--      text). lib/ats-apply/phase-tokens.ts now ALSO uses this same column
--      for a second purpose, at CONSUME time rather than issue time:
--      mintReportToken() overwrites it with the hash of a fresh secret
--      that IS handed back — in the bundle response body, a channel
--      workflow_dispatch's logged inputs never touch — and
--      verifyReportToken() is what PATCH app/api/apply/state now requires
--      the runner to present back before it will record a fill/submit
--      result. No schema change needed for that part; only this comment
--      correction, since the original migration's column comment promised
--      token_hash is "never returned to any caller for this table", which
--      is no longer the whole story.
--
-- PRECONDITION: same reasoning as every migration in this family.
do $$
begin
  if to_regclass('public.apply_phase_tokens') is null then
    raise exception 'apply 20260819000003_assisted_apply.sql before this migration'
      using errcode = 'undefined_table';
  end if;
end
$$;

-- At most one UNCONSUMED row per (draft_id, phase) at any instant. Rows
-- with consumed_at set are excluded — a draft's history legitimately
-- accumulates one consumed row per completed fill/submit cycle over time
-- (a deviation sends it back for re-approval, minting a fresh submit
-- token), and only the currently-live row for a pair needs to be unique.
create unique index if not exists apply_phase_tokens_live_unique
    on public.apply_phase_tokens (draft_id, phase)
    where consumed_at is null;

comment on column public.apply_phase_tokens.token_hash is
  'SHA-256 of a value generated and hashed server-side. At ISSUE time (hashPhaseToken(), lib/ats-apply/phase-tokens.ts) this value is never returned to anyone — see 20260819000003''s header for why. At CONSUME time, app/api/apply/bundle overwrites this same column via mintReportToken() with the hash of a fresh secret that IS returned, in the bundle response body only — PATCH app/api/apply/state (verifyReportToken()) requires the runner to present it back before recording a fill/submit result.';

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'apply_phase_tokens'
      and indexname = 'apply_phase_tokens_live_unique'
  ) then
    raise exception 'apply_phase_tokens_live_unique index was not created';
  end if;
end
$$;
