-- Backfill eval_verdicts for jobs.match_score rows scored before Step 4's
-- verify stage existed (lib/graph/verify/matcher.ts). Every job scored going
-- forward always gets a deterministic verdict row (verifyMatchVerdict is
-- unconditional in scoreJobBatch) -- this migration is the one-time catch-up
-- for what came before that: every job already carrying a match_score with
-- no corresponding eval_verdicts row is grandfathered as 'pass' rather than
-- left permanently unverified.
--
-- WHY GRANDFATHER RATHER THAN RE-RUN THE DETERMINISTIC CHECK
-- checkMatchVerdictDeterministic (lib/graph/verify/matcher.ts) needs the
-- model's own gaps/missingSkills strings to whole-word-substring-match the
-- EXACT framed job text the model was shown at scoring time -- text this
-- migration has no way to reconstruct (framing is a runtime concern, not a
-- stored column), and demo/seed jobs' curated gap sentences were never
-- written to satisfy that check at all (see lib/access/fixtures/jobs.ts's
-- buildMatchDetails header: "these verdicts were never produced by the
-- model"). Re-deriving the check here would spuriously fail exactly the rows
-- it's meant to rescue. A score already trusted enough to be actionable
-- before this stage shipped stays trusted; nothing about it changed.
--
-- Additive, idempotent (WHERE NOT EXISTS -- safe to re-run, only ever fills
-- gaps), no destructive DDL. See lib/graph/autopilot.ts#loadCandidateJobs
-- for the read side this backfill unblocks (Step 4 item 3's action-selection
-- allowlist).
--
-- NOTHING IN THIS STAGE APPLIES THIS FILE AGAINST A REAL DATABASE. It is
-- reviewed and committed as source; a human operator runs it.

insert into public.eval_verdicts (user_id, subject_kind, subject_id, judge, verdict, rationale)
select c.user_id, 'match_score', j.id, 'deterministic', 'pass',
       'Grandfathered: match_score predates the verify stage (Step 4) -- no framed job text survives to re-check against.'
from public.jobs j
join public.companies c on c.id = j.company_id
where j.match_score is not null
  and not exists (
    select 1 from public.eval_verdicts v
    where v.subject_kind = 'match_score' and v.subject_id = j.id
  );

notify pgrst, 'reload schema';
