// What is working and what is not (blueprint 4.8), by code over the strategy report. Each finding is a count
// ("5 of 9 applications from Referral got a reply"), the proposal it came with when there is one, and never a
// rate below its threshold: a question that has not reached its threshold says so in the threshold's own words.
// Findings read trusted events only: that is the data source's rule (lib/strategy/datasource.ts), not this file's.

import { outcomeCounts } from '@/lib/learning/effects'
import type { QuestionResult, StrategyProposal, StrategyReport } from './types'

export interface Finding {
  key: string
  /** "5 of 9 applications from Referral got a reply" */
  line: string
  applications: number
  replies: number
  /** The change Cello proposes, and the proposal to Keep, when the report carries one. */
  proposal: { id: string; question: string; title: string; change: string } | null
}

export interface Findings {
  working: Finding[]
  notWorking: Finding[]
  /** The sentences of questions below their threshold ("Reply rates by role type appear from 15 applications."). */
  thresholds: string[]
}

const QUESTIONS: (keyof StrategyReport)[] = ['sourceFunnel', 'resumeVariants', 'applicationTiming', 'outreachImpact']

export function findingsFrom(report: StrategyReport): Findings {
  const out: Findings = { working: [], notWorking: [], thresholds: [] }
  const proposals = report.proposals ?? []
  for (const q of QUESTIONS) {
    const result = report[q] as QuestionResult<{ buckets: { label: string; applications: number; replies: number; thinBucket: boolean }[] }>
    if (result.status === 'insufficient_data') {
      out.thresholds.push(result.message)
      continue
    }
    const total = result.data.buckets.reduce((s, b) => s + b.applications, 0)
    const replies = result.data.buckets.reduce((s, b) => s + b.replies, 0)
    if (total === 0) continue
    const overall = replies / total
    const counts = outcomeCounts({ ...report, sourceFunnel: q === 'sourceFunnel' ? result : emptyFor(report.sourceFunnel), resumeVariants: q === 'resumeVariants' ? result : emptyFor(report.resumeVariants), applicationTiming: q === 'applicationTiming' ? result : emptyFor(report.applicationTiming), outreachImpact: q === 'outreachImpact' ? result : emptyFor(report.outreachImpact), rejectionPatterns: emptyFor(report.rejectionPatterns) } as unknown as StrategyReport)
    for (const c of counts) {
      const apps = Number(c.params.applications)
      const reps = Number(c.params.replies)
      const proposal = proposals.find((p: StrategyProposal) => p.evidence.some((e) => e.question === result.question && p.title.includes(String(c.params.group)))) ?? null
      const finding: Finding = {
        key: c.key,
        line: `${c.statement}.`,
        applications: apps,
        replies: reps,
        proposal: proposal ? { id: proposal.id, question: proposal.evidence[0].question, title: proposal.title, change: proposal.change } : null,
      }
      // a bucket that replies at or above the overall rate is working; one below it is not
      ;(reps / apps >= overall && reps > 0 ? out.working : out.notWorking).push(finding)
    }
  }
  return out
}

/** A question that contributes nothing: outcomeCounts reads only answered ones. */
function emptyFor(result: QuestionResult<unknown>): QuestionResult<never> {
  return { status: 'insufficient_data', question: result.question, sampleSize: 0, minRequired: 0, message: '' } as QuestionResult<never>
}
