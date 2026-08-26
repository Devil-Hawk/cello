// Plan-act-verify for matcher (langgraph port design doc, Step 4, item 3):
// a DETERMINISTIC postcondition on EVERY match verdict (score range,
// schema-complete, the free fabricated-evidence detector), plus a judge
// (ClosedQA rubric) on a SAMPLE — every score crossing the action/auto-
// triage threshold, plus a deterministic 10% of the rest. Failed
// verification marks the eval_verdicts row 'fail'/'unverified' — the SCORE
// STANDS (behavioral labels are the real ground truth, per the spec); it is
// lib/graph/autopilot.ts#loadCandidateJobs that reads these verdicts back to
// keep a known-bad score out of autopilot's action selection (see that
// file's own comment on the query this wires into).

import { evidenceInJobText } from '../../security/job-text'
import type { LlmVerdict } from '../../harness/agents/matcher'

export interface MatchVerdictCheck {
  ok: boolean
  reasons: string[]
}

/** score/skillsMatch/experienceMatch/locationMatch must all be 0-100; summary
 *  and seniorityFit must be non-empty (schema-complete); every gaps/
 *  missingSkills entry must whole-word-substring-match the framed job text
 *  the model was actually shown — the free fabricated-evidence detector. */
export function checkMatchVerdictDeterministic(verdict: LlmVerdict, framedJobText: string): MatchVerdictCheck {
  const reasons: string[] = []

  const pctFields: [string, number][] = [
    ['score', verdict.score],
    ['skillsMatch', verdict.skillsMatch],
    ['experienceMatch', verdict.experienceMatch],
    ['locationMatch', verdict.locationMatch],
  ]
  for (const [name, value] of pctFields) {
    if (!Number.isFinite(value) || value < 0 || value > 100) reasons.push(`${name} out of range: ${value}`)
  }

  if (!verdict.summary.trim()) reasons.push('missing summary')
  if (!verdict.seniorityFit.trim()) reasons.push('missing seniorityFit')

  for (const claim of [...verdict.gaps, ...verdict.missingSkills]) {
    if (!evidenceInJobText(framedJobText, claim)) {
      reasons.push(`unsupported evidence — not found in the job text: "${claim}"`)
    }
  }

  return { ok: reasons.length === 0, reasons }
}

/**
 * ponytail: FNV-1a over jobId, not Math.random — REPLAY DETERMINISM. Two
 * verify passes over the same job (a re-run, a resumed tick) must sample the
 * SAME jobs into the judge or a flaky-looking verdict history is the result.
 * Threshold at 0.10 of the 32-bit hash space approximates a uniform 10% —
 * good enough for a sampling rate, not a security boundary. Tighten only if
 * an actual skew shows up against real traffic.
 */
export function shouldSampleForJudge(jobId: string, sampleRate = 0.1): boolean {
  let hash = 0x811c9dc5
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const unit = (hash >>> 0) / 0xffffffff
  return unit < sampleRate
}

/** A verdict enters the judge sample when it crosses the action/auto-triage
 *  threshold (every consequential score gets a second look) OR lands in the
 *  deterministic 10% sample of the rest. */
export function needsJudgeSample(verdict: LlmVerdict, jobId: string, actionThreshold: number): boolean {
  return verdict.score >= actionThreshold || shouldSampleForJudge(jobId)
}
