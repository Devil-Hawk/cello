// Strategy analytics — did accepting a proposal actually help?
//
// lib/strategy/proposals.ts turns an 'answered' finding into a suggestion
// ("widen your seniority range", "your filters exclude 98% of sourced jobs")
// and is explicit that nothing auto-applies it — a human accepts or dismisses.
// But once accepted, nothing in this codebase ever checked whether the change
// helped. That is a suggestion box, not a self-improving system. This module
// is the other half: record what the world looked like at acceptance time,
// then later compare it to what the world looks like now.
//
// SCOPE: this measures JOB-VOLUME proposals — the ones that change
// profiles.preferences.targeting (widen a filter, drop an excluded keyword,
// ...) — because JobScopeCounts (datasource.ts) is a metric this product can
// compute cheaply and abundantly (11k+ jobs) at any moment, unlike outcome
// data (replies, interviews), which is exactly the sparse signal thresholds.ts
// already refuses to grade early. Proposals derived from source funnel /
// resume variants / outreach / timing would need their own before/after
// OUTCOME snapshot (reply and interview rates from getApplications() +
// getActivities()) to close their loop the same way — not built here, see
// this module's caller-facing note in measure.test.ts's file header and the
// notDone list this workstream reported.
//
// PURE FUNCTIONS ONLY. No DB reads or writes live here, and no schema exists
// yet to persist an AcceptedProposalRecord — a caller assembles one by taking
// a JobScopeCounts snapshot (dataSource.getJobScopeCounts(targeting)) right
// before applying the accepted change, and later takes another snapshot to
// hand to measureProposalEffect. Persisting the record itself needs a new
// table; see this workstream's notDone for the exact shape.
//
// THE REFUSAL PATHS ARE THE POINT, same discipline as thresholds.ts and
// lib/evals/harness.ts's MIN_SAMPLE_PER_CLASS: a targeting change recomputes
// the filter's pass rate over the SAME already-scraped jobs instantly and
// mechanically the moment the config changes — that instant recompute proves
// nothing about whether the change is good, only that the arithmetic changed.
// What is actually informative is whether the pass rate holds up once the
// hourly ATS refresh has scraped a real batch of NEW jobs under the new
// targeting. So this module gates on two independent floors before it will
// render a verdict: enough WALL-CLOCK TIME for a few ingest cycles to run, and
// enough NEW jobs added to scope since acceptance that one unusual scrape
// batch can't swing the rate on its own. Below either floor, it refuses.

import type { JobScopeCounts } from './datasource'
import { insufficientData, answered, type QuestionResult } from './types'
import { NOT_ENOUGH } from './thresholds'
import { pct } from './bucket'

// --- Thresholds ---------------------------------------------------------
//
// Same pragmatic-floor spirit as thresholds.ts: not a power calculation
// (this module doesn't know the true variance of pass rate across scrape
// batches), just the point below which a single unlucky/lucky hour of
// scraping dominates the number.

/**
 * Below this many hours since acceptance, refuse to grade. Three days gives
 * the hourly ATS refresh (see the cron job it runs under) dozens of chances
 * to run before judging, rather than reacting to whatever the single next
 * scrape happened to bring in.
 */
export const MIN_OBSERVATION_WINDOW_HOURS = 72

/**
 * Below this many NEW jobs added to scope since acceptance, refuse to grade —
 * mirrors MIN_TOTAL_FOR_SOURCE_FUNNEL / MIN_TOTAL_FOR_OUTREACH_IMPACT in
 * thresholds.ts (also 20): the same floor this codebase already uses for "is
 * this enough rows to compare two groups without one flip swinging the rate".
 */
export const MIN_NEW_JOBS_SAMPLE = 20

/**
 * Below this change in pass rate (a fraction, e.g. 0.02 = 2 percentage
 * points), call it "no meaningful change" rather than a coin-flip
 * improved/regressed — a move this small is inside the noise a single day of
 * scraping produces on its own even with no targeting change at all.
 */
export const MIN_MEANINGFUL_PASS_RATE_DELTA = 0.02

// --- The accepted-proposal record ----------------------------------------

/**
 * What was accepted, when, and the world's state at that moment — the
 * "before" half of a before/after comparison.
 *
 * No table backs this today (see this file's header). The shape is designed
 * so a future caller can serialize it directly into one: `metricsBefore` is
 * already a plain JSON-able object (JobScopeCounts), and every other field is
 * a string or primitive.
 */
export interface AcceptedProposalRecord {
  /** Matches StrategyProposal.id (proposals.ts) — which specific proposal this was. */
  proposalId: string
  /** Which question produced it (StrategyProposal.evidence[].question), e.g. 'sourceFunnel'. Kept for future grouping ("do filterImpact-derived proposals land more often than sourceFunnel ones"). */
  question: string
  /**
   * StrategyProposal.title AT THE TIME IT WAS ACCEPTED, copied in rather than
   * re-derived later. Proposals are regenerated fresh on every report run and
   * carry no stable content beyond a per-process counter (see proposals.ts's
   * `counter`), so re-deriving "what did the user actually agree to" after
   * the fact is not reliable — denormalizing it here is the only way a later
   * audit shows the exact wording that was approved.
   */
  title: string
  /** ISO 8601 timestamp of acceptance. */
  acceptedAt: string
  /**
   * The metric snapshot AT acceptance time, before the change had any chance
   * to take effect. Reuses JobScopeCounts (datasource.ts) rather than a
   * parallel shape — see this file's header for why job-volume proposals are
   * this module's scope.
   */
  metricsBefore: JobScopeCounts
}

/** Build an AcceptedProposalRecord. `acceptedAt` is a required Date, not a default `new Date()`, so this stays pure and deterministic under test. */
export function recordAcceptedProposal(
  proposalId: string,
  question: string,
  title: string,
  metricsBefore: JobScopeCounts,
  acceptedAt: Date
): AcceptedProposalRecord {
  return { proposalId, question, title, acceptedAt: acceptedAt.toISOString(), metricsBefore }
}

// --- Measuring the effect --------------------------------------------------

export type ProposalEffectVerdict = 'improved' | 'no_change' | 'regressed'

export interface ProposalEffectData {
  verdict: ProposalEffectVerdict
  totalJobsBefore: number
  totalJobsAfter: number
  totalPassingBefore: number
  totalPassingAfter: number
  /** totalPassingAllConfiguredFilters / totalJobs. Null when totalJobs is 0 on that side (never divide by zero). */
  passRateBefore: number | null
  passRateAfter: number | null
  /** passRateAfter - passRateBefore. Null when either side is null. */
  passRateDelta: number | null
  /** New jobs scraped into scope since acceptance — the actual sample this verdict is judged on, not totalJobsAfter. */
  newJobsObserved: number
  /** Wall-clock hours between acceptance and this measurement. */
  hoursElapsed: number
}

// Pass rates are integer/integer (totalPassing / totalJobs), so a delta that
// lands "exactly" on the threshold (e.g. 24/200 - 10/100 = 0.02) can differ
// from 0.02 in the 16th decimal place purely from binary floating-point
// representation, not from anything the caller did. Tolerating a margin far
// below anything an integer job count could ever produce (1 job in a million)
// keeps the documented boundary behaving the way it reads, instead of being
// at the mercy of which side of representation error a given fraction falls on.
const DELTA_EPSILON = 1e-9

function verdictFromDelta(delta: number | null): ProposalEffectVerdict {
  if (delta === null) return 'no_change' // can't claim improved/regressed without a rate on both sides
  if (delta > MIN_MEANINGFUL_PASS_RATE_DELTA + DELTA_EPSILON) return 'improved'
  if (delta < -MIN_MEANINGFUL_PASS_RATE_DELTA - DELTA_EPSILON) return 'regressed'
  return 'no_change'
}

const VERDICT_LABEL: Record<ProposalEffectVerdict, string> = {
  improved: 'an improvement',
  no_change: 'no meaningful change',
  regressed: 'a regression',
}

/**
 * Compare a before-snapshot to current counts and render a verdict —
 * REFUSING (insufficient_data) below either the time window or the new-job
 * sample floor. See this file's header for why both gates exist.
 */
export function measureProposalEffect(
  record: AcceptedProposalRecord,
  metricsNow: JobScopeCounts,
  now: Date
): QuestionResult<ProposalEffectData> {
  const acceptedAtMs = new Date(record.acceptedAt).getTime()
  const hoursElapsed = (now.getTime() - acceptedAtMs) / (1000 * 60 * 60)
  // Floor, never round up — an insufficient-data sampleSize that rounds up
  // toward the threshold would overstate how close this is to answerable
  // (see InsufficientData.sampleSize's doc in types.ts).
  const flooredHours = Math.max(0, Math.floor(hoursElapsed))

  if (hoursElapsed < MIN_OBSERVATION_WINDOW_HOURS) {
    return insufficientData(
      'proposalEffect',
      flooredHours,
      MIN_OBSERVATION_WINDOW_HOURS,
      `${NOT_ENOUGH(flooredHours, MIN_OBSERVATION_WINDOW_HOURS, 'hours since "' + record.title + '" was accepted')} A targeting change recomputes the pass rate on the same already-scraped jobs instantly — that proves nothing until real ingest cycles have run under it.`
    )
  }

  const newJobsObserved = Math.max(0, metricsNow.totalJobs - record.metricsBefore.totalJobs)

  if (newJobsObserved < MIN_NEW_JOBS_SAMPLE) {
    return insufficientData(
      'proposalEffect',
      newJobsObserved,
      MIN_NEW_JOBS_SAMPLE,
      `${NOT_ENOUGH(newJobsObserved, MIN_NEW_JOBS_SAMPLE, 'new jobs scraped since "' + record.title + '" was accepted')} Judging on fewer lets one unusual scrape batch swing the rate on its own.`
    )
  }

  const passRateBefore = record.metricsBefore.totalJobs > 0 ? record.metricsBefore.totalPassingAllConfiguredFilters / record.metricsBefore.totalJobs : null
  const passRateAfter = metricsNow.totalJobs > 0 ? metricsNow.totalPassingAllConfiguredFilters / metricsNow.totalJobs : null
  const passRateDelta = passRateBefore !== null && passRateAfter !== null ? passRateAfter - passRateBefore : null
  const verdict = verdictFromDelta(passRateDelta)

  const data: ProposalEffectData = {
    verdict,
    totalJobsBefore: record.metricsBefore.totalJobs,
    totalJobsAfter: metricsNow.totalJobs,
    totalPassingBefore: record.metricsBefore.totalPassingAllConfiguredFilters,
    totalPassingAfter: metricsNow.totalPassingAllConfiguredFilters,
    passRateBefore,
    passRateAfter,
    passRateDelta,
    newJobsObserved,
    hoursElapsed,
  }

  const deltaPts = passRateDelta !== null ? Math.round(passRateDelta * 100) : null
  const deltaStr = deltaPts === null ? 'n/a' : `${deltaPts >= 0 ? '+' : ''}${deltaPts}pts`
  const summary =
    `Pass rate ${pct(passRateBefore)} → ${pct(passRateAfter)} (${deltaStr}) over ${newJobsObserved} new jobs ` +
    `and ${flooredHours}h since "${record.title}" was accepted — ${VERDICT_LABEL[verdict]}.`

  const caveats: string[] = [
    'Volume signal only: a higher pass rate means more jobs are surfaced, not that they convert to replies or interviews better — this module does not measure outcome effect (see filterImpact.ts\'s causalEvidence for why that data does not exist today).',
  ]
  if (newJobsObserved < MIN_NEW_JOBS_SAMPLE * 2) {
    caveats.push(`Still thin — ${newJobsObserved} new jobs is just over the ${MIN_NEW_JOBS_SAMPLE} minimum; expect this pass rate to keep moving as more are scraped.`)
  }

  return answered('proposalEffect', newJobsObserved, MIN_NEW_JOBS_SAMPLE, data, summary, caveats)
}
