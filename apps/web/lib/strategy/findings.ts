// What is working and what is not (blueprint 4.8), by code over the strategy report. Each finding is a count
// ("5 of 9 applications from Referral got a reply"), the change Cello proposes when there is one, and where Keep
// would act. A rate below its threshold is never stated: a question that has not reached it says so in its own
// words. Findings read trusted events only: that is the data source's rule (lib/strategy/datasource.ts).
// Covered: source, resume version, when you applied, outreach, chance, company, role type, level (counted as
// replies or rejections per group), then reply time, stalls, why applications closed and follow-ups (./shape.ts).

import { outcomeCounts } from '@/lib/learning/effects'
import type { LearningEffect } from '@/lib/learning/types'
import { pct } from './bucket'
import type { Shape } from './shape'
import type { QuestionResult, StrategyProposal, StrategyReport } from './types'

export type Dimension = 'source' | 'resume version' | 'when you applied' | 'outreach' | 'chance' | 'company' | 'role type' | 'level' | 'reply time' | 'stalls' | 'closed' | 'follow-ups'

export interface Finding {
  key: string
  dimension: Dimension
  /** "5 of 9 applications from Referral got a reply" */
  line: string
  applications: number
  replies: number
  /** The change Keep makes, in words, or null when the finding is a fact with nothing to keep. */
  change: string | null
  /** Where the kept change acts, in words. */
  acts: string | null
  /** The strategy proposal that came with it, when the report carries one. */
  proposal: { id: string; question: string; title: string; change: string } | null
  /** What Keep stores: the effect and the counted group, chosen here by code. Null when there is nothing to keep. */
  keep: { effect: LearningEffect; params: Record<string, string | number> } | null
}

export interface Findings {
  working: Finding[]
  notWorking: Finding[]
  /** Proposals the report made that no counted group carries ("Review how Cello checks your chances."): each with its own Keep. */
  noticed: Finding[]
  /** The sentences of questions below their threshold ("Reply rates by role type appear from 15 applications."). */
  thresholds: string[]
}

/** What a kept finding changes. Only these four effects are ever kept from a finding. */
export const KEEP: Record<string, { effect: LearningEffect; acts: string; change: (group: string) => string }> = {
  sourceFunnel: { effect: 'rank.fresh', acts: 'Which roles come first in Roles.', change: (g) => `Show roles from ${g} first` },
  applicationTiming: { effect: 'rank.fresh', acts: 'Which roles come first in Roles.', change: () => 'Show newer roles first' },
  resumeVariants: { effect: 'resume.version', acts: 'Which resume Cello suggests for a role.', change: (g) => `Use the ${g} resume first` },
  outreachImpact: { effect: 'prepare.order', acts: 'What Cello prepares first.', change: () => 'Prepare roles where you can write to someone first' },
}

const BUCKET_QUESTIONS = ['sourceFunnel', 'resumeVariants', 'applicationTiming', 'outreachImpact'] as const
const DIMENSION: Record<(typeof BUCKET_QUESTIONS)[number], Dimension> = { sourceFunnel: 'source', resumeVariants: 'resume version', applicationTiming: 'when you applied', outreachImpact: 'outreach' }
const REJECTION_DIMENSION: Record<string, Dimension> = { company: 'company', job_function: 'role type', seniority: 'level' }
const CHANCE_WORD: Record<string, string> = { strong: 'Strong', possible: 'Possible', stretch: 'Stretch' }

type Buckets = { buckets: { label: string; applications: number; replies: number; thinBucket: boolean }[] }

/** A question that contributes nothing: outcomeCounts reads only answered ones. */
const emptyFor = (result: QuestionResult<unknown>): QuestionResult<never> => ({ status: 'insufficient_data', question: result.question, sampleSize: 0, minRequired: 0, message: '' }) as QuestionResult<never>

export function findingsFrom(report: StrategyReport, shape?: Shape): Findings {
  const out: Findings = { working: [], notWorking: [], noticed: [], thresholds: [] }
  const proposals = report.proposals ?? []
  const placed = new Set<string>()

  for (const q of BUCKET_QUESTIONS) {
    const result = report[q] as QuestionResult<Buckets>
    if (result.status === 'insufficient_data') {
      out.thresholds.push(result.message)
      continue
    }
    const total = result.data.buckets.reduce((s, b) => s + b.applications, 0)
    const replies = result.data.buckets.reduce((s, b) => s + b.replies, 0)
    if (total === 0) continue
    const overall = replies / total
    // outcomeCounts reads one question at a time here, so each finding is judged against its own question's rate
    const only = { ...report, sourceFunnel: emptyFor(report.sourceFunnel), resumeVariants: emptyFor(report.resumeVariants), applicationTiming: emptyFor(report.applicationTiming), outreachImpact: emptyFor(report.outreachImpact), rejectionPatterns: emptyFor(report.rejectionPatterns), [q]: result } as unknown as StrategyReport
    for (const c of outcomeCounts(only)) {
      const apps = Number(c.params.applications)
      const reps = Number(c.params.replies)
      const group = String(c.params.group)
      const proposal = proposals.find((p: StrategyProposal) => p.evidence.some((e) => e.question === result.question) && p.title.includes(group)) ?? null
      if (proposal) placed.add(proposal.id)
      const finding: Finding = {
        key: c.key,
        dimension: DIMENSION[q],
        line: `${c.statement}.`,
        applications: apps,
        replies: reps,
        change: proposal?.change ?? KEEP[q].change(group),
        acts: KEEP[q].acts,
        proposal: proposal ? { id: proposal.id, question: proposal.evidence[0].question, title: proposal.title, change: proposal.change } : null,
        keep: { effect: KEEP[q].effect, params: c.params },
      }
      // a bucket that replies at or above the overall rate is working; one below it is not, and has nothing to keep
      if (reps / apps >= overall && reps > 0) out.working.push(finding)
      else out.notWorking.push({ ...finding, change: proposal?.change ?? null, acts: proposal ? KEEP[q].acts : null, keep: proposal ? finding.keep : null })
    }
  }

  // chance: do Strong roles get replies more often than Stretch ones
  const chance = report.chanceAccuracy
  if (chance.status === 'insufficient_data') out.thresholds.push(chance.message)
  else {
    const rows = chance.data.buckets.filter((b) => !b.thinBucket)
    const overall = rows.reduce((s, b) => s + b.replies, 0) / Math.max(1, rows.reduce((s, b) => s + b.applications, 0))
    for (const b of rows) {
      const f: Finding = { key: `chance:${b.chance}`, dimension: 'chance', line: `${b.replies} of ${b.applications} applications on ${CHANCE_WORD[b.chance]} roles got a reply (${pct(b.replyRate)}).`, applications: b.applications, replies: b.replies, change: null, acts: null, proposal: null, keep: null }
      ;(b.replies / b.applications >= overall && b.replies > 0 ? out.working : out.notWorking).push(f)
    }
  }

  // rejections by company, role type and level
  const rejections = report.rejectionPatterns
  if (rejections.status === 'insufficient_data') out.thresholds.push(rejections.message)
  else {
    for (const g of rejections.data.groups) {
      out.notWorking.push({ key: `rejection:${g.kind}:${g.key}`, dimension: REJECTION_DIMENSION[g.kind] ?? 'company', line: `${g.rejected} of ${g.totalApplications} applications in ${g.key} were rejected.`, applications: g.totalApplications, replies: 0, change: null, acts: null, proposal: null, keep: null })
    }
  }

  for (const p of proposals) {
    if (placed.has(p.id)) continue
    const question = p.evidence[0]?.question ?? 'report'
    out.noticed.push({
      key: `proposal:${question}:${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`,
      dimension: question === 'chanceAccuracy' ? 'chance' : question === 'recurringEvidence' ? 'resume version' : 'company',
      line: p.title,
      applications: p.evidence[0]?.sampleSize ?? 0,
      replies: 0,
      change: p.change,
      acts: 'The suggestions for your search.',
      proposal: { id: p.id, question, title: p.title, change: p.change },
      keep: { effect: 'search.propose', params: { question } },
    })
  }

  if (shape) {
    for (const [list, into] of [[shape.working, out.working], [shape.notWorking, out.notWorking]] as const) for (const s of list) into.push({ ...s, change: null, acts: null, proposal: null, keep: null })
    out.thresholds.push(...shape.thresholds)
  }
  return out
}
