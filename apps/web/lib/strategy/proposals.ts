// Strategy analytics — turn 'answered' findings into proposed CHANGES.
//
// PROPOSALS ARE NEVER AUTO-APPLIED. This file only ever BUILDS
// StrategyProposal objects (status: 'proposed') and returns them in the
// report for a UI to render as approve/dismiss cards. Nothing here writes to
// profiles.preferences.targeting, resume_documents, or any other table —
// turning a proposal into an actual change stays a separate, human-gated
// step, exactly like lib/contacts/sources.ts never sends outreach and
// lib/harness/agents/cv_tailor never submits an application. A proposal is
// only ever generated from a question that reached 'answered' — an
// insufficient_data question never produces one, so this module cannot
// recommend a strategy change on the strength of n=1 either.

import type { StrategyProposal, StrategyReport } from './types'
import { pct } from './bucket'

let counter = 0
function proposalId(question: string): string {
  counter += 1
  return `${question}-${counter}`
}

export function buildProposals(report: Pick<StrategyReport, 'sourceFunnel' | 'matchScoreAccuracy' | 'resumeVariants' | 'outreachImpact' | 'rejectionPatterns' | 'applicationTiming' | 'recurringEvidence'>): StrategyProposal[] {
  const proposals: StrategyProposal[] = []

  const { sourceFunnel, matchScoreAccuracy, resumeVariants, outreachImpact, rejectionPatterns, applicationTiming, recurringEvidence } = report

  if (sourceFunnel.status === 'answered') {
    const comparable = sourceFunnel.data.buckets.filter((b) => !b.thinBucket)
    const best = [...comparable].sort((a, b) => (b.interviewRate ?? 0) - (a.interviewRate ?? 0))[0]
    const worst = [...comparable].sort((a, b) => (a.interviewRate ?? 0) - (b.interviewRate ?? 0))[0]
    if (best && worst && best.label !== worst.label && (best.interviewRate ?? 0) > (worst.interviewRate ?? 0)) {
      proposals.push({
        id: proposalId('sourceFunnel'),
        title: `Prioritize opportunities sourced from ${best.label}.`,
        change: `Weight discovery/scoring toward jobs ingested via ${best.label} over ${worst.label}.`,
        why: `${best.label} applications reach interview at ${pct(best.interviewRate)} vs ${pct(worst.interviewRate)} for ${worst.label}.`,
        evidence: [{ question: sourceFunnel.question, sampleSize: sourceFunnel.sampleSize, summary: sourceFunnel.summary }],
        expectedEffect: 'May raise the overall interview rate by shifting effort toward the channel that is already converting better — not a guarantee, and the gap could narrow with more data.',
        status: 'proposed',
      })
    }
  }

  if (matchScoreAccuracy.status === 'answered' && matchScoreAccuracy.data.verdict === 'refutes') {
    proposals.push({
      id: proposalId('matchScoreAccuracy'),
      title: 'Review the match-scoring rubric.',
      change: 'Re-examine what the matcher rewards — the current scores are not separating repliers from non-repliers.',
      why: matchScoreAccuracy.summary,
      evidence: [{ question: matchScoreAccuracy.question, sampleSize: matchScoreAccuracy.sampleSize, summary: matchScoreAccuracy.summary }],
      expectedEffect: 'A rubric that actually predicts replies would let a minimum-score filter cut low-value applications without losing real opportunities. No effect estimate — this only says the current rubric is not doing that yet.',
      status: 'proposed',
    })
  }

  if (matchScoreAccuracy.status === 'answered' && matchScoreAccuracy.data.verdict === 'validates') {
    const bands = matchScoreAccuracy.data.bands.filter((b) => !b.thinBucket).sort((a, b) => a.min - b.min)
    const cutoff = bands.length > 1 ? bands[1].min : undefined
    if (cutoff !== undefined) {
      proposals.push({
        id: proposalId('matchScoreAccuracy'),
        title: `Consider a minimum match score around ${cutoff}.`,
        change: `Set targeting to only surface jobs scored ${cutoff} or higher.`,
        why: matchScoreAccuracy.summary,
        evidence: [{ question: matchScoreAccuracy.question, sampleSize: matchScoreAccuracy.sampleSize, summary: matchScoreAccuracy.summary }],
        expectedEffect: 'May raise the average reply rate per application sent, at the cost of surfacing fewer opportunities overall.',
        status: 'proposed',
      })
    }
  }

  if (resumeVariants.status === 'answered') {
    const tailored = resumeVariants.data.buckets.find((b) => b.label === 'tailored resume on file')
    const untailored = resumeVariants.data.buckets.find((b) => b.label === 'no tailored resume on file')
    if (tailored && untailored && !tailored.thinBucket && !untailored.thinBucket && (tailored.replyRate ?? 0) > (untailored.replyRate ?? 0)) {
      proposals.push({
        id: proposalId('resumeVariants'),
        title: 'Always tailor the resume before applying.',
        change: 'Require a job-specific tailored resume (lib/harness/agents/cv_tailor output) for every application instead of falling back to the base resume.',
        why: resumeVariants.summary,
        evidence: [{ question: resumeVariants.question, sampleSize: resumeVariants.sampleSize, summary: resumeVariants.summary }],
        expectedEffect: 'May raise reply rate based on the observed gap; the gap could narrow as more applications are tailored across more role types.',
        status: 'proposed',
      })
    }
  }

  if (outreachImpact.status === 'answered') {
    const withB = outreachImpact.data.buckets.find((b) => b.label === 'had outreach sent')
    const withoutB = outreachImpact.data.buckets.find((b) => b.label === 'no outreach sent')
    if (withB && withoutB && !withB.thinBucket && !withoutB.thinBucket && (withB.replyRate ?? 0) > (withoutB.replyRate ?? 0)) {
      proposals.push({
        id: proposalId('outreachImpact'),
        title: 'Send outreach alongside every application.',
        change: 'Default the outreach step to on for future applications instead of leaving it optional.',
        why: outreachImpact.summary,
        evidence: [{ question: outreachImpact.question, sampleSize: outreachImpact.sampleSize, summary: outreachImpact.summary }],
        expectedEffect: 'May raise reply rate; correlational, not proven causal — see this question\'s caveat.',
        status: 'proposed',
      })
    }
  }

  if (rejectionPatterns.status === 'answered') {
    const worst = rejectionPatterns.data.groups[0]
    if (worst && worst.rejectionRate >= 0.8) {
      proposals.push({
        id: proposalId('rejectionPatterns'),
        title: worst.kind === 'company' ? `Consider excluding ${worst.key} from targeting.` : `Reassess targeting the ${worst.key} role family.`,
        change:
          worst.kind === 'company'
            ? `Add "${worst.key}" to profiles.preferences.targeting.excludedCompanies.`
            : `Remove "${worst.key}" from profiles.preferences.targeting.functions, or lower expectations for that family.`,
        why: rejectionPatterns.summary,
        evidence: [{ question: rejectionPatterns.question, sampleSize: rejectionPatterns.sampleSize, summary: rejectionPatterns.summary }],
        expectedEffect: 'May reduce time spent on applications unlikely to convert, based on the observed rejection rate so far.',
        status: 'proposed',
      })
    }
  }

  if (applicationTiming.status === 'answered') {
    const ordered = applicationTiming.data.buckets.filter((b) => !b.thinBucket).sort((a, b) => a.minDays - b.minDays)
    const fastest = ordered[0]
    const slowest = ordered[ordered.length - 1]
    if (fastest && slowest && fastest.label !== slowest.label && (fastest.replyRate ?? 0) > (slowest.replyRate ?? 0)) {
      proposals.push({
        id: proposalId('applicationTiming'),
        title: `Apply within "${fastest.label}" of a posting when possible.`,
        change: 'Prioritize freshly-posted roles in the queue Cello surfaces for same-day/early action.',
        why: applicationTiming.summary,
        evidence: [{ question: applicationTiming.question, sampleSize: applicationTiming.sampleSize, summary: applicationTiming.summary }],
        expectedEffect: 'May raise reply rate for time-sensitive roles; does not account for why some applications happened later (e.g. more research, tailoring time).',
        status: 'proposed',
      })
    }
  }

  if (recurringEvidence.status === 'answered' && recurringEvidence.data.phrases.length > 0) {
    const top = recurringEvidence.data.phrases[0]
    proposals.push({
      id: proposalId('recurringEvidence'),
      title: 'Emphasize this recurring accomplishment in future tailoring.',
      change: `Keep "${top.phrase}" (or the accomplishment it describes) prominent when cv_tailor generates future resume versions.`,
      why: `This line appears in ${top.occurrences} of ${recurringEvidence.data.totalSuccessfulApplications} successful applications' resumes.`,
      evidence: [{ question: recurringEvidence.question, sampleSize: recurringEvidence.sampleSize, summary: recurringEvidence.summary }],
      expectedEffect: 'Correlational — this phrase appearing in successful applications does not prove it caused the success.',
      status: 'proposed',
    })
  }

  return proposals
}
